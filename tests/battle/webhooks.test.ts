import { beforeEach, describe, expect, it } from 'vitest'
import { receiveWebhook } from '../../src/paypal/webhooks'
import { fakeD1, type FakeD1 } from '../helpers/d1'

const HEADERS = {
  'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/cert.pem',
  'paypal-transmission-id': 'tid-battle', 'paypal-transmission-sig': 'sig==', 'paypal-transmission-time': '2026-10-23T10:00:00Z',
}

function event(id: string, type: string, resource: Record<string, unknown>) {
  return JSON.stringify({ id, event_type: type, resource })
}

function paypal(answer: unknown = { status: 200, body: { verification_status: 'SUCCESS' } }) {
  const calls: unknown[] = []
  return {
    calls,
    async request(_method: string, _path: string, options: unknown) {
      calls.push(options)
      if (answer instanceof Error) throw answer
      return answer
    },
  }
}

let db: FakeD1
const jobs: Promise<unknown>[] = []
const waitUntil = (job: Promise<unknown>) => { jobs.push(job) }
const flush = async () => { await Promise.all(jobs.splice(0)) }

async function seedTab() {
  await db.prepare(`INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, order_id, created_at)
    VALUES ('tab_1', 'ws1', 'agt_1', 'DUE', 510, 500, 'ORDER1', 1)`).run()
}

function post(body: string, headers: Record<string, string> = HEADERS) {
  return new Request('https://rt.example/webhooks/paypal', { method: 'POST', body, headers })
}

const capture = (id = 'CAP1', amount = '5.10', orderId = 'ORDER1', customId = 'rt-tab_1') => ({
  id, status: 'COMPLETED', amount: { currency_code: 'USD', value: amount }, custom_id: customId,
  supplementary_data: { related_ids: { order_id: orderId } },
})

beforeEach(() => { db = fakeD1() })

describe('webhook attack cases', () => {
  it('processes a repeated event once, including simultaneous deliveries', async () => {
    await seedTab()
    const pp = paypal()
    const body = event('EVT_REPEAT', 'PAYMENT.CAPTURE.COMPLETED', capture())
    const responses = await Promise.all([
      receiveWebhook(post(body), { db, pp: pp as any, webhookId: 'WH_ID', now: () => 10 }, waitUntil),
      receiveWebhook(post(body), { db, pp: pp as any, webhookId: 'WH_ID', now: () => 10 }, waitUntil),
    ])
    await flush()
    const replay = await receiveWebhook(post(body), { db, pp: pp as any, webhookId: 'WH_ID', now: () => 20 }, waitUntil)
    await flush()
    expect([...responses.map((r) => r.status), replay.status]).toEqual([200, 200, 200])
    expect(await db.prepare('SELECT state, capture_id, captured_cents, paid_at FROM tabs').first<any>())
      .toEqual({ state: 'PAID', capture_id: 'CAP1', captured_cents: 510, paid_at: 10 })
    expect(await db.prepare('SELECT COUNT(*) AS n FROM events').first<number>('n')).toBe(1)
  })

  it('does not apply a fresh event id twice for the same capture', async () => {
    await seedTab()
    const pp = paypal()
    for (const id of ['EVT_OLD', 'EVT_REPLAY']) {
      const response = await receiveWebhook(post(event(id, 'PAYMENT.CAPTURE.COMPLETED', capture())), { db, pp: pp as any, webhookId: 'WH_ID', now: () => id === 'EVT_OLD' ? 10 : 20 }, waitUntil)
      expect(response.status).toBe(200)
      await flush()
    }
    expect(await db.prepare('SELECT state, captured_cents, paid_at FROM tabs').first<any>())
      .toEqual({ state: 'PAID', captured_cents: 510, paid_at: 10 })
  })

  it('rejects bad signatures, missing headers, and changed signed bytes without changing state', async () => {
    await seedTab()
    const bad = paypal({ status: 200, body: { verification_status: 'FAILURE' } })
    const body = event('EVT_BAD_SIG', 'PAYMENT.CAPTURE.COMPLETED', capture())
    const badResponse = await receiveWebhook(post(body), { db, pp: bad as any, webhookId: 'WH_ID' }, waitUntil)
    const { ['paypal-transmission-sig']: _removed, ...missing } = HEADERS
    const missingResponse = await receiveWebhook(post(event('EVT_MISSING', 'PAYMENT.CAPTURE.COMPLETED', capture()), missing), { db, pp: bad as any, webhookId: 'WH_ID' }, waitUntil)
    const changedResponse = await receiveWebhook(post(event('EVT_CHANGED', 'PAYMENT.CAPTURE.COMPLETED', capture('CAP2'))), { db, pp: bad as any, webhookId: 'WH_ID' }, waitUntil)
    await flush()
    expect([badResponse.status, missingResponse.status, changedResponse.status]).toEqual([400, 400, 400])
    expect(await db.prepare('SELECT state, capture_id FROM tabs').first<any>()).toEqual({ state: 'DUE', capture_id: null })
  })

  it.each([
    ['server error', { status: 500, body: { verification_status: 'SUCCESS' } }],
    ['junk response', { status: 'junk', body: null }],
    ['timeout', new Error('verification timed out')],
  ])('returns a retryable response and changes no state when verification has a %s', async (_name, answer) => {
    await seedTab()
    const pp = paypal(answer)
    const response = await receiveWebhook(post(event('EVT_VERIFY', 'PAYMENT.CAPTURE.COMPLETED', capture())), { db, pp: pp as any, webhookId: 'WH_ID' }, waitUntil)
      .catch(() => null)
    await flush()
    expect(response).not.toBeNull()
    expect(response!.status).toBeGreaterThanOrEqual(400)
    expect(await db.prepare('SELECT state, capture_id FROM tabs').first<any>()).toEqual({ state: 'DUE', capture_id: null })
  })

  it('ignores an early refund, an unmade order, and a capture with the wrong amount', async () => {
    await seedTab()
    const pp = paypal()
    const earlyRefund = await receiveWebhook(post(event('EVT_REFUND_FIRST', 'PAYMENT.CAPTURE.REFUNDED', { id: 'REF1', status: 'COMPLETED' })), { db, pp: pp as any, webhookId: 'WH_ID' }, waitUntil)
    const unknownOrder = await receiveWebhook(post(event('EVT_UNKNOWN_ORDER', 'PAYMENT.CAPTURE.COMPLETED', capture('CAP2', '5.10', 'ORDER_NEVER_MADE'))), { db, pp: pp as any, webhookId: 'WH_ID' }, waitUntil)
    await flush()
    expect(await db.prepare('SELECT state, capture_id FROM tabs').first<any>()).toEqual({ state: 'DUE', capture_id: null })
    const wrongAmount = await receiveWebhook(post(event('EVT_WRONG_AMOUNT', 'PAYMENT.CAPTURE.COMPLETED', capture('CAP3', '4.99'))), { db, pp: pp as any, webhookId: 'WH_ID' }, waitUntil)
    await flush()
    expect([earlyRefund.status, unknownOrder.status, wrongAmount.status]).toEqual([200, 200, 200])
    expect(await db.prepare('SELECT state, capture_id, captured_cents FROM tabs').first<any>()).toEqual({ state: 'DUE', capture_id: null, captured_cents: 0 })
    expect(await db.prepare("SELECT amount_cents, status FROM payments WHERE capture_id = 'CAP3'").first()).toEqual({ amount_cents: 499, status: 'AMOUNT_MISMATCH' })
  })

  it('refuses bodies over one megabyte and invalid JSON without throwing', async () => {
    const pp = paypal()
    const hugeBody = `{"id":"EVT_BIG","event_type":"IGNORED","resource":{"padding":"${'x'.repeat(1024 * 1024)}"}}`
    const huge = new Request('https://rt.example/webhooks/paypal', { method: 'POST', headers: { ...HEADERS, 'content-length': String(new TextEncoder().encode(hugeBody).byteLength) }, body: hugeBody })
    const tooLarge = await receiveWebhook(huge, { db, pp: pp as any, webhookId: 'WH_ID' }, waitUntil)
    const invalid = await receiveWebhook(post('{'), { db, pp: pp as any, webhookId: 'WH_ID' }, waitUntil)
    expect([tooLarge.status, invalid.status]).toEqual([413, 400])
    expect(pp.calls).toHaveLength(0)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tabs').first<number>('n')).toBe(0)
  })
})
