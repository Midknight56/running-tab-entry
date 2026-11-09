// The outcome table in docs/IMPACT-CASE.md, computed from one fixed scenario: the scripted demo (faults injected, call 24
// a simulated retry), then the 30 labelled answers the live attack table sends. No network; fixed model verdicts.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { handle } from '../src/worker'
import { SCRIPT } from '../src/demo/agent'
import type { Env } from '../src/env'
import { fakeD1, fakeKV, type FakeD1 } from './helpers/d1'
import { IMPACT_CASE } from './impact-case.expected'

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
        // Fixed verdicts, the same ones the recorded live eval gave: off topic and injected answers struck as
        // OFF_REQUEST, vague answers struck as INCOMPLETE, everything else kept. Wrong times never reach the model.
        if (String(user.answer).includes('weather')) return reply({ call_id: user.call_id, verdict: 'strike', reason_code: 'OFF_REQUEST', evidence: 'London has mild weather this week' })
        if (String(user.answer).includes('It depends')) return reply({ call_id: user.call_id, verdict: 'strike', reason_code: 'INCOMPLETE', evidence: 'It depends on daylight saving' })
        return reply({ call_id: user.call_id, verdict: 'keep', reason_code: '', evidence: '' })
      }
      if (system.startsWith('You judge')) {
        jobs.push('claim')
        return reply({ verdict: 'approve', claim_names: 'DUPLICATE', reason_code: 'DUPLICATE', evidence: '"time":"16:00"', cited_call_ids: [23, 24] })
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


const GROUPS = [
  { label: 'good', count: 6, valid: true }, { label: 'off', count: 4 }, { label: 'incomplete', count: 4 }, { label: 'wrong', count: 4 },
  { label: 'inject', count: 4 }, { label: 'vague', count: 4 }, { label: 'repeat', count: 4, valid: true },
] as const

async function mcp(key: string) {
  let sid = ''
  let id = 0
  async function rpc(method: string, params: unknown, fault?: string) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }
    if (sid) headers['MCP-Session-Id'] = sid
    if (fault) headers['X-RT-Demo-Fault'] = fault
    const r = await hit('/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
    sid = r.headers.get('MCP-Session-Id') ?? sid
    return r.json() as Promise<any>
  }
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'impact', version: '1' } })
  return (name: string, args: unknown, fault?: string) => rpc('tools/call', { name, arguments: args }, fault)
}

type Label = { valid: boolean; wrongTime?: boolean }

/** Runs the scenario and returns the numbers the doc shows. Labels come from the script and the groups, never from outcomes. */
async function scenario() {
  const s = await hit('/api/session', { method: 'POST' })
  cookie = s.headers.get('Set-Cookie')!.split(';')[0]
  const agent = (await s.json() as any).agents[0]
  const run = await (await hit('/api/demo/run', { method: 'POST', body: '{}' })).json() as any
  await hit(new URL(run.due.pay_url).pathname)
  await hit('/paypal/return?token=ORD1&PayerID=TESTPAYER')
  await (await hit('/api/demo/run', { method: 'POST', body: '{"phase":"after_pay"}' })).json()
  const desk = await (await hit('/api/desk/data')).json() as any

  // Demo labels: the three injected faults and the retry on call 24 are bad; every other call is valid.
  const label = new Map<number, Label>()
  SCRIPT.forEach((step, i) => label.set(i + 1, { valid: !['empty', 'error', 'off'].includes(step.fault ?? '') && i + 1 !== 24 }))
  label.set(31, { valid: true })

  const call = await mcp(agent.key)
  const repeated = { time: '08:00', date: '2026-01-01', from: 'America/Halifax', to: 'Europe/London' }
  for (const [index, group] of GROUPS.entries()) {
    for (let i = 0; i < group.count; i++) {
      const args = group.label === 'repeat' ? repeated : {
        time: `${String(8 + i).padStart(2, '0')}:00`, date: `2026-${String(index + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`,
        from: 'America/Halifax', to: 'Europe/London',
      }
      const r = await call('convert_time', args, 'valid' in group ? undefined : group.label)
      const seq = r.result?._meta?.['running-tab/call']?.seq
      expect(seq, `${group.label} ${i + 1}`).toBeTypeOf('number')
      label.set(seq, { valid: 'valid' in group, wrongTime: group.label === 'wrong' })
    }
  }

  const rows = (await db.prepare('SELECT seq, status, judged_by, price_cents FROM calls WHERE agent_id = ?').bind(agent.id).all<any>()).results
  expect(rows).toHaveLength(label.size)
  const sum = (list: any[]) => list.reduce((n, r) => n + r.price_cents, 0)
  const of = (pred: (r: any, l: Label) => boolean) => rows.filter((r) => pred(r, label.get(r.seq)!))
  const charged = (r: any) => r.status === 'BILLABLE'
  return {
    receipt: {
      metered_cents: desk.receipt.metered_cents, struck_cents: desk.receipt.struck_cents, captured_cents: desk.receipt.captured_cents,
      refunded_cents: desk.receipt.refunded_cents, net_cents: desk.receipt.net_cents,
    },
    calls: { priced: rows.length, valid: of((_, l) => l.valid).length, bad: of((_, l) => !l.valid).length, wrong_times: of((_, l) => !!l.wrongTime).length },
    plain_meter: {
      charged_cents: sum(rows), excluded_before_payment_cents: 0, refunded_after_payment_cents: 0,
      valid_calls_charged: of((_, l) => l.valid).length, bad_answers_charged: of((_, l) => !l.valid).length,
      wrong_times_charged: of((_, l) => !!l.wrongTime).length, held_calls: 0,
    },
    running_tab: {
      charged_cents: sum(rows.filter(charged)),
      excluded_before_payment_cents: sum(rows.filter((r) => r.status === 'STRUCK')),
      refunded_after_payment_cents: sum(rows.filter((r) => r.status === 'REFUNDED')),
      valid_calls_charged: of((r, l) => l.valid && charged(r)).length,
      bad_answers_charged: of((r, l) => !l.valid && charged(r)).length,
      wrong_times_charged: of((r, l) => !!l.wrongTime && charged(r)).length,
      held_calls: rows.filter((r) => r.status === 'PENDING_AUDIT').length,
    },
    decided_by: {
      code: rows.filter((r) => r.status === 'STRUCK' && r.judged_by === 'code').length,
      recorded_model_verdict: rows.filter((r) => r.status === 'STRUCK' && r.judged_by === 'model').length,
      claim: rows.filter((r) => r.status === 'REFUNDED').length,
    },
  }
}

it('computes the outcome table in docs/IMPACT-CASE.md from one fixed scenario', async () => {
  const got = await scenario()
  expect(got.receipt).toEqual({ metered_cents: 550, struck_cents: 35, captured_cents: 515, refunded_cents: 25, net_cents: 490 })
  expect(got.plain_meter.wrong_times_charged).toBe(4)
  expect(got.running_tab).toMatchObject({ wrong_times_charged: 0, bad_answers_charged: 0, held_calls: 0, valid_calls_charged: got.calls.valid })
  expect(got).toEqual(IMPACT_CASE)
}, 30_000)

it('docs/IMPACT-CASE.md shows the same numbers as the test', () => {
  const doc = readFileSync(resolve(__dirname, '../docs/IMPACT-CASE.md'), 'utf8')
  const money = (c: number) => `$${(c / 100).toFixed(2)}`
  const p = IMPACT_CASE.plain_meter
  const t = IMPACT_CASE.running_tab
  const n = IMPACT_CASE.calls
  for (const line of [
    `| Charged | ${money(p.charged_cents)} | ${money(t.charged_cents)} |`,
    `| Money excluded before payment | ${money(p.excluded_before_payment_cents)} | ${money(t.excluded_before_payment_cents)} |`,
    `| Money refunded after payment | ${money(p.refunded_after_payment_cents)} | ${money(t.refunded_after_payment_cents)} |`,
    `| Valid calls charged | ${p.valid_calls_charged} of ${n.valid} | ${t.valid_calls_charged} of ${n.valid} |`,
    `| Bad answers left charged | ${p.bad_answers_charged} of ${n.bad} | ${t.bad_answers_charged} of ${n.bad} |`,
    `| Wrong times charged | ${p.wrong_times_charged} of ${n.wrong_times} | ${t.wrong_times_charged} of ${n.wrong_times} |`,
    `| Held calls | ${p.held_calls} | ${t.held_calls} |`,
    `| Code | ${IMPACT_CASE.decided_by.code} |`,
    `| Recorded model verdict | ${IMPACT_CASE.decided_by.recorded_model_verdict} |`,
    `| Claim | ${IMPACT_CASE.decided_by.claim} |`,
  ]) expect(doc).toContain(line)
})
