import { beforeEach, describe, expect, it } from 'vitest'
import { receiveWebhook } from '../src/paypal/webhooks'
import { fakeD1, type FakeD1 } from './helpers/d1'

const HEADERS = {
  'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/cert.pem',
  'paypal-transmission-id': 'tid-1', 'paypal-transmission-sig': 'sig==', 'paypal-transmission-time': '2026-10-23T10:00:00Z',
}

function event(id: string, type: string, resource: Record<string, unknown>) {
  // Spaces and key order on purpose: the verify call must carry these exact bytes.
  return `{"id": "${id}",  "event_type": "${type}", "resource": ${JSON.stringify(resource)}}`
}

function fakePayPal(status: 'SUCCESS' | 'FAILURE') {
  const sent: string[] = []
  return {
    sent,
    async request(_m: string, path: string, opts: { rawBody?: string }) {
      sent.push(opts.rawBody ?? '')
      expect(path).toBe('/v1/notifications/verify-webhook-signature')
      return { status: 200, body: { verification_status: status } }
    },
  }
}

let db: FakeD1
const jobs: Promise<unknown>[] = []
const waitUntil = (p: Promise<unknown>) => { jobs.push(p) }
const flush = async () => { await Promise.all(jobs.splice(0)) }

async function seedTab(state = 'DUE') {
  await db.prepare(`INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, order_id, created_at)
    VALUES ('tab_1', 'ws1', 'agt_1', ?, 510, 500, 'ORDER1', 1)`).bind(state).run()
}

function post(body: string, headers: Record<string, string> = HEADERS) {
  return new Request('https://rt.example/webhooks/paypal', { method: 'POST', body, headers })
}

beforeEach(() => { db = fakeD1() })

describe('webhook receiver', () => {
  it('finds a tab from only the invoice id when neither payment id is known', async () => {
    await seedTab()
    await db.prepare('UPDATE tabs SET order_id = NULL').run()
    const pp = fakePayPal('SUCCESS')
    const body = event('WH-INVOICE', 'PAYMENT.CAPTURE.COMPLETED', { id: 'CAPCARD', invoice_id: 'rt-tab_1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '5.10' } })
    expect((await receiveWebhook(post(body), { db, pp: pp as any, webhookId: 'WH_ID' }, waitUntil)).status).toBe(200)
    await flush()
    expect(await db.prepare('SELECT state, capture_id, captured_cents FROM tabs').first()).toEqual({ state: 'PAID', capture_id: 'CAPCARD', captured_cents: 510 })
    expect(await db.prepare('SELECT capture_id, status FROM payments').first()).toEqual({ capture_id: 'CAPCARD', status: 'COMPLETED' })
  })

  it('records an invoice matched duplicate and refunds its full amount once', async () => {
    await seedTab('PAID')
    await db.prepare("UPDATE tabs SET capture_id = 'CAP1', captured_cents = 510").run()
    const refunds: any[] = []
    const pp = { async request(_m: string, path: string, opts: any) {
      if (path === '/v1/notifications/verify-webhook-signature') return { status: 200, body: { verification_status: 'SUCCESS' } }
      expect(path).toBe('/v2/payments/captures/CAPCARD/refund')
      refunds.push(opts)
      return { status: 201, body: { id: 'DUP_REF', status: 'COMPLETED' } }
    } }
    const resource = { id: 'CAPCARD', invoice_id: 'rt-tab_1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '0.80' }, supplementary_data: { related_ids: { order_id: 'UNKNOWN_CARD_ORDER' } } }
    for (const id of ['WH-INVOICE-DUP', 'WH-INVOICE-DUP', 'WH-INVOICE-DUP-2']) {
      await receiveWebhook(post(event(id, 'PAYMENT.CAPTURE.COMPLETED', resource)), { db, pp: pp as any, webhookId: 'WH_ID' }, waitUntil)
      await flush()
    }
    expect(refunds).toHaveLength(1)
    expect(refunds[0]).toMatchObject({ requestId: 'rt-dup-CAPCARD', body: { amount: { currency_code: 'USD', value: '0.80' } } })
    expect(await db.prepare("SELECT capture_id, amount_cents, status, refund_status FROM payments WHERE capture_id = 'CAPCARD'").first()).toEqual({ capture_id: 'CAPCARD', amount_cents: 80, status: 'DUPLICATE', refund_status: 'COMPLETED' })
    expect(await db.prepare('SELECT capture_id, captured_cents FROM tabs').first()).toEqual({ capture_id: 'CAP1', captured_cents: 510 })
  })

  it.each([
    ['unknown tab', 'rt-missing', 'USD', '5.10'],
    ['wrong prefix', 'tab_1', 'USD', '5.10'],
    ['foreign currency', 'rt-tab_1', 'EUR', '5.10'],
    ['missing currency', 'rt-tab_1', undefined, '5.10'],
    ['invalid amount', 'rt-tab_1', 'USD', 'junk'],
  ])('does not settle an invoice capture with %s', async (_label, invoice_id, currency_code, value) => {
    await seedTab()
    await db.prepare('UPDATE tabs SET order_id = NULL').run()
    const pp = fakePayPal('SUCCESS')
    await receiveWebhook(post(event('WH-INVOICE-BAD', 'PAYMENT.CAPTURE.COMPLETED', { id: 'CAPCARD', invoice_id, amount: { currency_code, value } })), { db, pp: pp as any, webhookId: 'WH_ID' }, waitUntil)
    await flush()
    expect(await db.prepare('SELECT state, capture_id FROM tabs').first()).toEqual({ state: 'DUE', capture_id: null })
    expect(await db.prepare('SELECT COUNT(*) AS n FROM payments').first('n')).toBe(0)
  })

  it('answers 400 and changes no tab when verification is not SUCCESS', async () => {
    await seedTab()
    const pp = fakePayPal('FAILURE')
    const body = event('WH-1', 'PAYMENT.CAPTURE.COMPLETED', { id: 'CAP1', status: 'COMPLETED', amount: { value: '5.10' }, supplementary_data: { related_ids: { order_id: 'ORDER1' } } })
    const r = await receiveWebhook(post(body), { db, pp: pp as any, webhookId: 'WH_ID' }, waitUntil)
    await flush()
    expect(r.status).toBe(400)
    const tab = await db.prepare('SELECT state, capture_id FROM tabs').first<any>()
    expect(tab).toEqual({ state: 'DUE', capture_id: null })
    expect(await db.prepare('SELECT verification FROM events').first<string>('verification')).toBe('FAILED')
  })

  it('sends the raw body bytes to verification, not a re-serialized copy', async () => {
    const pp = fakePayPal('SUCCESS')
    const body = event('WH-2', 'PAYMENT.CAPTURE.COMPLETED', { id: 'CAPX' })
    await receiveWebhook(post(body), { db, pp: pp as any, webhookId: 'WH_ID' }, waitUntil)
    expect(pp.sent[0]).toContain(`"webhook_event":${body}`)
  })

  it('a verified capture completed marks the tab paid, and the same event twice is processed once', async () => {
    await seedTab()
    const pp = fakePayPal('SUCCESS')
    const body = event('WH-3', 'PAYMENT.CAPTURE.COMPLETED', { id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '5.10' }, custom_id: 'rt-tab_1', supplementary_data: { related_ids: { order_id: 'ORDER1' } } })
    const r1 = await receiveWebhook(post(body), { db, pp: pp as any, webhookId: 'WH_ID' }, waitUntil)
    await flush()
    const r2 = await receiveWebhook(post(body), { db, pp: pp as any, webhookId: 'WH_ID' }, waitUntil)
    await flush()
    expect([r1.status, r2.status]).toEqual([200, 200])
    expect(await db.prepare('SELECT state, capture_id, captured_cents FROM tabs').first<any>()).toEqual({ state: 'PAID', capture_id: 'CAP1', captured_cents: 510 })
    expect(await db.prepare('SELECT COUNT(*) AS n FROM events').first<number>('n')).toBe(1)
    expect(await db.prepare('SELECT outcome FROM events').first<string>('outcome')).toBe('tab paid')
  })

  it('retries a verified event when its first processing attempt did not finish', async () => {
    await seedTab()
    db.raw.exec(`CREATE TRIGGER fail_event_processing BEFORE UPDATE OF outcome ON events BEGIN SELECT RAISE(ABORT, 'processing failed'); END`)
    const pp = fakePayPal('SUCCESS')
    const body = event('WH-RETRY', 'PAYMENT.CAPTURE.COMPLETED', { id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '5.10' }, supplementary_data: { related_ids: { order_id: 'ORDER1' } } })
    await receiveWebhook(post(body), { db, pp: pp as any, webhookId: 'WH_ID' }, waitUntil)
    await expect(flush()).rejects.toThrow('processing failed')
    db.raw.exec('DROP TRIGGER fail_event_processing')
    const retry = await receiveWebhook(post(body), { db, pp: pp as any, webhookId: 'WH_ID' }, waitUntil)
    await flush()
    expect(retry.status).toBe(200)
    expect(await db.prepare('SELECT state, capture_id FROM tabs').first<any>()).toEqual({ state: 'PAID', capture_id: 'CAP1' })
    expect(await db.prepare('SELECT processed_at FROM events').first<number>('processed_at')).not.toBeNull()
  })

  it('answers 200 and ignores an event for a resource that is not ours', async () => {
    await seedTab()
    const pp = fakePayPal('SUCCESS')
    const body = event('WH-4', 'PAYMENT.CAPTURE.COMPLETED', { id: 'CAP9', custom_id: 'gs-other', supplementary_data: { related_ids: { order_id: 'OTHER' } } })
    const r = await receiveWebhook(post(body), { db, pp: pp as any, webhookId: 'WH_ID' }, waitUntil)
    await flush()
    expect(r.status).toBe(200)
    expect(await db.prepare('SELECT state FROM tabs').first<string>('state')).toBe('DUE')
    expect(await db.prepare('SELECT outcome FROM events').first<string>('outcome')).toBe('not ours')
  })

  it('refuses a delivery with a missing signature header without calling PayPal', async () => {
    const pp = fakePayPal('SUCCESS')
    const { ['paypal-transmission-sig']: _drop, ...rest } = HEADERS
    const r = await receiveWebhook(post(event('WH-5', 'X', {}), rest), { db, pp: pp as any, webhookId: 'WH_ID' }, waitUntil)
    expect(r.status).toBe(400)
    expect(pp.sent).toHaveLength(0)
  })

  it('a verified refund confirms a refund the app made, by refund id', async () => {
    await seedTab('PAID')
    await db.prepare("UPDATE tabs SET capture_id = 'CAP1', captured_cents = 510, refunded_cents = 25").run()
    await db.prepare(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
      VALUES ('call_1', 1, 'ws1', 'agt_1', 'tab_1', 'convert_time', '{}', '{}', 25, 'BILLABLE', 1)`).run()
    await db.prepare(`INSERT INTO claims (id, ws_id, call_id, reason_text, state, refund_id, refund_status, created_at)
      VALUES ('clm_1', 'ws1', 'call_1', 'dup', 'REFUNDING', 'REF1', 'PENDING', 1)`).run()
    const pp = fakePayPal('SUCCESS')
    const body = event('WH-6', 'PAYMENT.CAPTURE.REFUNDED', { id: 'REF1', status: 'COMPLETED', amount: { value: '0.25' } })
    await receiveWebhook(post(body), { db, pp: pp as any, webhookId: 'WH_ID' }, waitUntil)
    await flush()
    expect(await db.prepare('SELECT refund_status FROM claims').first<string>('refund_status')).toBe('COMPLETED')
    expect(await db.prepare('SELECT state FROM claims').first('state')).toBe('REFUNDED')
    expect(await db.prepare('SELECT status FROM calls').first('status')).toBe('REFUNDED')
    await receiveWebhook(post(event('WH-6-again', 'PAYMENT.CAPTURE.REFUNDED', { id: 'REF1', status: 'COMPLETED' })), { db, pp: pp as any, webhookId: 'WH_ID' }, waitUntil)
    await flush()
    expect(await db.prepare("SELECT COUNT(*) AS n FROM chain_events WHERE kind = 'REFUND'").first('n')).toBe(1)
    expect(await db.prepare('SELECT outcome, ws_id FROM events').first<any>()).toEqual({ outcome: 'refund confirmed', ws_id: 'ws1' })
  })

  it('records and refunds a duplicate capture once while preserving the first capture', async () => {
    await seedTab('PAID')
    await db.prepare("UPDATE tabs SET capture_id = 'CAP1', captured_cents = 510").run()
    const refunds: any[] = []
    const pp = { async request(_m: string, path: string, opts: any) {
      if (path === '/v1/notifications/verify-webhook-signature') return { status: 200, body: { verification_status: 'SUCCESS' } }
      expect(path).toBe('/v2/payments/captures/CAP2/refund')
      refunds.push(opts)
      return { status: 201, body: { id: 'DUP_REF', status: 'COMPLETED' } }
    } }
    const resource = { id: 'CAP2', status: 'COMPLETED', amount: { currency_code: 'USD', value: '0.80' }, supplementary_data: { related_ids: { order_id: 'ORDER1' } } }
    for (const id of ['WH-DUP', 'WH-DUP', 'WH-DUP-2']) {
      await receiveWebhook(post(event(id, 'PAYMENT.CAPTURE.COMPLETED', resource)), { db, pp: pp as any, webhookId: 'WH_ID' }, waitUntil)
      await flush()
    }
    expect(refunds).toHaveLength(1)
    expect(refunds[0]).toMatchObject({ requestId: 'rt-dup-CAP2', body: { amount: { currency_code: 'USD', value: '0.80' } } })
    expect(await db.prepare("SELECT capture_id, amount_cents, status FROM payments WHERE capture_id = 'CAP2'").first()).toEqual({ capture_id: 'CAP2', amount_cents: 80, status: 'DUPLICATE' })
    expect(await db.prepare('SELECT capture_id, captured_cents FROM tabs').first()).toEqual({ capture_id: 'CAP1', captured_cents: 510 })
  })
})

describe('webhook receiver, missing headers', () => {
  it('keeps a MISSING_HEADERS row so a delivery is never silent', async () => {
    db = fakeD1()
    const pp = fakePayPal('SUCCESS')
    const r = await receiveWebhook(post(event('WH-7', 'PAYMENT.CAPTURE.COMPLETED', { id: 'C' }), { 'content-type': 'application/json' }), { db, pp: pp as any, webhookId: 'WH_ID' }, waitUntil)
    expect(r.status).toBe(400)
    expect(await db.prepare('SELECT verification FROM events').first<string>('verification')).toBe('MISSING_HEADERS')
  })
})
