// POST /webhooks/paypal. The raw body is read as text and sent to PayPal's verify call byte for byte (webhooks.md:
// "re-serializing the JSON ... breaks verification"). Only SUCCESS is trusted. The answer is 200 at once and the work
// runs after it (webhooks.md: PayPal retries if no 200 "within 30 seconds"). An event id is processed once.
//
// One sandbox app serves five hackathon apps, so every app's captures reach this URL too. An event whose resource is
// not one of our tabs or refunds is answered 200 and dropped.
import type { PayPalClient } from './client'
import { recordPayment } from '../bill/settle'
import { reconcileRefund } from '../claims/refund'
import { toCents } from '../tab/pricing'
import type { Tab } from '../tab/ledger'

export interface WebhookDeps {
  db: D1Database
  pp: Pick<PayPalClient, 'request'>
  webhookId: string | undefined
  now?: () => number
  signingKey?: string
}

const NEEDED = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time']

export async function receiveWebhook(request: Request, d: WebhookDeps, waitUntil: (p: Promise<unknown>) => void): Promise<Response> {
  const now = d.now ?? Date.now
  const raw = await readBody(request, 1024 * 1024)
  if (raw === null) return new Response('body too large', { status: 413 })
  let event: { id?: string; event_type?: string; resource?: any }
  try { event = JSON.parse(raw) } catch { return new Response('not JSON', { status: 400 }) }
  if (!event.id || !event.event_type) return new Response('not an event', { status: 400 })
  const missing = NEEDED.filter((h) => !request.headers.get(h))
  // One log line per delivery: the event, and which signature headers were absent. Never a header's value.
  console.log(JSON.stringify({ webhook: event.event_type, id: event.id, missing, has_webhook_id: Boolean(d.webhookId) }))
  if (missing.length || !d.webhookId) {
    await d.db.prepare('INSERT OR IGNORE INTO events (id, event_type, verification, resource_id, received_at) VALUES (?, ?, ?, ?, ?)')
      .bind(event.id, event.event_type, 'MISSING_HEADERS', typeof event.resource?.id === 'string' ? event.resource.id : null, now()).run()
    return new Response('missing signature headers', { status: 400 })
  }

  const fields = {
    auth_algo: request.headers.get('paypal-auth-algo'),
    cert_url: request.headers.get('paypal-cert-url'),
    transmission_id: request.headers.get('paypal-transmission-id'),
    transmission_sig: request.headers.get('paypal-transmission-sig'),
    transmission_time: request.headers.get('paypal-transmission-time'),
    webhook_id: d.webhookId,
  }
  const rawBody = JSON.stringify(fields).slice(0, -1) + `,"webhook_event":${raw}}`
  let v: { status: number; body: { verification_status?: string } | null }
  try {
    v = await d.pp.request('POST', '/v1/notifications/verify-webhook-signature', { rawBody, requestId: `rt-verify-${fields.transmission_id}` })
  } catch {
    return new Response('verification unavailable', { status: 502 })
  }
  // No answer we can read is not a FAILURE: a non 2xx makes PayPal send the event again later.
  if (!v || typeof v.status !== 'number' || !v.body || typeof v.body !== 'object') {
    return new Response('verification unavailable', { status: 502 })
  }
  const verified = v.status === 200 && v.body.verification_status === 'SUCCESS'
  const resourceId = typeof event.resource?.id === 'string' ? event.resource.id : null

  const ins = await d.db.prepare(
    'INSERT OR IGNORE INTO events (id, event_type, verification, resource_id, received_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(event.id, event.event_type, verified ? 'SUCCESS' : 'FAILED', resourceId, now()).run()
  if (!verified) return new Response('verification failed', { status: 400 })
  if (ins.meta.changes === 0) {
    // A repeat of an event we hold. If the first copy failed verification, this verified copy may still be processed.
    const prior = await d.db.prepare('SELECT verification, processed_at FROM events WHERE id = ?').bind(event.id).first<any>()
    if (prior?.processed_at) return new Response('already processed', { status: 200 })
    await d.db.prepare("UPDATE events SET verification = 'SUCCESS' WHERE id = ?").bind(event.id).run()
  }
  waitUntil(process(d, event.id, event.event_type, event.resource, now))
  return new Response('ok', { status: 200 })
}

async function process(d: WebhookDeps, eventId: string, type: string, resource: any, now: () => number) {
  let outcome = 'not ours'
  let wsId: string | null = null
  if (type === 'PAYMENT.CAPTURE.COMPLETED' || type === 'PAYMENT.CAPTURE.DENIED') {
    const tab = await findTab(d.db, resource)
    if (tab) {
      wsId = tab.ws_id
      if (type === 'PAYMENT.CAPTURE.COMPLETED') {
        let amount = 0
        try { amount = toCents(String(resource?.amount?.value ?? '0')) } catch { amount = 0 }
        if (resource?.amount?.currency_code === 'USD' && amount > 0) {
          const orderId = resource?.supplementary_data?.related_ids?.order_id ?? tab.order_id ?? ''
          const method = await d.db.prepare('SELECT method FROM payments WHERE capture_id = ?').bind(resource.id).first<'wallet' | 'card'>('method')
          const changed = await recordPayment({ ...d, now }, tab, method ?? 'wallet', orderId, { id: resource.id, amount_cents: amount })
          outcome = changed ? 'tab paid' : tab.state !== 'PAID' && amount !== tab.total_cents ? 'capture amount mismatch' : 'capture confirmed'
        } else {
          outcome = 'capture amount mismatch'
        }
      } else {
        outcome = 'capture denied, tab stays due'
        await d.db.prepare("UPDATE tabs SET state = 'DUE' WHERE id = ? AND capture_id = ?").bind(tab.id, resource.id).run()
      }
    }
  } else if (type === 'PAYMENT.CAPTURE.REFUNDED') {
    const claim = await d.db.prepare('SELECT id, ws_id FROM claims WHERE refund_id = ?').bind(resource?.id ?? '').first<any>()
    if (claim) {
      wsId = claim.ws_id
      if (resource?.status === 'COMPLETED') await reconcileRefund(d.db, d.pp, claim.id, d.signingKey, { id: resource.id, status: resource.status })
      outcome = 'refund confirmed'
    }
  }
  await d.db.prepare('UPDATE events SET outcome = ?, ws_id = ?, processed_at = ? WHERE id = ?').bind(outcome, wsId, now(), eventId).run()
}

/** Our tab for a capture event, matched by payment ids or the invoice id on a USD capture. */
async function findTab(db: D1Database, resource: any): Promise<Tab | null> {
  const captureId = typeof resource?.id === 'string' ? resource.id : ''
  const orderId = typeof resource?.supplementary_data?.related_ids?.order_id === 'string' ? resource.supplementary_data.related_ids.order_id : ''
  const byIds = await db.prepare('SELECT * FROM tabs WHERE (capture_id = ? AND capture_id != \'\') OR (order_id = ? AND order_id != \'\') LIMIT 1')
    .bind(captureId, orderId).first<Tab>()
  if (byIds) return byIds
  const invoiceId = resource?.invoice_id
  if (!captureId || typeof invoiceId !== 'string' || !invoiceId.startsWith('rt-') || resource?.amount?.currency_code !== 'USD') return null
  return db.prepare('SELECT * FROM tabs WHERE id = ?').bind(invoiceId.slice(3)).first<Tab>()
}

async function readBody(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}
