import { beforeEach, describe, expect, it } from 'vitest'
import type { Tool } from 'mcp-on-workers'
import { handle } from '../../src/worker'
import { AGENT_CALLS_PER_DAY } from '../../src/app'
import { utcDay } from '../../src/ai/budget'
import { explainBillTool, myTab, reportBadAnswer } from '../../src/tab/agent-tools'
import { withTab, type TabCtx } from '../../src/tab/with-tab'
import { createAgent, currentTab, recordCall, callsOfTab, type Call } from '../../src/tab/ledger'
import { buildOrder, lineItems } from '../../src/bill/order-builder'
import { fileClaim } from '../../src/claims/claims'
import type { Tab } from '../../src/tab/ledger'
import type { Env } from '../../src/env'
import { fakeD1, fakeKV, type FakeD1 } from '../helpers/d1'

let db: FakeD1
let ctx: TabCtx
let tick = 1000
const execution = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

const echo: Tool<TabCtx> = {
  name: 'echo', title: 'Echo', description: 'Returns a value.',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  async run(args) { return { content: [{ type: 'text', text: String(args.value ?? 'ok') }] } },
}

function call(seq: number, status: Call['status'], price_cents: number): Call {
  return { id: `call_${seq}`, seq, ws_id: 'ws_a', agent_id: 'agent_a', tab_id: 'tab_order', tool: 'echo', args_json: '{}', result_json: '{}', price_cents, status, reason_code: null, evidence: null, judged_by: null, duration_ms: 1, created_at: seq }
}

function orderTab(total_cents: number): Tab {
  return { id: 'tab_order', ws_id: 'ws_a', agent_id: 'agent_a', state: 'DUE', total_cents, threshold_cents: 100, order_id: null, capture_id: null, captured_cents: 0, refunded_cents: 0, note: null, created_at: 1, due_at: 2, paid_at: null }
}

beforeEach(async () => {
  db = fakeD1()
  tick = 1000
  const agent = await createAgent(db, 'ws_a', 'Agent A', 'hash_a', tick, 'agent_a')
  ctx = { tab: { db, agent, origin: 'https://rt.example', thresholdCents: 100, now: () => tick++ } }
})

describe('billing attacks', () => {
  it('assigns distinct call numbers to simultaneous calls from one agent', async () => {
    const tool = withTab(echo, { price_cents: 3 })
    const results = await Promise.all([tool.run({ value: 'one' }, ctx), tool.run({ value: 'two' }, ctx)])
    const seqs = results.map((r) => (r as any)._meta['running-tab/call'].seq).sort()
    expect(seqs).toEqual([1, 2])
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tabs').first<number>('n')).toBe(1)
    expect(await db.prepare('SELECT total_cents FROM tabs').first<number>('total_cents')).toBe(6)
  })

  // A repeated JSON-RPC request is a new request: MCP gives no idempotency promise, and the demo agent restarts its ids
  // at 1 on every run. So it is billed once more, as its own numbered call, and never merged into or harms the first.
  it('bills a repeated MCP request as its own call, once', async () => {
    const env: Env = {
      DB: db, RT_KV: fakeKV(), AI: { run: async () => ({ response: '{}' }) } as unknown as Ai,
      ASSETS: { fetch: async () => new Response('desk') } as unknown as Fetcher,
      PAYPAL_BASE: 'https://api-m.sandbox.paypal.com', AI_MODE: 'replay', PAYPAL_CLIENT_ID: 'cid_test',
      PAYPAL_CLIENT_SECRET: 'secret_test', SESSION_SECRET: 'billing-test-secret',
    }
    const post = (path: string, body: unknown, key?: string, sid?: string) => handle(new Request(`https://rt.example${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(sid ? { 'MCP-Session-Id': sid } : {}) }, body: JSON.stringify(body),
    }), env, execution)
    const session = await post('/api/session', {})
    const workspace = await session.json() as { agents: { key: string }[] }
    const key = workspace.agents[0].key
    const beforeCalls = await db.prepare('SELECT COUNT(*) AS n FROM calls').first<number>('n')
    const beforeTotal = await db.prepare('SELECT COALESCE(SUM(total_cents), 0) AS n FROM tabs').first<number>('n')
    const init = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }, key)
    const sid = init.headers.get('MCP-Session-Id')!
    const body = { jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'business_days', arguments: { start: '2026-10-01', end: '2026-10-02' } } }
    const first = await post('/mcp', body, key, sid)
    const second = await post('/mcp', body, key, sid)
    expect((await first.json() as any).result.isError).not.toBe(true)
    expect((await second.json() as any).result.isError).not.toBe(true)
    expect((await db.prepare('SELECT COUNT(*) AS n FROM calls').first<number>('n'))! - beforeCalls!).toBe(2)
    expect((await db.prepare('SELECT COALESCE(SUM(total_cents), 0) AS n FROM tabs').first<number>('n'))! - beforeTotal!).toBe(10)
    const seqs = (await db.prepare("SELECT seq FROM calls WHERE tool = 'business_days' ORDER BY created_at DESC LIMIT 2").all<{ seq: number }>()).results
    expect(new Set(seqs.map((r) => r.seq)).size).toBe(2)
  })

  it('stops later calls after one call crosses the threshold during a race', async () => {
    const tool = withTab(echo, { price_cents: 5 })
    const tab = await currentTab(db, ctx.tab.agent, 100, tick++)
    await recordCall(db, { agent: ctx.tab.agent, tab, tool: 'seed', args: {}, result: {}, price_cents: 99, status: 'BILLABLE', duration_ms: 1, now: tick++ })
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => tool.run({ value: String(i) }, ctx)))
    const denied = results.filter((r) => r.structuredContent && (r.structuredContent as any).code === 'TAB_DUE')
    const billed = results.filter((r) => (r as any)._meta?.['running-tab/call']?.status === 'BILLABLE')
    const total = await db.prepare('SELECT total_cents FROM tabs').first<number>('total_cents')
    expect(billed).toHaveLength(1)
    expect(denied).toHaveLength(9)
    expect(total).toBe(104)
    const rows = (await db.prepare("SELECT price_cents FROM calls WHERE status = 'BILLABLE'").all<{ price_cents: number }>()).results
    expect(total).toBe(rows.reduce((sum, row) => sum + row.price_cents, 0))
  })

  it('refuses priced calls after the daily limit and resets on the next UTC day', async () => {
    const env: Env = {
      DB: db, RT_KV: fakeKV(), AI: { run: async () => ({ response: '{}' }) } as unknown as Ai,
      ASSETS: { fetch: async () => new Response('desk') } as unknown as Fetcher,
      PAYPAL_BASE: 'https://api-m.sandbox.paypal.com', AI_MODE: 'replay', PAYPAL_CLIENT_ID: 'cid_test',
      PAYPAL_CLIENT_SECRET: 'secret_test', SESSION_SECRET: 'daily-test-secret',
    }
    const now = Date.UTC(2026, 9, 23, 12)
    const request = (path: string, body: unknown, key?: string, sid?: string, time = now) => handle(new Request(`https://rt.example${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(sid ? { 'MCP-Session-Id': sid } : {}) }, body: JSON.stringify(body),
    }), env, execution, () => time)
    const session = await request('/api/session', {})
    const workspace = await session.json() as { agents: { id: string; key: string }[] }
    const { id, key } = workspace.agents[0]
    const init = await request('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }, key)
    const sid = init.headers.get('MCP-Session-Id')!
    const dayKey = `agent:${id}:${utcDay(now)}:calls`
    await db.prepare('INSERT INTO counters (key, n) VALUES (?, ?)').bind(dayKey, AGENT_CALLS_PER_DAY - 1).run()
    const call = (name: string, args: Record<string, unknown> = {}, time = now) => request('/mcp', { jsonrpc: '2.0', id: Math.random(), method: 'tools/call', params: { name, arguments: args } }, key, sid, time)
    const last = await call('business_days', { start: '2026-10-01', end: '2026-10-02' })
    expect((await last.json() as any).result.isError).not.toBe(true)
    const refused = await call('business_days', { start: '2026-10-01', end: '2026-10-02' })
    expect((await refused.json() as any).result.content[0].text).toContain('used its 400 calls for today')
    const free = await call('my_tab')
    expect((await free.json() as any).result.isError).not.toBe(true)
    const tomorrow = await call('business_days', { start: '2026-10-01', end: '2026-10-02' }, now + 86400000)
    expect((await tomorrow.json() as any).result.isError).not.toBe(true)
  })

  it('keeps one workspace key out of another workspace tab and calls', async () => {
    const agentB = await createAgent(db, 'ws_b', 'Agent B', 'hash_b', tick++, 'agent_b')
    const tabB = await currentTab(db, agentB, 100, tick++)
    await recordCall(db, { agent: agentB, tab: tabB, tool: 'echo', args: {}, result: {}, price_cents: 5, status: 'BILLABLE', duration_ms: 1, now: tick++ })
    await recordCall(db, { agent: agentB, tab: tabB, tool: 'echo', args: {}, result: {}, price_cents: 5, status: 'BILLABLE', duration_ms: 1, now: tick++ })
    const tabForA = { ...ctx.tab, explain: async () => ({ answer: 'private', cited: [1] }), claim: async () => ({ message: 'claimed', state: 'OK' }) }
    expect((await myTab.run({}, { tab: tabForA })).structuredContent).toEqual({ state: 'NONE' })
    expect((await explainBillTool.run({ tab_id: tabB.id }, { tab: tabForA })).isError).toBe(true)
    const result = await withTab(echo, { price_cents: 7 }).run({ tab_id: tabB.id, amount: 0, price_cents: 0 }, ctx)
    expect((result as any)._meta['running-tab/call'].tab_id).not.toBe(tabB.id)
    expect(await db.prepare('SELECT total_cents FROM tabs WHERE id = ?').bind(tabB.id).first<number>('total_cents')).toBe(10)
    const claimResult = await reportBadAnswer.run({ call_id: 2, reason: 'wrong answer' }, { tab: { ...tabForA, claim: async (agent, seq, reason) => {
      const r = await fileClaim({ db, pp: { request: async () => ({ status: 500, body: {} }) } as any, judge: async () => null }, agent, seq, reason)
      return { message: r.message, state: r.claim.state, refund_id: r.claim.refund_id }
    } } })
    expect(claimResult.isError).toBe(true)
  })

  it('keeps struck and pending calls out of order items and totals', () => {
    const rows = [call(1, 'BILLABLE', 5), call(2, 'STRUCK', 100), call(3, 'PENDING_AUDIT', 100)]
    expect(lineItems(rows)).toMatchObject({ total_cents: 5, items: [{ sku: 'echo' }] })
    const order = buildOrder(orderTab(5), rows, { urls: { return_url: 'https://rt.example/return', cancel_url: 'https://rt.example/cancel' } })
    expect((order.purchase_units as any[])[0].amount.value).toBe('0.05')
    expect((order.purchase_units as any[])[0].items).toHaveLength(1)
  })

  it('uses the configured price when request arguments contain price or amount fields', async () => {
    const result = await withTab(echo, { price_cents: 7 }).run({ value: 'ok', price_cents: 0, amount: 0, price: 0 }, ctx)
    expect((result as any)._meta['running-tab/call'].price_cents).toBe(7)
    expect(await db.prepare('SELECT price_cents FROM calls').first<number>('price_cents')).toBe(7)
    expect(await db.prepare('SELECT total_cents FROM tabs').first<number>('total_cents')).toBe(7)
  })
})
