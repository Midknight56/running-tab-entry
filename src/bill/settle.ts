// Settling a tab: one PayPal order per tab, the buyer approves, the server captures. The capture response lifts the
// pause; the webhook only confirms it (webhook-sandbox.md: delivery takes "~10 seconds up to 75+ seconds").
import type { PayPalClient } from '../paypal/client'
import { approvalLink, captureOf, captureOrder, createOrder, getOrder } from '../paypal/orders'
import { callsOfTab, getTab, newId, sealAgent, type Tab } from '../tab/ledger'
import { cents } from '../tab/pricing'
import { buildOrder } from './order-builder'

export interface SettleDeps {
  db: D1Database
  pp: Pick<PayPalClient, 'request'>
  origin: string
  now?: () => number
  signingKey?: string
  /** The bill note for the order's description; the template is used when absent. */
  note?: (tab: Tab) => Promise<string | undefined>
  /** Authorize fresh wallet orders that were not already counted by the route. */
  beforeOrder?: () => Promise<string | null>
}

export type PayStart =
  | { kind: 'redirect'; url: string; order_id: string }
  | { kind: 'paid'; tab_id: string }
  | { kind: 'refused'; reason: string; http?: number; name?: string; debug_id?: string }

type PayMethod = 'wallet' | 'card'
interface CardAttempt { request_id: string; body_json: string; order_id: string | null }
interface WalletAttempt extends CardAttempt { attempt_no: number }
const BUSY = 'A payment for this tab is already in progress. Try again in a minute.'
const CARD_CHECKING = 'A card payment for this tab is being checked. Try again in a minute.'

function sentCard(d: SettleDeps, tabId: string): Promise<CardAttempt | null> {
  return d.db.prepare("SELECT request_id, body_json, order_id FROM pay_attempts WHERE tab_id = ? AND method = 'card' AND state = 'SENT' LIMIT 1")
    .bind(tabId).first<CardAttempt>()
}

function sentWallet(d: SettleDeps, tabId: string): Promise<WalletAttempt | null> {
  return d.db.prepare("SELECT request_id, body_json, order_id, attempt_no FROM pay_attempts WHERE tab_id = ? AND method = 'wallet' AND state = 'SENT' LIMIT 1")
    .bind(tabId).first<WalletAttempt>()
}

/** A conditional write owns settlement across both payment routes. */
async function withSettlement(d: SettleDeps, tabId: string, method: PayMethod, action: (tab: Tab) => Promise<PayStart>): Promise<PayStart> {
  const started = (d.now ?? Date.now)()
  const owner = await sentCard(d, tabId) ? 'card' : method
  const lock = await d.db.prepare(`UPDATE tabs SET pay_method = ?, pay_started_at = ?
    WHERE id = ? AND state = 'DUE' AND (pay_method IS NULL OR pay_method = ? OR pay_started_at < ?)
    AND (? = 'card' OR NOT EXISTS (SELECT 1 FROM pay_attempts WHERE tab_id = tabs.id AND method = 'card' AND state = 'SENT'))`)
    .bind(owner, started, tabId, owner, started - 120000, owner).run()
  if (!lock.meta.changes) {
    const tab = await getTab(d.db, tabId)
    if (tab?.state === 'PAID') return { kind: 'paid', tab_id: tab.id }
    return { kind: 'refused', reason: await sentCard(d, tabId) ? CARD_CHECKING : BUSY, http: 409 }
  }
  try {
    const attempt = await sentCard(d, tabId)
    if (attempt) {
      const recovered = await sendCardAttempt(d, (await getTab(d.db, tabId))!, attempt)
      if (recovered.kind === 'paid' || method === 'card' || await sentCard(d, tabId)) return recovered
    }
    const wallet = await sentWallet(d, tabId)
    if (wallet) return sendWalletAttempt(d, (await getTab(d.db, tabId))!, wallet)
    return await action((await getTab(d.db, tabId))!)
  }
  finally {
    await d.db.prepare('UPDATE tabs SET pay_method = NULL WHERE id = ? AND pay_method = ? AND pay_started_at = ?')
      .bind(tabId, owner, started).run()
  }
}

/** Keep every completed capture, including one that must be returned in full. */
export async function recordPayment(d: Pick<SettleDeps, 'db' | 'pp' | 'now'>, tab: Tab, method: PayMethod, orderId: string, cap: { id: string; amount_cents: number }): Promise<boolean> {
  const now = (d.now ?? Date.now)()
  const result = await d.db.batch([
    d.db.prepare("UPDATE tabs SET state = 'PAID', capture_id = ?, captured_cents = ?, paid_at = ? WHERE id = ? AND state != 'PAID' AND total_cents = ?")
      .bind(cap.id, cap.amount_cents, now, tab.id, cap.amount_cents),
    d.db.prepare(`INSERT OR IGNORE INTO payments (id, tab_id, ws_id, method, order_id, capture_id, amount_cents, status, created_at)
      SELECT ?, id, ws_id, ?, ?, ?, ?, CASE WHEN capture_id = ? THEN 'COMPLETED' WHEN state = 'PAID' THEN 'DUPLICATE' ELSE 'AMOUNT_MISMATCH' END, ? FROM tabs WHERE id = ?`)
      .bind(newId('pay'), method, orderId, cap.id, cap.amount_cents, cap.id, now, tab.id),
  ])
  const lock = await d.db.prepare(`UPDATE payments SET refund_status = 'IN_FLIGHT'
    WHERE capture_id = ? AND status = 'DUPLICATE' AND (refund_status IS NULL OR refund_status = 'RETRY')`).bind(cap.id).run()
  if (lock.meta.changes) {
    try {
      const r = await d.pp.request('POST', `/v2/payments/captures/${encodeURIComponent(cap.id)}/refund`, {
        body: { amount: { currency_code: 'USD', value: cents(cap.amount_cents) } }, requestId: `rt-dup-${cap.id}`, wsId: tab.ws_id,
      })
      const status = r.body?.status
      if ((r.status !== 200 && r.status !== 201) || (status !== 'COMPLETED' && status !== 'PENDING')) throw new Error('Duplicate refund did not go through.')
      await d.db.prepare('UPDATE payments SET refund_status = ? WHERE capture_id = ?').bind(status, cap.id).run()
    } catch (error) {
      await d.db.prepare("UPDATE payments SET refund_status = 'RETRY' WHERE capture_id = ?").bind(cap.id).run()
      throw error
    }
  }
  return result[0].meta.changes > 0
}

async function settleCapture(d: SettleDeps, tab: Tab, method: PayMethod, orderId: string, cap: { id: string; amount_cents: number }): Promise<PayStart> {
  await recordPayment(d, tab, method, orderId, cap)
  if ((await getTab(d.db, tab.id))?.state === 'PAID') return { kind: 'paid', tab_id: tab.id }
  return { kind: 'refused', reason: 'The capture amount did not match this tab.', http: 409 }
}

/** GET /pay/{tab_id}: the order for a DUE tab (made once), then the PayPal approval link. */
export async function startPayment(d: SettleDeps, tabId: string): Promise<PayStart> {
  const now = d.now ?? Date.now
  const tab = await getTab(d.db, tabId)
  if (!tab) return { kind: 'refused', reason: 'No such tab.' }
  if (tab.state === 'PAID') return { kind: 'paid', tab_id: tab.id }
  if (tab.state !== 'DUE') return { kind: 'refused', reason: 'This tab is not due yet.' }

  return withSettlement(d, tab.id, 'wallet', current => startWallet(d, current, now))
}

async function startWallet(d: SettleDeps, tab: Tab, now: () => number): Promise<PayStart> {
  await sealAgent(d.db, tab.agent_id, d.signingKey, (d.now ?? Date.now)()).catch(() => undefined)
  const calls = await callsOfTab(d.db, tab.id)
  if (calls.filter((call) => call.status === 'BILLABLE').reduce((total, call) => total + call.price_cents, 0) !== tab.total_cents) {
    return { kind: 'refused', reason: 'A call is still running. Try again in a moment.', http: 409 }
  }

  if (tab.order_id) {
    const got = await getOrder(d.pp, tab.order_id, tab.ws_id).catch(() => undefined)
    const gone = got?.status === 404 && got.body?.name === 'RESOURCE_NOT_FOUND'
    if (!got || (got.status !== 200 && !gone) || got.bodyRead === false) {
      return { kind: 'refused', reason: 'PayPal could not be reached. Try again.', http: got?.status ?? 502 }
    }
    const status = got.status === 200 ? got.body?.status as string | undefined : undefined
    const cap = captureOf(got.body)
    if (status === 'COMPLETED' && cap?.status === 'COMPLETED') {
      return settleCapture(d, tab, 'wallet', tab.order_id, cap)
    }
    if (status === 'APPROVED') return finish(d, tab, tab.order_id, now)
    const link = approvalLink(got.body)
    if (got.status === 200 && link && (status === 'PAYER_ACTION_REQUIRED' || status === 'CREATED')) {
      return { kind: 'redirect', url: link, order_id: tab.order_id }
    }
    // Only a readable gone order, void, or terminal failed capture permits replacement.
    const failed = status === 'COMPLETED' && (cap?.status === 'DECLINED' || cap?.status === 'FAILED')
    if (!gone && status !== 'VOIDED' && !failed) return { kind: 'refused', reason: 'Payment is still being checked. Try again in a minute.', http: 409 }
  }

  const note = d.note ? await d.note(tab).catch(() => undefined) : undefined
  const body = buildOrder(tab, calls, {
    urls: { return_url: `${d.origin}/paypal/return`, cancel_url: `${d.origin}/paypal/cancel?tab=${tab.id}` },
    note,
  })
  if (d.beforeOrder) {
    const reason = await d.beforeOrder()
    if (reason) return { kind: 'refused', reason, http: 429 }
  }
  const at = now()
  // Allocate the number and save its exact body in one transaction. A competing
  // worker can only recover this attempt, never allocate another from a stale tab.
  await d.db.batch([
    d.db.prepare(`UPDATE tabs SET wallet_attempt = MAX(wallet_attempt, ?) + 1, note = ?
      WHERE id = ? AND state = 'DUE' AND order_id IS ? AND wallet_attempt = ?
      AND NOT EXISTS (SELECT 1 FROM pay_attempts WHERE tab_id = tabs.id AND method = 'wallet' AND state = 'SENT')`)
      .bind(tab.order_id ? 1 : 0, note ?? null, tab.id, tab.order_id, tab.wallet_attempt ?? 0),
    d.db.prepare(`INSERT INTO pay_attempts
      (tab_id, ws_id, method, request_id, body_json, state, created_at, updated_at, send_count, attempt_no)
      SELECT id, ws_id, 'wallet', 'rt-order-' || id || CASE WHEN wallet_attempt > 1 THEN '-' || wallet_attempt ELSE '' END,
        ?, 'SENT', ?, ?, 0, wallet_attempt FROM tabs WHERE id = ? AND changes() > 0`)
      .bind(JSON.stringify(body), at, at, tab.id),
  ])
  const attempt = await sentWallet(d, tab.id)
  if (!attempt) return { kind: 'refused', reason: BUSY, http: 409 }
  return sendWalletAttempt(d, tab, attempt)
}

async function sendWalletAttempt(d: SettleDeps, tab: Tab, attempt: WalletAttempt): Promise<PayStart> {
  // Persist before I/O so a lost response or crash makes the next send recovery.
  const sends = await d.db.prepare(`UPDATE pay_attempts SET send_count = send_count + 1, updated_at = ?
    WHERE request_id = ? AND state = 'SENT' RETURNING send_count`)
    .bind((d.now ?? Date.now)(), attempt.request_id).first<number>('send_count')
  if (sends === null) return { kind: 'refused', reason: BUSY, http: 409 }
  const r = await createOrder(d.pp, JSON.parse(attempt.body_json), tab.id, tab.ws_id, attempt.attempt_no)
  const link = approvalLink(r.body)
  if ((r.status !== 200 && r.status !== 201) || r.bodyRead === false || !r.body?.id) {
    if (sends === 1 && r.bodyRead !== false && !r.uncertainSend && [400, 401, 403, 404, 422].includes(r.status)) {
      // A concurrent replay may have started while this first response was in flight.
      await d.db.prepare("UPDATE pay_attempts SET state = 'FAILED', updated_at = ? WHERE request_id = ? AND state = 'SENT' AND send_count = 1")
        .bind((d.now ?? Date.now)(), attempt.request_id).run()
    }
    return { kind: 'refused', reason: r.status === 429 ? 'PayPal is busy right now. Try again in a minute.' : 'PayPal did not confirm the order. Try again.', http: r.status, name: r.name, debug_id: r.debugId }
  }
  await d.db.batch([
    d.db.prepare(`UPDATE tabs SET order_id = ? WHERE id = ? AND state = 'DUE' AND wallet_attempt = ?
      AND EXISTS (SELECT 1 FROM pay_attempts WHERE request_id = ? AND state = 'SENT')`)
      .bind(r.body.id, tab.id, attempt.attempt_no, attempt.request_id),
    d.db.prepare("UPDATE pay_attempts SET order_id = ?, state = 'DONE', updated_at = ? WHERE request_id = ? AND state = 'SENT' AND changes() > 0")
      .bind(r.body.id, (d.now ?? Date.now)(), attempt.request_id),
  ])
  const cap = captureOf(r.body)
  if (cap?.status === 'COMPLETED') return settleCapture(d, tab, 'wallet', r.body.id, cap)
  const current = (await getTab(d.db, tab.id))!
  if (current.state === 'PAID') return { kind: 'paid', tab_id: tab.id }
  if (current.order_id !== r.body.id) return { kind: 'refused', reason: BUSY, http: 409 }
  if (link && ['CREATED', 'PAYER_ACTION_REQUIRED'].includes(r.body.status)) return { kind: 'redirect', url: link, order_id: r.body.id }
  return { kind: 'refused', reason: 'Payment is still being checked. Try again in a minute.', http: 409 }
}

export type ReturnOutcome =
  | { kind: 'paid'; tab_id: string; ws_id: string; capture_id: string }
  | { kind: 'failed'; tab_id: string; ws_id: string; http: number; reason?: string; name?: string; debug_id?: string }
  | { kind: 'unknown' }

/** GET /paypal/return?token=ORDER_ID: capture on the server; a COMPLETED capture lifts the pause. */
export async function completeReturn(d: SettleDeps, orderId: string): Promise<ReturnOutcome> {
  const tab = await d.db.prepare('SELECT * FROM tabs WHERE order_id = ?').bind(orderId).first<Tab>()
  if (!tab) return { kind: 'unknown' }
  if (tab.state === 'PAID') return { kind: 'paid', tab_id: tab.id, ws_id: tab.ws_id, capture_id: tab.capture_id ?? '' }
  const r = await withSettlement(d, tab.id, 'wallet', current => finish(d, current, orderId, d.now ?? Date.now))
  if (r.kind === 'paid') return { kind: 'paid', tab_id: tab.id, ws_id: tab.ws_id, capture_id: (await getTab(d.db, tab.id))!.capture_id ?? '' }
  if (r.kind === 'refused') return { kind: 'failed', tab_id: tab.id, ws_id: tab.ws_id, http: r.http ?? 0, reason: r.reason, name: r.name, debug_id: r.debug_id }
  return { kind: 'failed', tab_id: tab.id, ws_id: tab.ws_id, http: 0 }
}

async function finish(d: SettleDeps, tab: Tab, orderId: string, now: () => number): Promise<PayStart> {
  let r = await captureOrder(d.pp, orderId, tab.ws_id)
  let cap = captureOf(r.body)
  if (!cap && r.name === 'UNPROCESSABLE_ENTITY') {
    // ORDER_ALREADY_CAPTURED and friends: read the order and trust what it says.
    r = await getOrder(d.pp, orderId, tab.ws_id)
    cap = captureOf(r.body)
  }
  if (cap && cap.status === 'COMPLETED') {
    return settleCapture({ ...d, now }, tab, 'wallet', orderId, cap)
  }
  return { kind: 'refused', reason: r.status === 429 ? 'PayPal is busy right now. Try again in a minute.' : 'Payment did not go through. The tab is still open.', http: r.status, name: r.name ?? cap?.status, debug_id: r.debugId }
}

/** PayPal's published sandbox test card (docs/paypal-apps/reference/webhook-sandbox.md, Path A). Not a real card. */
export const SANDBOX_TEST_CARD = { number: '4111111111111111', expiry: '2027-12', name: 'Test Buyer', security_code: '123' }

/**
 * Sandbox only: pays a DUE tab with the published test card, so a judge can settle a tab without a buyer login. The
 * order is created with the card as its payment source; a COMPLETED capture in the reply marks the tab paid.
 */
export async function payWithTestCard(d: SettleDeps, tabId: string, paypalBase: string): Promise<PayStart> {
  const host = new URL(paypalBase).hostname
  if (host === 'api-m.paypal.com' || host === 'api.paypal.com') return { kind: 'refused', reason: 'The test card works only in the PayPal sandbox.' }
  const tab = await getTab(d.db, tabId)
  if (!tab) return { kind: 'refused', reason: 'No such tab.' }
  if (tab.state === 'PAID') return { kind: 'paid', tab_id: tab.id }
  if (tab.state !== 'DUE') return { kind: 'refused', reason: 'This tab is not due yet.' }
  return withSettlement(d, tab.id, 'card', current => payCard(d, current))
}

async function payCard(d: SettleDeps, tab: Tab): Promise<PayStart> {
  if (tab.order_id) {
    const got = await getOrder(d.pp, tab.order_id, tab.ws_id)
    if (got.status !== 200) return { kind: 'refused', reason: 'PayPal did not read the existing order. Try again.', http: got.status }
    if (got.body?.status === 'COMPLETED') {
      const cap = captureOf(got.body)
      if (!cap || cap.status !== 'COMPLETED') return { kind: 'refused', reason: 'Payment is still in progress. Try again in a minute.', http: 409 }
      return settleCapture(d, tab, 'wallet', tab.order_id, cap)
    }
    if (got.body?.status === 'APPROVED') return finish(d, tab, tab.order_id, d.now ?? Date.now)
  }
  await sealAgent(d.db, tab.agent_id, d.signingKey, (d.now ?? Date.now)()).catch(() => undefined)
  const calls = await callsOfTab(d.db, tab.id)
  if (calls.filter((call) => call.status === 'BILLABLE').reduce((total, call) => total + call.price_cents, 0) !== tab.total_cents) {
    return { kind: 'refused', reason: 'A call is still running. Try again in a moment.', http: 409 }
  }
  const requestId = `rt-order-${tab.id}-card`
  const prior = await d.db.prepare('SELECT request_id FROM pay_attempts WHERE request_id = ?').bind(requestId).first()
  const note = prior ? tab.note ?? undefined : d.note ? await d.note(tab).catch(() => undefined) : undefined
  const body = buildOrder(tab, calls, { note, card: SANDBOX_TEST_CARD })
  const now = (d.now ?? Date.now)()
  // Save the body before sending so recovery repeats the original request exactly.
  await d.db.batch([
    d.db.prepare('UPDATE tabs SET note = ? WHERE id = ? AND NOT EXISTS (SELECT 1 FROM pay_attempts WHERE request_id = ?)')
      .bind(note ?? null, tab.id, requestId),
    d.db.prepare(`INSERT OR IGNORE INTO pay_attempts (tab_id, ws_id, method, request_id, body_json, state, created_at, updated_at, send_count)
      VALUES (?, ?, 'card', ?, ?, 'SENT', ?, ?, 0)`).bind(tab.id, tab.ws_id, requestId, JSON.stringify(body), now, now),
    d.db.prepare("UPDATE pay_attempts SET state = 'SENT', send_count = 0, updated_at = ? WHERE request_id = ? AND state = 'FAILED'").bind(now, requestId),
  ])
  return sendCardAttempt(d, (await getTab(d.db, tab.id))!, (await sentCard(d, tab.id))!)
}

async function sendCardAttempt(d: SettleDeps, tab: Tab, attempt: CardAttempt): Promise<PayStart> {
  const requestId = attempt.request_id
  // Persist before I/O: a crash or lost response means the next send is recovery.
  const sends = await d.db.prepare(`UPDATE pay_attempts SET send_count = send_count + 1, updated_at = ?
    WHERE request_id = ? AND state = 'SENT' RETURNING send_count`)
    .bind((d.now ?? Date.now)(), requestId).first<number>('send_count')
  if (sends === null) return { kind: 'refused', reason: CARD_CHECKING, http: 409 }
  let r
  try {
    r = attempt.order_id
      ? await getOrder(d.pp, attempt.order_id, tab.ws_id)
      : await d.pp.request('POST', '/v2/checkout/orders', { body: JSON.parse(attempt.body_json), requestId, wsId: tab.ws_id })
  } catch {
    return { kind: 'refused', reason: CARD_CHECKING, http: 409 }
  }
  if (r.bodyRead === false || !r.body || typeof r.body !== 'object') return { kind: 'refused', reason: CARD_CHECKING, http: 409 }
  const cap = captureOf(r.body)
  const read = r.status === 200 || r.status === 201
  if (read && r.body?.id && cap && cap.status !== 'COMPLETED' && cap.status !== 'DECLINED' && cap.status !== 'FAILED') {
    await d.db.batch([
      d.db.prepare('UPDATE pay_attempts SET order_id = ?, updated_at = ? WHERE request_id = ? AND state = \'SENT\'')
        .bind(r.body.id, (d.now ?? Date.now)(), requestId),
      d.db.prepare("UPDATE tabs SET order_id = ?, capture_id = ? WHERE id = ? AND state = 'DUE'")
        .bind(r.body.id, cap.id, tab.id),
    ])
    return { kind: 'refused', reason: CARD_CHECKING, http: 409 }
  }
  if ((r.status === 200 || r.status === 201) && r.body?.id && cap?.status === 'COMPLETED') {
    const paid = await settleCapture(d, tab, 'card', r.body.id, cap)
    await d.db.batch([
      d.db.prepare('UPDATE tabs SET order_id = ? WHERE id = ? AND capture_id = ?').bind(r.body.id, tab.id, cap.id),
      d.db.prepare('UPDATE pay_attempts SET state = ?, order_id = ?, updated_at = ? WHERE request_id = ?')
        .bind(paid.kind === 'paid' ? 'DONE' : 'SENT', r.body.id, (d.now ?? Date.now)(), requestId),
    ])
    return paid
  }
  // A failed read cannot resolve a known pending capture. Only its terminal status can.
  const terminal = read && (cap?.status === 'DECLINED' || cap?.status === 'FAILED')
  if (!terminal && (attempt.order_id || sends > 1 || r.uncertainSend || !(r.status >= 400 && r.status < 500) || [408, 409, 429].includes(r.status))) {
    return r.status === 429
      ? { kind: 'refused', reason: 'PayPal is busy right now. Try again in a minute.', http: 429 }
      : { kind: 'refused', reason: CARD_CHECKING, http: 409 }
  }
  if (terminal) {
    await d.db.prepare("UPDATE pay_attempts SET state = 'FAILED', order_id = ?, updated_at = ? WHERE request_id = ? AND state = 'SENT'")
      .bind(r.body?.id ?? null, (d.now ?? Date.now)(), requestId).run()
  } else {
    // An earlier refusal cannot resolve a replay that started while it was in flight.
    const failed = await d.db.prepare("UPDATE pay_attempts SET state = 'FAILED', order_id = ?, updated_at = ? WHERE request_id = ? AND state = 'SENT' AND send_count = 1")
      .bind(r.body?.id ?? null, (d.now ?? Date.now)(), requestId).run()
    if (failed.meta.changes === 0) return { kind: 'refused', reason: CARD_CHECKING, http: 409 }
  }
  if (terminal && attempt.order_id) {
    await d.db.prepare("UPDATE tabs SET order_id = NULL, capture_id = NULL WHERE id = ? AND state = 'DUE' AND order_id = ?")
      .bind(tab.id, attempt.order_id).run()
  }
  return { kind: 'refused', reason: r.status === 429 ? 'PayPal is busy right now. Try again in a minute.' : 'Payment did not go through. The tab is still open.', http: r.status, name: r.name ?? cap?.status, debug_id: r.debugId }
}
