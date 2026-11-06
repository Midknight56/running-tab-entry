import { afterEach, describe, expect, it } from 'vitest'
import { desk } from './helpers/connect'
import { agentKey, sha256Hex } from '../src/demo/workspace'
import { utcDay } from '../src/ai/budget'

let d: Awaited<ReturnType<typeof desk>>
afterEach(() => d?.db.raw.close())
async function key() {
  d = await desk()
  const r = await d.connect()
  expect(r.status).toBe(200)
  const k = await r.json() as any
  await d.rpc(k.key, 'initialize', { protocolVersion: '2025-11-25' })
  return k
}
const words = (r: any) => JSON.stringify(r)
describe('connect keys', () => {
  it('requires the workspace cookie', async () => {
    d = await desk()
    expect((await d.hit('/api/connect', { method: 'POST' })).status).toBe(401)
  })
  it('returns a random scoped key once and limits the desk to two keys', async () => {
    const k = await key()
    expect(k).toMatchObject({ name: 'Your agent', mcp_url: 'https://rt.example/mcp' })
    expect(k.key).toMatch(/^rt_agent_[A-Za-z0-9_\-]{43}$/)
    expect(k.key).not.toBe(await agentKey(d.env.SESSION_SECRET, k.agent_id))
    expect(k.expires_at - Date.now()).toBeGreaterThan(7190000)
    const stored = await d.db.prepare('SELECT * FROM agents WHERE id = ?').bind(k.agent_id).first<any>()
    expect(stored).toMatchObject({ kind: 'judge', expires_at: k.expires_at, key_hash: await sha256Hex(k.key) })
    expect(JSON.stringify(stored)).not.toContain(k.key)
    expect((await d.call(k.key)).result._meta['running-tab/call'].status).toBe('BILLABLE')
    const s = await d.hit('/api/session', { method: 'POST', headers: { Cookie: d.cookie } })
    const session = await s.json() as any
    expect(session.agents).toHaveLength(2)
    expect(JSON.stringify(session)).not.toContain(k.key)
    expect(await (await d.connect()).json()).toMatchObject({ name: 'Your agent 2' })
    const third = await d.connect()
    expect(third.status).toBe(429)
    expect(await third.json()).toEqual({ error: 'Two agent keys per demo desk. Start a new desk tomorrow.' })
  })
  it('refuses expired keys on lists and calls including free tools', async () => {
    const k = await key()
    d.advance()
    for (const result of [await d.rpc(k.key, 'initialize'), await d.rpc(k.key, 'ping'), await d.rpc(k.key, 'tools/list'), await d.call(k.key), await d.call(k.key, 'my_tab', {})]) {
      expect(words(result)).toContain('This agent key has expired. Get a new one from the desk.')
    }
  })
  it('stops after two paid tabs but keeps free tools and due pay links working', async () => {
    const k = await key()
    for (let i = 0; i < 2; i++) await d.db.prepare("INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, created_at) VALUES (?, ?, ?, 'PAID', 500, 500, ?)").bind(`tab_${i}`, d.workspace.ws_id, k.agent_id, i).run()
    expect(words(await d.call(k.key))).toContain('This key has run up its two tabs. Get a new key from the desk.')
    expect((await d.call(k.key, 'my_tab', {})).result.isError).not.toBe(true)
    await d.db.prepare("UPDATE tabs SET state = 'DUE' WHERE id = 'tab_1'").run()
    expect((await d.call(k.key)).result.structuredContent).toMatchObject({ code: 'TAB_DUE', pay_url: 'https://rt.example/pay/tab_1' })
  })
  it('allows 100 priced calls for judge keys and keeps 400 for demo keys', async () => {
    const k = await key()
    for (const [id, limit, token] of [[k.agent_id, 100, k.key], [d.workspace.agents[0].id, 400, d.workspace.agents[0].key]] as const) {
      await d.db.prepare('INSERT INTO counters (key, n) VALUES (?, ?)').bind(`agent:${id}:${utcDay()}:calls`, limit - 1).run()
      expect((await d.call(token)).result.isError).not.toBe(true)
      expect(words(await d.call(token))).toContain(`used its ${limit} calls`)
      expect((await d.call(token, 'my_tab', {})).result.isError).not.toBe(true)
    }
  })
  it('settles the key allowance and refunds app and network reservations when it refuses', async () => {
    const k = await key()
    d.env.AI_MODE = 'live'
    let runs = 0
    d.env.AI = { run: async (_model: unknown, input: any) => {
      runs++
      const request = JSON.parse(input.messages.at(-1).content)
      return { response: JSON.stringify({ call_id: request.call_id, verdict: 'keep', reason_code: '', evidence: '' }), usage: { neurons: 10 } }
    } } as any
    for (let i = 0; i < 8; i++) {
      const r = await d.call(k.key, 'convert_time', { time: `0${i}:17`, date: '2026-10-28', from: 'America/Halifax', to: 'Europe/London' })
      expect(r.result._meta['running-tab/call'].status).toBe(i < 5 ? 'BILLABLE' : 'PENDING_AUDIT')
    }
    expect(runs).toBe(5)
    const counters = (await d.db.prepare('SELECT key, n FROM counters').all<{ key: string; n: number }>()).results
    expect(counters.find(c => c.key === `key:${k.agent_id}:${utcDay()}`)?.n).toBeCloseTo(50)
    expect(counters.find(c => c.key === `neurons:${utcDay()}`)?.n).toBeCloseTo(50)
    expect(counters.find(c => c.key.startsWith('visitor:'))?.n).toBeCloseTo(50)
  })
})


it.each([{ monthly_cents: -1 }, { monthly_cents: 100001 }, { monthly_cents: 0.5 }, { monthly_cents: '500' }, { max_call_cents: 10001 }, { max_call_cents: null }])('connect rejects bad budgets %j', async body => {
  d = await desk()
  const r = await d.hit('/api/connect', { method: 'POST', headers: { Cookie: d.cookie }, body: JSON.stringify(body) })
  expect(r.status).toBe(400)
  expect((await r.json() as any).error).toMatch(/whole cents/)
  expect(await d.db.prepare("SELECT COUNT(*) AS n FROM agents WHERE kind = 'judge'").first('n')).toBe(0)
})
it.each([{ monthly_cents: 0, max_call_cents: 0 }, { monthly_cents: 100000, max_call_cents: 10000 }])('connect stores valid budgets %j', async body => {
  d = await desk()
  const r = await d.hit('/api/connect', { method: 'POST', headers: { Cookie: d.cookie }, body: JSON.stringify(body) })
  expect(r.status).toBe(200)
  const k = await r.json() as any
  expect(await d.db.prepare('SELECT budget_month_cents, budget_call_cents FROM agents WHERE id = ?').bind(k.agent_id).first()).toEqual({ budget_month_cents: body.monthly_cents, budget_call_cents: body.max_call_cents })
  const data = await (await d.hit('/api/desk/data', { headers: { Cookie: d.cookie } })).json() as any
  expect(data.agents.find((a: any) => a.id === k.agent_id)).toMatchObject({ budget_month_cents: body.monthly_cents, budget_call_cents: body.max_call_cents, spent_cents: 0 })
})
