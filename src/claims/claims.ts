// report_bad_answer: an agent says a call it was billed for was bad. The judge reads the claim against the log; code
// checks its verdict; a held claim on a paid call is refunded within the limits, and on an unpaid call the call is
// struck from the tab before it is billed. One claim per call.
import type { PayPalClient } from '../paypal/client'
import type { ClaimVerdict } from '../audit/checks'
import { callBySeq, callsOfTab, getTab, newId, recordChainEvent, type Agent, type Call } from '../tab/ledger'
import { refundCall, refundLimit } from './refund'
import { reserveDuplicate } from './duplicates'

export interface Claim {
  id: string; ws_id: string; call_id: string; reason_text: string; verdict: string | null; reason_code: string | null
  evidence: string | null; refund_id: string | null; refund_status: string | null
  state: 'OPEN' | 'APPROVED' | 'REJECTED' | 'WAITING_SELLER' | 'REFUNDING' | 'REFUNDED'; created_at: number
}

export interface ClaimDeps {
  db: D1Database
  pp: Pick<PayPalClient, 'request'>
  /** The claim judge; null means no usable verdict (over the cap, dropped by the checks). */
  judge: (claimText: string, claimed: Call, tabCalls: Call[]) => Promise<ClaimVerdict | null>
  now?: () => number
  signingKey?: string
}

export const MAX_CLAIM_CHARS = 500

export async function getClaim(db: D1Database, id: string): Promise<Claim | null> {
  return db.prepare('SELECT * FROM claims WHERE id = ?').bind(id).first<Claim>()
}

export async function fileClaim(d: ClaimDeps, agent: Agent, seq: number, reasonText: string): Promise<{ claim: Claim; message: string }> {
  const now = d.now ?? Date.now
  const call = await callBySeq(d.db, agent.id, seq)
  if (!call || call.agent_id !== agent.id || call.ws_id !== agent.ws_id) throw new Error(`Call ${seq} is not one of your calls.`)
  const existing = await d.db.prepare('SELECT * FROM claims WHERE call_id = ?').bind(call.id).first<Claim>()
  if (existing) return resume(d, existing, call, seq)
  if (call.status === 'STRUCK' || call.status === 'PENDING_AUDIT') {
    throw new Error(`Call ${seq} was not billed, so there is nothing to claim.`)
  }

  const id = newId('clm')
  // One claim per call (unique index): of two claims sent at once, the second finds the first.
  const ins = await d.db.prepare("INSERT OR IGNORE INTO claims (id, ws_id, call_id, reason_text, state, created_at) VALUES (?, ?, ?, ?, 'OPEN', ?)")
    .bind(id, agent.ws_id, call.id, reasonText.slice(0, MAX_CLAIM_CHARS), now()).run()
  if (ins.meta.changes === 0) {
    const first = (await d.db.prepare('SELECT * FROM claims WHERE call_id = ?').bind(call.id).first<Claim>())!
    return resume(d, first, call, seq)
  }

  const tabCalls = await callsOfTab(d.db, call.tab_id)
  const verdict = await d.judge(reasonText.slice(0, MAX_CLAIM_CHARS), call, tabCalls).catch(() => null)
  if (!verdict) {
    await setState(d.db, id, 'WAITING_SELLER', 'none')
    return { claim: (await getClaim(d.db, id))!, message: `Claim on call ${seq} is waiting for the seller.` }
  }
  if (!verdict.approve) {
    await d.db.prepare("UPDATE claims SET verdict = 'reject', reason_code = ?, evidence = ?, state = 'REJECTED' WHERE id = ?")
      .bind(verdict.reason_code ?? null, verdict.evidence ?? null, id).run()
    return { claim: (await getClaim(d.db, id))!, message: `Claim on call ${seq} was not upheld. The call stays billed.` }
  }
  if (verdict.reason_code === 'DUPLICATE' && !await reserveDuplicate(d.db, id, call, verdict.cited_seqs)) {
    await d.db.prepare("UPDATE claims SET verdict = 'reject', reason_code = 'DUPLICATE', evidence = ?, state = 'REJECTED' WHERE id = ?")
      .bind(verdict.evidence, id).run()
    return { claim: (await getClaim(d.db, id))!, message: `Claim on call ${seq} was not upheld. A matching call must stay billed.` }
  }
  await d.db.prepare("UPDATE claims SET verdict = 'approve', reason_code = ?, evidence = ?, state = 'APPROVED' WHERE id = ?")
    .bind(verdict.reason_code, verdict.evidence, id).run()

  const tab = (await getTab(d.db, call.tab_id))!
  if (tab.state !== 'PAID') {
    // Check the settlement lock in the write, not the snapshot above. A batch is one transaction: either this strike
    // wins before checkout, or settlement has frozen the bill and none of these writes apply.
    const r = await d.db.batch([
      d.db.prepare(`UPDATE calls SET status = 'STRUCK', reason_code = ?, evidence = ?, judged_by = 'claim'
        WHERE id = ? AND status = 'BILLABLE'
        AND (? IS NOT 'DUPLICATE'
          OR NOT EXISTS (SELECT 1 FROM duplicate_reservations WHERE retained_call_id = calls.id))
        AND EXISTS (
          SELECT 1 FROM tabs WHERE id = ? AND state IN ('OPEN', 'DUE') AND order_id IS NULL
            AND capture_id IS NULL AND captured_cents = 0 AND pay_method IS NULL AND pay_started_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM pay_attempts WHERE tab_id = tabs.id)
        )`)
        .bind(verdict.reason_code, verdict.evidence, call.id, verdict.reason_code, tab.id),
      d.db.prepare(`UPDATE tabs SET total_cents = total_cents - ?1,
          state = CASE WHEN state = 'DUE' AND total_cents - ?1 < threshold_cents THEN 'OPEN' ELSE state END,
          due_at = CASE WHEN state = 'DUE' AND total_cents - ?1 < threshold_cents THEN NULL ELSE due_at END
        WHERE changes() > 0 AND id = ?2 AND order_id IS NULL AND (SELECT status FROM calls WHERE id = ?3) = 'STRUCK'
          AND (SELECT judged_by FROM calls WHERE id = ?3) = 'claim'`)
        .bind(call.price_cents, tab.id, call.id),
      d.db.prepare(`UPDATE claims SET refund_status = 'NOT_DUE' WHERE id = ?
        AND changes() > 0 AND (SELECT status FROM calls WHERE id = ?) = 'STRUCK'
        AND (SELECT judged_by FROM calls WHERE id = ?) = 'claim'
        AND (SELECT order_id FROM tabs WHERE id = ?) IS NULL`)
        .bind(id, call.id, call.id, tab.id),
    ])
    if (r[0].meta.changes > 0) {
      await recordChainEvent(d.db, agent.id, seq, 'STRIKE', id, now(), d.signingKey)
      return { claim: (await getClaim(d.db, id))!, message: `Claim on call ${seq} upheld (${verdict.reason_code}). No refund is due because it was struck before billing.` }
    }
  }
  if (tab.state !== 'PAID') {
    // The tab already has a PayPal order for its full total: the refund comes after payment, on the seller's click.
    await setState(d.db, id, 'WAITING_SELLER')
    return { claim: (await getClaim(d.db, id))!, message: `Claim on call ${seq} upheld (${verdict.reason_code}). The tab is being paid; the refund follows payment.` }
  }

  const limit = refundLimit(tab, call.price_cents)
  if (limit !== 'auto') {
    await setState(d.db, id, 'WAITING_SELLER')
    return { claim: (await getClaim(d.db, id))!, message: `Claim on call ${seq} upheld (${verdict.reason_code}). The refund waits for the seller.` }
  }
  const r = await refundCall(d.db, d.pp, id, call, tab, 'auto', d.signingKey)
  const claim = (await getClaim(d.db, id))!
  if (claim.state === 'WAITING_SELLER') return { claim, message: `Claim on call ${seq} upheld (${verdict.reason_code}). The refund waits for the seller.` }
  return { claim, message: r.ok ? `Claim on call ${seq} upheld (${verdict.reason_code}). Refund ${r.refund_id} is ${r.status}.` : claim.state === 'REFUNDING' ? `Claim on call ${seq} upheld. The refund is still being checked.` : `Claim on call ${seq} upheld, but the refund did not go through.` }
}

/** POST /api/claims/{id}/approve: the seller's click for a claim that waits. Still capped at captured minus refunded. */
export async function approveBySeller(d: ClaimDeps, wsId: string, claimId: string): Promise<{ claim: Claim; ok: boolean; name?: string }> {
  const claim = await getClaim(d.db, claimId)
  if (!claim || claim.ws_id !== wsId) throw new Error('No such claim.')
  if (claim.refund_status === 'NOT_DUE' || (claim.state !== 'WAITING_SELLER' && !(claim.state === 'APPROVED' && claim.refund_status?.startsWith('FAILED')))) {
    return { claim, ok: false, name: 'NOT_WAITING' }
  }
  const call = (await d.db.prepare('SELECT * FROM calls WHERE id = ?').bind(claim.call_id).first<Call>())!
  const tab = (await getTab(d.db, call.tab_id))!
  if (tab.state !== 'PAID') return { claim, ok: false, name: 'NOT_PAID' }
  const r = await refundCall(d.db, d.pp, claim.id, call, tab, 'seller', d.signingKey)
  return { claim: (await getClaim(d.db, claimId))!, ok: r.ok, name: r.name }
}

/** A claim that exists already: a refund left in REFUNDING (its answer lost) is finished with the same request id. */
async function resume(d: ClaimDeps, claim: Claim, call: Call, seq: number): Promise<{ claim: Claim; message: string }> {
  if (claim.state === 'REFUNDING') {
    const tab = (await getTab(d.db, call.tab_id))!
    // Older RETRY rows already hold their reservation, so they need no new automatic share check.
    const mode = claim.refund_status === 'RETRY_AUTO' ? 'auto' : 'seller'
    const r = await refundCall(d.db, d.pp, claim.id, call, tab, mode, d.signingKey)
    const now = (await getClaim(d.db, claim.id))!
    return { claim: now, message: r.ok ? `Claim on call ${seq}: refund ${r.refund_id} is ${r.status}.` : `Claim on call ${seq} is ${now.state}.` }
  }
  return { claim, message: `Call ${seq} already has a claim (${claim.state}).` }
}

async function setState(db: D1Database, id: string, state: Claim['state'], verdict?: string) {
  await db.prepare('UPDATE claims SET state = ?, verdict = COALESCE(?, verdict) WHERE id = ?').bind(state, verdict ?? null, id).run()
}
