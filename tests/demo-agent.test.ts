import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handle } from '../src/worker'
import { SCRIPT } from '../src/demo/agent'
import type { Env } from '../src/env'
import { fakeD1, fakeKV, type FakeD1 } from './helpers/d1'

const CLIENT_ID = 'cid_SANDBOX_TEST_ID'
const CLIENT_SECRET = 'csec_SANDBOX_TEST_SECRET'

/** A model stand in that behaves like a careful auditor and judge, so the run is the same every time. */
function fakeAi() {
  const jobs: string[] = []
  return {
    jobs,
    async run(_model: string, input: any) {
      const system: string = input.messages[0].content
      const user = JSON.parse(input.messages.at(-1).content.replace(/ \/no_think$/, ''))
      const reply = (o: unknown) => ({ response: JSON.stringify(o), usage: { prompt_tokens: 400, completion_tokens: 40 } })
      if (system.startsWith('You audit')) {
        jobs.push('audit')
        if (String(user.answer).includes('weather')) return reply({ call_id: user.call_id, verdict: 'strike', reason_code: 'OFF_REQUEST', evidence: 'London has mild weather this week' })
        return reply({ call_id: user.call_id, verdict: 'keep', reason_code: '', evidence: '' })
      }
      if (system.startsWith('You judge')) {
        jobs.push('claim')
        return reply({ verdict: 'approve', reason_code: 'DUPLICATE', evidence: '"time":"16:00"', cited_call_ids: [23, 24] })
      }
      if (system.startsWith('You write')) {
        jobs.push('note')
        return { response: 'Billed $5.15 for 27 calls. Calls 9, 14 and 21 were struck and not billed.' }
      }
      jobs.push('explain')
      return reply({ answer: 'You paid $5.15 for 27 calls. Calls 9, 14 and 21 were struck. $0.25 came back for call 24.', cited_call_ids: [9, 14, 21, 24] })
    },
  }
}

/** PayPal's sandbox, as day one check C5 saw it answer. */
function fakePayPal() {
  const calls: { method: string; path: string; requestId: string | null; body: any; auth: string }[] = []
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input))
    const h = new Headers(init?.headers)
    const body = init?.body ? (u.pathname.endsWith('/token') ? String(init.body) : JSON.parse(String(init.body))) : null
    calls.push({ method: init?.method ?? 'GET', path: u.pathname, requestId: h.get('PayPal-Request-Id'), body, auth: h.get('Authorization') ?? '' })
    const res = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'paypal-debug-id': 'dbg' + calls.length } })
    if (u.pathname === '/v1/oauth2/token') return res(200, { access_token: 'A21_TEST_TOKEN', expires_in: 32400 })
    if (u.pathname === '/v2/checkout/orders') return res(200, { id: 'ORD1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'self', href: 'x' }, { rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORD1' }] })
    if (u.pathname === '/v2/checkout/orders/ORD1/capture') return res(201, { id: 'ORD1', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '5.15' } }] } }] })
    if (u.pathname === '/v2/payments/captures/CAP1/refund') return res(201, { id: 'REF1', status: 'COMPLETED' })
    return res(404, { name: 'RESOURCE_NOT_FOUND' })
  })
  return { f, calls }
}

let db: FakeD1
let env: Env
let ai: ReturnType<typeof fakeAi>
let pp: ReturnType<typeof fakePayPal>
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
let cookie = ''

async function hit(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('CF-Connecting-IP', '203.0.113.7')
  if (cookie) headers.set('Cookie', cookie)
  return handle(new Request('https://rt.example' + path, { ...init, headers }), env, ctx)
}

beforeEach(() => {
  db = fakeD1()
  ai = fakeAi()
  pp = fakePayPal()
  vi.stubGlobal('fetch', pp.f)
  env = {
    DB: db, RT_KV: fakeKV(), AI: ai, ASSETS: { fetch: async () => new Response('desk') } as unknown as Fetcher,
    PAYPAL_BASE: 'https://api-m.sandbox.paypal.com', AI_MODE: 'live', PAYPAL_CLIENT_ID: CLIENT_ID, PAYPAL_CLIENT_SECRET: CLIENT_SECRET,
    SESSION_SECRET: 'session-secret-for-tests',
  }
  cookie = ''
})
afterEach(() => { vi.unstubAllGlobals() })

describe('the scripted demo, end to end through the routes', () => {
  it('has thirty calls with faults on 9, 14, 21 and a retry pair on 23 and 24', () => {
    expect(SCRIPT).toHaveLength(30)
    expect(SCRIPT.map((s, i) => (s.fault ? `${i + 1}:${s.fault}` : '')).filter(Boolean)).toEqual(['9:empty', '14:error', '21:off', '23:slow'])
    expect(SCRIPT[22].args).toEqual(SCRIPT[23].args)
  })

  it('runs up the tab, strikes three calls, pays it through PayPal, refunds call 24 and explains the bill', async () => {
    const s = await hit('/api/session', { method: 'POST' })
    expect(s.status).toBe(200)
    cookie = s.headers.get('Set-Cookie')!.split(';')[0]

    const run = await (await hit('/api/demo/run', { method: 'POST', body: '{}' })).json() as any
    const steps = run.steps as any[]
    expect(steps).toHaveLength(31)
    const by = (n: number) => steps[n - 1]
    expect([by(9).reason_code, by(14).reason_code, by(21).reason_code]).toEqual(['EMPTY', 'ERROR', 'OFF_REQUEST'])
    expect([by(9).status, by(14).status, by(21).status]).toEqual(['STRUCK', 'STRUCK', 'STRUCK'])
    expect(by(29).tab_state).toBe('OPEN')
    expect(by(30)).toMatchObject({ total_cents: 515, tab_state: 'DUE' })
    expect(by(31).status).toBe('TAB_DUE')
    expect(run.due.amount).toBe('5.15')
    const judged = await db.prepare("SELECT judged_by FROM calls WHERE seq = 21").first<string>('judged_by')
    expect(judged).toBe('model')

    const pay = await hit(new URL(run.due.pay_url).pathname)
    expect(pay.status).toBe(302)
    expect(pay.headers.get('Location')).toBe('https://www.sandbox.paypal.com/checkoutnow?token=ORD1')
    const order = pp.calls.find((c) => c.path === '/v2/checkout/orders')!
    expect(order.requestId).toMatch(/^rt-order-tab_/)
    const pu = order.body.purchase_units[0]
    expect(pu.custom_id).toMatch(/^rt:[a-f0-9]{64}$/)
    expect(pu.invoice_id).toMatch(/^rt-tab_/)
    expect(pu.amount.value).toBe('5.15')
    expect(pu.items.map((i: any) => [i.name, i.quantity, i.unit_amount.value])).toEqual([['convert_time calls', '19', '0.25'], ['business_days calls', '8', '0.05']])
    expect(pu.description).toBe('27 calls billed for $5.15. 3 calls were struck and not billed.')

    const ret = await hit('/paypal/return?token=ORD1&PayerID=TESTPAYER')
    expect(ret.status).toBe(302)
    expect(ret.headers.get('Location')).toMatch(/paid=1/)

    const after = await (await hit('/api/demo/run', { method: 'POST', body: '{"phase":"after_pay"}' })).json() as any
    expect(after.claim).toMatchObject({ state: 'REFUNDED', refund_id: 'REF1' })
    const refund = pp.calls.find((c) => c.path.endsWith('/refund'))!
    expect(refund.body.amount).toEqual({ currency_code: 'USD', value: '0.25' })
    expect(after.explain.cited_call_ids).toEqual([])
    expect(after.explain.answer).toContain('net paid is $4.90')
    expect(after.next).toMatchObject({ seq: 31, status: 'BILLABLE', tab_state: 'OPEN' })

    const desk = await (await hit('/api/desk/data')).json() as any
    expect(desk.money).toMatchObject({ captured_cents: 515, refunded_cents: 25, net_cents: 490, struck_cents: 35 })
    expect(desk.claims[0]).toMatchObject({ call_seq: 24, reason_code: 'DUPLICATE', state: 'REFUNDED' })
    // 7 distinct convert_time requests are audited; repeats come from the cache.
    expect(ai.jobs.filter((j) => j === 'audit')).toHaveLength(7)

    // No trace row and no stored row anywhere holds a key, the secret or the token.
    const dump = JSON.stringify((await db.prepare('SELECT * FROM trace').all()).results) + JSON.stringify(desk)
    for (const bad of [CLIENT_ID, CLIENT_SECRET, 'A21_TEST_TOKEN', 'Bearer', 'Basic ']) expect(dump).not.toContain(bad)
  }, 20_000)

  it('refuses the desk without a workspace cookie, and an MCP call with an unknown key', async () => {
    expect((await hit('/api/desk/data')).status).toBe(401)
    const r = await hit('/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer rt_agent_nope' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    })
    const sid = r.headers.get('MCP-Session-Id')!
    const c = await hit('/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer rt_agent_nope', 'MCP-Session-Id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'my_tab', arguments: {} } }),
    })
    const j = await c.json() as any
    expect(j.result.isError).toBe(true)
    expect(j.result.content[0].text).toMatch(/Unknown agent key/)
  })
})
