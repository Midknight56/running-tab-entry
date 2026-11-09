import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handle } from '../src/worker'
import { deskData } from '../src/desk-data'
import { signWs } from '../src/demo/workspace'
import type { Env } from '../src/env'
import { fakeD1, fakeKV, type FakeD1 } from './helpers/d1'

const ctx = { waitUntil() {} } as unknown as ExecutionContext
let db: FakeD1
let env: Env
let cookie: string
const saved = { selectedPageId: 'seller', pages: [{ id: 'seller', widgets: {}, widgetLayout: {} }] }

async function hit(method = 'GET', body?: string, session = cookie, headers = {}) {
  return handle(new Request('https://rt.example/api/desk/report', { method, body, headers: { Cookie: session, ...headers } }), env, ctx, () => 12345)
}

beforeEach(async () => {
  db = fakeD1()
  env = {
    DB: db, RT_KV: fakeKV(), SESSION_SECRET: 'report-test-secret', AI_MODE: 'replay',
    AI: { run: async () => ({ response: '{}' }) } as any,
    ASSETS: { fetch: async () => new Response('desk') } as unknown as Fetcher,
    PAYPAL_BASE: 'https://example.test', PAYPAL_CLIENT_ID: 'test', PAYPAL_CLIENT_SECRET: 'test',
  }
  await db.prepare("INSERT INTO workspaces (id, created_at, ip_day_hash) VALUES ('one', 1, 'test'), ('two', 1, 'test')").run()
  cookie = `rt_ws=${encodeURIComponent(await signWs(env.SESSION_SECRET, 'one'))}`
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request') }))
})
afterEach(() => { vi.unstubAllGlobals(); db.raw.close() })

describe('desk reports', () => {
  it.each(['GET', 'PUT'])('requires a workspace cookie for %s', async method => {
    expect((await hit(method, method === 'PUT' ? JSON.stringify(saved) : undefined, '')).status).toBe(401)
  })

  it('returns 204 until saved and restores only the same workspace', async () => {
    expect((await hit()).status).toBe(204)
    expect((await hit('PUT', JSON.stringify(saved))).status).toBe(200)
    expect(await (await hit()).json()).toEqual(saved)
    const other = `rt_ws=${encodeURIComponent(await signWs(env.SESSION_SECRET, 'two'))}`
    expect((await hit('GET', undefined, other)).status).toBe(204)
    const next = { ...saved, selectedPageId: 'changed' }
    expect((await hit('PUT', JSON.stringify(next))).status).toBe(200)
    expect(await (await hit()).json()).toEqual(next)
    expect(await db.prepare('SELECT updated_at FROM desk_reports WHERE ws_id = ?').bind('one').first<number>('updated_at')).toBe(12345)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['{}', '{"pages":{}}', '[]', 'null', 'broken'])('refuses a body without a pages array: %s', async body => {
    expect((await hit('PUT', body)).status).toBe(400)
  })

  it('refuses 100 KB or more in actual bytes even without a length header', async () => {
    const body = JSON.stringify({ pages: [], note: 'é'.repeat(50000) })
    expect(body.length).toBeLessThan(100000)
    expect((await hit('PUT', body)).status).toBe(400)
    expect((await hit('PUT', JSON.stringify({ pages: [] }), cookie, { 'Content-Length': '100001' })).status).toBe(400)
  })

  it('leaves the last saved report intact after refusing a body', async () => {
    await hit('PUT', JSON.stringify(saved))
    await hit('PUT', '{}')
    expect(await (await hit()).json()).toEqual(saved)
  })
})

it('returns the newest 2000 calls and the complete workspace call count', async () => {
  db.raw.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 2001)
    INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
    SELECT 'c' || x, x, 'one', 'a', 't', 'tool', '{}', '{}', 1, 'BILLABLE', x FROM n`)
  db.raw.exec(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
    VALUES ('other', 1, 'two', 'b', 'u', 'tool', '{}', '{}', 1, 'BILLABLE', 9999)`)
  const data = await deskData(db, 'one')
  expect(data.calls).toHaveLength(2000)
  expect(data).toMatchObject({ calls_total: 2001 })
  expect(data.calls[0].seq).toBe(2001)
  expect(data.calls.at(-1)?.seq).toBe(2)
})

it('scopes money totals to the receipt, open tab, and session', async () => {
  await db.prepare('INSERT INTO agents (id, ws_id, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?)').bind('a', 'one', 'Scheduler bot', 'hash', 1).run()
  await db.prepare(`INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, order_id, capture_id, captured_cents, refunded_cents, note, created_at, due_at, paid_at)
    VALUES ('tab_paid', 'one', 'a', 'PAID', 515, 500, 'ORD1', 'CAP1', 515, 25, NULL, 10, 15, 20)`).run()

  for (let i = 1; i <= 8; i++) {
    await db.prepare(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
      VALUES (?, ?, 'one', 'a', 'tab_paid', 'business_days', '{}', '{}', 5, 'BILLABLE', ?)`).bind(`c${i}`, i, i).run()
  }
  for (let i = 9; i <= 27; i++) {
    await db.prepare(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
      VALUES (?, ?, 'one', 'a', 'tab_paid', 'convert_time', '{}', '{}', 25, 'BILLABLE', ?)`).bind(`c${i}`, i, i).run()
  }
  await db.prepare(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
    VALUES ('c28', 28, 'one', 'a', 'tab_paid', 'convert_time', '{}', '{}', 25, 'STRUCK', 28)`).run()
  await db.prepare(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
    VALUES ('c29', 29, 'one', 'a', 'tab_paid', 'business_days', '{}', '{}', 5, 'STRUCK', 29)`).run()
  await db.prepare(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
    VALUES ('c30', 30, 'one', 'a', 'tab_paid', 'business_days', '{}', '{}', 5, 'STRUCK', 30)`).run()

  await db.prepare(`INSERT INTO claims (id, ws_id, call_id, reason_text, verdict, reason_code, refund_id, refund_status, state, created_at)
    VALUES ('k1', 'one', 'c24', 'dup', 'approve', 'DUPLICATE', 'REF1', 'COMPLETED', 'REFUNDED', 25)`).run()

  await db.prepare(`INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, order_id, capture_id, captured_cents, refunded_cents, note, created_at, due_at, paid_at)
    VALUES ('tab_open', 'one', 'a', 'OPEN', 25, 500, NULL, NULL, 0, 0, NULL, 30, NULL, NULL)`).run()
  await db.prepare(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
    VALUES ('c31', 31, 'one', 'a', 'tab_open', 'convert_time', '{}', '{}', 25, 'BILLABLE', 31)`).run()

  const data = await deskData(db, 'one') as any
  expect(data.receipt).toEqual({
    tab_id: 'tab_paid',
    agent_id: 'a',
    agent_name: 'Scheduler bot',
    order_id: 'ORD1',
    capture_id: 'CAP1',
    metered_cents: 550,
    struck_cents: 35,
    captured_cents: 515,
    refunded_cents: 25,
    refund_pending_cents: 0,
    net_cents: 490,
  })
  expect(data.open_tab).toEqual({
    tab_id: 'tab_open',
    agent_id: 'a',
    state: 'OPEN',
    total_cents: 25,
    calls: 1,
  })
  expect(data.session).toEqual({
    metered_cents: 575,
    kept_or_billable_cents: 515,
    struck_cents: 35,
    refunded_cents: 25,
    pending_audit_cents: 0,
  })

  await db.prepare(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
    VALUES ('c32', 32, 'one', 'a', 'tab_open', 'convert_time', '{}', '{}', 25, 'BILLABLE', 32)`).run()
  await db.prepare('UPDATE tabs SET total_cents = 50 WHERE id = ?').bind('tab_open').run()

  const afterCall = await deskData(db, 'one') as any
  expect(afterCall.session.metered_cents).toBe(600)
  expect(afterCall.session.kept_or_billable_cents).toBe(540)
  expect(afterCall.receipt.net_cents).toBe(490)
  expect(afterCall.open_tab.total_cents).toBe(50)
  expect(afterCall.open_tab.calls).toBe(2)
})

it('flags a due tab whose card payment was sent but got no answer', async () => {
  await db.prepare('INSERT INTO agents (id, ws_id, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?)').bind('a', 'one', 'Scheduler bot', 'hash', 1).run()
  for (const id of ['tab_lost', 'tab_fresh', 'tab_plain']) {
    await db.prepare(`INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, order_id, capture_id, captured_cents, refunded_cents, note, created_at, due_at, paid_at)
      VALUES (?, 'one', 'a', 'DUE', 515, 500, NULL, NULL, 0, 0, NULL, 10, 15, NULL)`).bind(id).run()
  }
  const old = Date.now() - 60_000
  await db.prepare(`INSERT INTO pay_attempts (tab_id, ws_id, method, request_id, body_json, state, created_at, updated_at, send_count)
    VALUES ('tab_lost', 'one', 'card', 'r1', '{}', 'SENT', ?, ?, 1)`).bind(old, old).run()
  await db.prepare(`INSERT INTO pay_attempts (tab_id, ws_id, method, request_id, body_json, state, created_at, updated_at, send_count)
    VALUES ('tab_fresh', 'one', 'card', 'r2', '{}', 'SENT', ?, ?, 0)`).bind(Date.now(), Date.now()).run()
  const data = await deskData(db, 'one') as any
  const flag = (id: string) => data.tabs.find((t: any) => t.id === id).payment_checking
  expect(flag('tab_lost')).toBe(true)
  expect(flag('tab_fresh')).toBe(false)
  expect(flag('tab_plain')).toBe(false)
})

it('picks the receipt and the current tab of the first agent, the same tab the desk bill shows, with two agents and two paid tabs', async () => {
  await db.prepare('INSERT INTO agents (id, ws_id, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?)').bind('a', 'one', 'Scheduler bot', 'hash', 1).run()
  await db.prepare('INSERT INTO agents (id, ws_id, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?)').bind('b', 'one', 'Travel desk agent', 'hash-b', 2).run()
  await db.prepare(`INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, order_id, capture_id, captured_cents, refunded_cents, note, created_at, due_at, paid_at)
    VALUES ('tab_a', 'one', 'a', 'PAID', 500, 500, 'ORDA', 'CAPA', 500, 0, NULL, 10, 15, 20),
           ('tab_b', 'one', 'b', 'PAID', 505, 500, 'ORDB', 'CAPB', 505, 0, NULL, 30, 35, 40),
           ('tab_a2', 'one', 'a', 'OPEN', 25, 500, NULL, NULL, 0, 0, NULL, 50, NULL, NULL),
           ('tab_b2', 'one', 'b', 'OPEN', 5, 500, NULL, NULL, 0, 0, NULL, 60, NULL, NULL)`).run()
  await db.prepare(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
    VALUES ('ca1', 1, 'one', 'a', 'tab_a', 'convert_time', '{}', '{}', 500, 'BILLABLE', 11),
           ('cb1', 1, 'one', 'b', 'tab_b', 'convert_time', '{}', '{}', 505, 'BILLABLE', 31),
           ('ca2', 2, 'one', 'a', 'tab_a2', 'convert_time', '{}', '{}', 25, 'BILLABLE', 51),
           ('cb2', 2, 'one', 'b', 'tab_b2', 'business_days', '{}', '{}', 5, 'BILLABLE', 61)`).run()
  const data = await deskData(db, 'one') as any
  expect(data.receipt).toMatchObject({ tab_id: 'tab_a', agent_id: 'a', agent_name: 'Scheduler bot', capture_id: 'CAPA', captured_cents: 500 })
  expect(data.money.receipt).toEqual(data.receipt)
  expect(data.open_tab).toMatchObject({ tab_id: 'tab_a2', agent_id: 'a', total_cents: 25 })
  expect(data.receipts.map((r: any) => [r.tab_id, r.agent_name, r.capture_id])).toEqual([['tab_b', 'Travel desk agent', 'CAPB'], ['tab_a', 'Scheduler bot', 'CAPA']])
})
