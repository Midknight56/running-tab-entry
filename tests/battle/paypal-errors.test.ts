import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PayPalClient } from '../../src/paypal/client'
import { completeReturn, startPayment } from '../../src/bill/settle'
import { refundCall } from '../../src/claims/refund'
import { fakeD1, fakeKV, type FakeD1 } from '../helpers/d1'

let db: FakeD1
beforeEach(() => { db = fakeD1() })

async function seed(state = 'DUE') {
  await db.prepare(`INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, created_at)
    VALUES ('tab_1', 'ws1', 'agt_1', ?, 75, 50, 1)`).bind(state).run()
  await db.prepare("UPDATE tabs SET order_id = 'ORD1'").run()
  for (const [seq, id, price] of [[1, 'call1', 25], [2, 'call2', 25], [3, 'call3', 25]] as const) {
    await db.prepare(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
      VALUES (?, ?, 'ws1', 'agt_1', 'tab_1', 'tool', '{}', '{}', ?, 'BILLABLE', 1)`).bind(id, seq, price).run()
  }
}

function client(fetcher: typeof fetch, trace: unknown[] = []) {
  return new PayPalClient({ base: 'https://api-m.sandbox.paypal.com', clientId: 'client-id', secret: 'secret-value',
    kv: fakeKV(), fetch: fetcher, now: () => 1, memory: new Map(), trace: (r) => { trace.push(r) } })
}

describe('PayPal error attacks', () => {
  it('refuses failed order creation and leaves the tab due without exposing credentials', async () => {
    await seed()
    const trace: unknown[] = []
    const c = { request: async () => ({ status: 503, body: { name: 'UNAVAILABLE', debug_id: 'dbg' }, name: 'UNAVAILABLE' }) }
    const r = await startPayment({ db, pp: c as any, origin: 'https://rt.example' }, 'tab_1')
    expect(r.kind).toBe('refused')
    expect((await db.prepare('SELECT state FROM tabs').first<any>()).state).toBe('DUE')
    const all = JSON.stringify([r, trace])
    expect(all).not.toContain('secret-value')
    expect(all).not.toContain('tok_')
  })

  it.each(['PENDING', 'DECLINED'])('does not mark a %s capture as paid', async (status) => {
    await seed()
    const pp = { request: async () => ({ status: 201, body: { id: 'ORD1', purchase_units: [{ payments: { captures: [{ id: 'CAP1', status, amount: { value: '0.75' } }] } }] } }) }
    expect((await completeReturn({ db, pp: pp as any, origin: 'x' }, 'ORD1')).kind).toBe('failed')
    expect((await db.prepare('SELECT state FROM tabs').first<any>()).state).toBe('DUE')
  })

  it('reads an already captured order and a repeated return captures at most once', async () => {
    await seed()
    let captures = 0
    const pp = { request: async (method: string) => {
      if (method === 'POST') { captures++; return { status: 422, name: 'UNPROCESSABLE_ENTITY', body: { name: 'UNPROCESSABLE_ENTITY' } } }
      return { status: 200, body: { purchase_units: [{ payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { value: '0.75' } }] } }] } }
    } }
    expect((await completeReturn({ db, pp: pp as any, origin: 'x' }, 'ORD1')).kind).toBe('paid')
    expect((await completeReturn({ db, pp: pp as any, origin: 'x' }, 'ORD1')).kind).toBe('paid')
    expect(captures).toBe(1)
  })

  it('does not capture an order token belonging to another tab', async () => {
    await seed()
    await db.prepare("INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, created_at, order_id) VALUES ('tab_2','ws1','agt_2','DUE',50,50,1,'ORD2')").run()
    let captures = 0
    const pp = { request: async () => { captures++; return { status: 201, body: {} } } }
    expect(await completeReturn({ db, pp: pp as any, origin: 'x' }, 'ORD2')).toMatchObject({ kind: 'failed', tab_id: 'tab_2' })
    expect(captures).toBe(1)
    expect((await db.prepare("SELECT state FROM tabs WHERE id = 'tab_1'").first<any>()).state).toBe('DUE')
  })

  it('treats malformed PayPal JSON as a refusal', async () => {
    await seed()
    const c = client(vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/token')
      ? new Response('{"access_token":"tok","expires_in":3600}')
      : new Response('{broken', { status: 503 })) as unknown as typeof fetch)
    const r = await startPayment({ db, pp: c, origin: 'https://rt.example' }, 'tab_1')
    expect(r).toMatchObject({ kind: 'refused', http: 503 })
    expect((await db.prepare('SELECT state FROM tabs').first<any>()).state).toBe('DUE')
  })

  it('applies a time limit to a PayPal fetch', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith('/token')
      ? Promise.resolve(new Response('{"access_token":"tok","expires_in":3600}'))
      : new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })) as unknown as typeof fetch
    const c = client(fetcher)
    const request = c.request('GET', '/v2/checkout/orders/ORD1')
    const rejected = expect(request).rejects.toThrow('PayPal request timed out or failed')
    await vi.runAllTimersAsync()
    await rejected
    expect((fetcher as any).mock.calls[1][1].signal).toBeDefined()
    vi.useRealTimers()
  }, 3000)

  it('keeps the same request id on a retry after a connection failure', async () => {
    let calls = 0
    const ids: string[] = []
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (String(_input).endsWith('/token')) return new Response('{"access_token":"tok","expires_in":3600}')
      ids.push(new Headers(init?.headers).get('PayPal-Request-Id') ?? '')
      calls++
      if (calls === 1) throw new Error('network')
      return new Response('{"id":"R1"}', { status: 201 })
    }) as unknown as typeof fetch
    await client(fetcher).request('POST', '/v2/checkout/orders', { requestId: 'rt-order-tab_1' })
    expect(ids).toEqual(['rt-order-tab_1', 'rt-order-tab_1'])
  })
})
