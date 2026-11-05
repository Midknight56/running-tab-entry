// Refund limits, in code. The model never sets an amount: a refund is always exactly the claimed call's price.
// Auto refunds only up to AUTO_REFUND_MAX_CENTS a claim and while refunds on that capture stay at or under
// AUTO_REFUND_SHARE_PERCENT of it; otherwise the seller clicks. Nothing ever refunds past captured minus refunded.
import type { PayPalClient } from '../paypal/client'
import { getRefund, refundCapture } from '../paypal/orders'
import { getTab, recordChainEvent, type Call, type Tab } from '../tab/ledger'
import type { Claim } from './claims'
import { reserveDuplicate } from './duplicates'

export const AUTO_REFUND_MAX_CENTS = 200
export const AUTO_REFUND_SHARE_PERCENT = 20

export type Limit = 'auto' | 'seller' | 'over'
export type RefundMode = 'auto' | 'seller'

export function refundLimit(tab: Pick<Tab, 'captured_cents' | 'refunded_cents'>, amount: number): Limit {
  // refunded_cents is the reserved total, including pending refunds, for every limit.
  if (amount <= 0 || amount > tab.captured_cents - tab.refunded_cents) return 'over'
  const within = amount <= AUTO_REFUND_MAX_CENTS && (tab.refunded_cents + amount) * 100 <= tab.captured_cents * AUTO_REFUND_SHARE_PERCENT
  return within ? 'auto' : 'seller'
}

export interface RefundResult { ok: boolean; refund_id?: string; status?: string; http?: number; name?: string }

/**
 * Sends the refund once. The claim row is locked first (state REFUNDING), so two requests for one claim make one
 * PayPal call; the request id rt-refund-{claim_id} makes a retry of that call safe too.
 */
export async function refundCall(db: D1Database, pp: Pick<PayPalClient, 'request'>, claimId: string, call: Call, tab: Tab, mode: RefundMode, signingKey?: string): Promise<RefundResult> {
  if (!tab.capture_id) return { ok: false, name: 'NOT_PAID' }
  const prior = await db.prepare('SELECT state, refund_status, reason_code FROM claims WHERE id = ?').bind(claimId).first<{ state: string; refund_status: string | null; reason_code: string | null }>()
  if (!prior || prior.refund_status === 'NOT_DUE') return { ok: false, name: 'ALREADY_HANDLED' }
  const retry = prior.state === 'REFUNDING' && ['RETRY', 'RETRY_AUTO', 'RETRY_SELLER'].includes(prior.refund_status ?? '')
  if (!retry && refundLimit(tab, call.price_cents) === 'over') return { ok: false, name: 'OVER_CAPTURE' }
  // Older approved claims have no relationship yet. Reserve it before their first refund too.
  if (!retry && prior.reason_code === 'DUPLICATE' && !await reserveDuplicate(db, claimId, call)) {
    return { ok: false, name: 'DUPLICATE_CHARGE_REQUIRED' }
  }
  // Retention blocks another duplicate refund, not an independently upheld claim on the original.
  // IN_FLIGHT excludes concurrent requests. A retry keeps its mode, reservation and PayPal request id.
  const lock = await db.prepare(`UPDATE claims SET state = 'REFUNDING', refund_status = 'IN_FLIGHT'
    WHERE id = ? AND state = ? AND refund_status IS ?
      AND (reason_code IS NOT 'DUPLICATE'
        OR NOT EXISTS (SELECT 1 FROM duplicate_reservations WHERE retained_call_id = claims.call_id))
      AND (state IN ('APPROVED', 'WAITING_SELLER') OR state = 'REFUNDING' AND refund_status IN ('RETRY', 'RETRY_AUTO', 'RETRY_SELLER'))`)
    .bind(claimId, prior.state, prior.refund_status).run()
  if (lock.meta.changes === 0) return { ok: false, name: 'ALREADY_HANDLED' }

  if (!retry) {
    // refunded_cents is reserved money, so pending refunds also consume this limit.
    const reserve = await db.prepare(`UPDATE tabs SET refunded_cents = refunded_cents + ?1
      WHERE id = ?2 AND captured_cents - refunded_cents >= ?1
        AND (?3 = 'seller' OR ((refunded_cents + ?1) * 100 <= captured_cents * ?4 AND ?1 <= ?5))`)
      .bind(call.price_cents, tab.id, mode, AUTO_REFUND_SHARE_PERCENT, AUTO_REFUND_MAX_CENTS).run()
    if (reserve.meta.changes === 0) {
      if (mode === 'auto') {
        await db.prepare("UPDATE claims SET state = 'WAITING_SELLER', refund_status = NULL WHERE id = ? AND state = 'REFUNDING'").bind(claimId).run()
        return { ok: false, name: 'WAITING_SELLER' }
      }
      await db.prepare("UPDATE claims SET state = 'APPROVED', refund_status = 'FAILED OVER_CAPTURE' WHERE id = ? AND state = 'REFUNDING'").bind(claimId).run()
      return { ok: false, name: 'OVER_CAPTURE' }
    }
  }

  let r
  try {
    r = await refundCapture(pp, tab.capture_id, call.price_cents, claimId, tab.ws_id, `Refund for call ${call.seq}`)
  } catch (error) {
    await db.prepare("UPDATE claims SET refund_status = ? WHERE id = ? AND state = 'REFUNDING'").bind(mode === 'auto' ? 'RETRY_AUTO' : 'RETRY_SELLER', claimId).run()
    throw error
  }
  const status = r.body?.status as string | undefined
  if ((r.status === 200 || r.status === 201) && r.bodyRead !== false && r.body?.id && (status === 'COMPLETED' || status === 'PENDING')) {
    await db.prepare("UPDATE claims SET refund_id = ?, refund_status = 'PENDING' WHERE id = ? AND state = 'REFUNDING' AND refund_status = 'IN_FLIGHT'")
      .bind(r.body.id, claimId).run()
    if (status === 'COMPLETED') await reconcileRefund(db, pp, claimId, signingKey, { id: r.body.id, status })
    return { ok: true, refund_id: r.body.id, status, http: r.status }
  }
  const limited = !retry && r.name === 'DEMO_REFUND_LIMIT'
  // Only a readable refusal of a first send proves no refund was made. A refusal on a
  // replay cannot disprove an earlier uncertain send. RETRY rows retain their reservation.
  const refused = !retry && !r.uncertainSend && r.bodyRead !== false && (
    (r.status === 400 && r.name === 'INVALID_REQUEST') ||
    (r.status === 401 && r.name === 'AUTHENTICATION_FAILURE') ||
    (r.status === 403 && r.name === 'NOT_AUTHORIZED') ||
    (r.status === 404 && r.name === 'RESOURCE_NOT_FOUND') ||
    (r.status === 422 && r.name === 'UNPROCESSABLE_ENTITY')
  )
  if (!limited && !refused) {
    await db.prepare("UPDATE claims SET refund_status = ? WHERE id = ? AND state = 'REFUNDING' AND refund_status = 'IN_FLIGHT'")
      .bind(mode === 'auto' ? 'RETRY_AUTO' : 'RETRY_SELLER', claimId).run()
    return { ok: false, status: 'UNCERTAIN', http: r.status, name: 'REFUND_UNCERTAIN' }
  }
  const release = db.prepare('UPDATE tabs SET refunded_cents = refunded_cents - ? WHERE id = ? AND (SELECT state FROM claims WHERE id = ?) = \'REFUNDING\' AND (SELECT refund_status FROM claims WHERE id = ?) = \'IN_FLIGHT\'').bind(call.price_cents, tab.id, claimId, claimId)
  // A first-send daily refusal sent nothing. An uncertain retry keeps its reservation above.
  const state = limited ? (mode === 'auto' ? 'WAITING_SELLER' : prior.state) : 'APPROVED'
  const refundStatus = limited ? prior.refund_status : `FAILED ${r.name ?? r.status}`
  const restore = db.prepare("UPDATE claims SET state = ?, refund_status = ? WHERE id = ? AND state = 'REFUNDING' AND refund_status = 'IN_FLIGHT'")
    .bind(state, refundStatus, claimId)
  await db.batch([release, restore])
  return { ok: false, http: r.status, name: r.name }
}

/** A verified webhook can supply the refund status; otherwise read this one refund. */
export async function reconcileRefund(db: D1Database, pp: Pick<PayPalClient, 'request'>, claimId: string, signingKey?: string, refund?: { id: string; status: string }): Promise<void> {
  const claim = await db.prepare('SELECT * FROM claims WHERE id = ?').bind(claimId).first<Claim>()
  if (!claim) return
  if (claim.state === 'REFUNDING' && ['RETRY', 'RETRY_AUTO', 'RETRY_SELLER'].includes(claim.refund_status ?? '')) {
    const call = await db.prepare('SELECT * FROM calls WHERE id = ?').bind(claim.call_id).first<Call>()
    const tab = call ? await getTab(db, call.tab_id) : null
    // Replaying the original request id reads back PayPal's current result for that request.
    if (call && tab) await refundCall(db, pp, claim.id, call, tab, claim.refund_status === 'RETRY_AUTO' ? 'auto' : 'seller', signingKey)
    return
  }
  if (!claim.refund_id) return
  const call = await db.prepare('SELECT * FROM calls WHERE id = ?').bind(claim.call_id).first<Call>()
  if (!call) return
  if (claim.state === 'REFUNDED' && claim.refund_status === 'COMPLETED') {
    await recordChainEvent(db, call.agent_id, call.seq, 'REFUND', claim.refund_id, Date.now(), signingKey)
    return
  }
  if (claim.state !== 'REFUNDING' || claim.refund_status !== 'PENDING') return
  if (!refund) {
    const r = await getRefund(pp, claim.refund_id, claim.ws_id)
    if (r.status !== 200 || r.body?.id !== claim.refund_id) return
    refund = { id: r.body.id, status: r.body.status }
  }
  if (refund.id !== claim.refund_id) return
  if (refund.status === 'COMPLETED') {
    await db.batch([
      db.prepare(`UPDATE calls SET status = 'REFUNDED' WHERE id = ? AND status = 'BILLABLE'
        AND EXISTS (SELECT 1 FROM claims WHERE id = ? AND state = 'REFUNDING' AND refund_status = 'PENDING' AND refund_id = ?)`)
        .bind(call.id, claimId, refund.id),
      db.prepare("UPDATE claims SET state = 'REFUNDED', refund_status = 'COMPLETED' WHERE id = ? AND state = 'REFUNDING' AND refund_status = 'PENDING' AND refund_id = ?")
        .bind(claimId, refund.id),
    ])
    const completed = await db.prepare("SELECT id FROM claims WHERE id = ? AND state = 'REFUNDED' AND refund_status = 'COMPLETED'").bind(claimId).first()
    if (completed) await recordChainEvent(db, call.agent_id, call.seq, 'REFUND', refund.id, Date.now(), signingKey)
  } else if (refund.status === 'FAILED' || refund.status === 'CANCELLED') {
    await db.batch([
      db.prepare(`UPDATE tabs SET refunded_cents = refunded_cents - ? WHERE id = ?
        AND EXISTS (SELECT 1 FROM claims WHERE id = ? AND state = 'REFUNDING' AND refund_status = 'PENDING' AND refund_id = ?)`)
        .bind(call.price_cents, call.tab_id, claimId, refund.id),
      db.prepare("UPDATE claims SET state = 'APPROVED', refund_status = ? WHERE id = ? AND state = 'REFUNDING' AND refund_status = 'PENDING' AND refund_id = ?")
        .bind(`FAILED ${refund.status}`, claimId, refund.id),
    ])
  }
}

/** The timestamp slot is claimed in D1 so concurrent desk reads share the same interval. */
export async function reconcileWorkspaceRefunds(db: D1Database, pp: Pick<PayPalClient, 'request'>, wsId: string, now: number, signingKey?: string): Promise<void> {
  const slot = await db.prepare(`INSERT INTO counters (key, n) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET n = excluded.n WHERE counters.n <= excluded.n - 30000`)
    .bind(`refund-poll:${wsId}`, now).run()
  if (!slot.meta.changes) return
  const claims = await db.prepare("SELECT id FROM claims WHERE ws_id = ? AND state = 'REFUNDING' AND ((refund_status = 'PENDING' AND refund_id IS NOT NULL) OR refund_status IN ('RETRY', 'RETRY_AUTO', 'RETRY_SELLER'))")
    .bind(wsId).all<{ id: string }>()
  for (const claim of claims.results) {
    await reconcileRefund(db, pp, claim.id, signingKey).catch(() => undefined)
  }
}
