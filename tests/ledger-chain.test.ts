import { PayPalClient } from '../src/paypal/client'
import { desk } from './helpers/connect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgent, currentTab, recordCall, recordChainEvent, sealAgent, verifyLedger } from '../src/tab/ledger'
import { fakeD1, type FakeD1 } from './helpers/d1'
import { handle } from '../src/worker'
import { signWs } from '../src/demo/workspace'
import { fakeKV } from './helpers/d1'
import { refundCall } from '../src/claims/refund'

let db: FakeD1
let agent: Awaited<ReturnType<typeof createAgent>>
let tab: Awaited<ReturnType<typeof currentTab>>
let now: number

beforeEach(async () => {
  db = fakeD1()
  await db.prepare('INSERT INTO workspaces (id, created_at, ip_day_hash) VALUES (?, ?, ?)').bind('ws_one', 1, 'ip').run()
  agent = await createAgent(db, 'ws_one', 'Ledger agent', 'key', 1, 'agt_one')
  tab = await currentTab(db, agent, 1000, 1)
  now = 2
})

async function addCall(args: unknown = { q: 1 }, result: unknown = { answer: 1 }, price = 10) {
  return recordCall(db, { agent, tab, tool: 'lookup', args, result, price_cents: price, status: 'BILLABLE', duration_ms: 1, now: now++, signingKey: 'signing key' })
}

describe('signed call ledger', () => {
  it('seals a backlog longer than five calls in one pass', async () => {
    for (let i = 0; i < 12; i++) await addCall({ q: i }, { answer: i })
    await db.prepare('UPDATE calls SET chain_hash = NULL').run()
    await db.prepare('DELETE FROM chain_heads').run()
    await sealAgent(db, agent.id, 'signing key')
    expect(await verifyLedger(db, agent.id, 'signing key')).toMatchObject({ ok: true, entries: 12, first_bad_seq: null })
  })

  it('heals a call whose head was written but whose own hash was not', async () => {
    await addCall()
    await addCall({ q: 2 }, { answer: 2 })
    await db.prepare('UPDATE calls SET chain_hash = NULL WHERE seq = 2').run()
    await sealAgent(db, agent.id, 'signing key')
    expect(await verifyLedger(db, agent.id, 'signing key')).toMatchObject({ ok: true, entries: 2, first_bad_seq: null })
  })

  it('verifies a run of recorded calls', async () => {
    await addCall()
    await addCall({ q: 2 }, { answer: 2 })
    const verified = await verifyLedger(db, agent.id, 'signing key')
    expect(verified).toMatchObject({ ok: true, entries: 2, first_bad_seq: null, signature_ok: true })
    expect(verified.head).toMatch(/[a-f0-9]{64}/)
  })

  it.each([
    ['price', 'UPDATE calls SET price_cents = 99 WHERE seq = 2'],
    ['arguments', `UPDATE calls SET args_json = '{"q":9}' WHERE seq = 2`],
    ['result', `UPDATE calls SET result_json = '{"answer":9}' WHERE seq = 2`],
  ])('reports the changed %s at its call number', async (_field, sql) => {
    await addCall()
    await addCall({ q: 2 }, { answer: 2 })
    await db.prepare(sql).run()
    expect(await verifyLedger(db, agent.id, 'signing key')).toMatchObject({ ok: false, first_bad_seq: 2 })
  })

  it('detects a deleted call row', async () => {
    await addCall()
    await addCall()
    await db.prepare('DELETE FROM calls WHERE seq = 1').run()
    expect(await verifyLedger(db, agent.id, 'signing key')).toMatchObject({ ok: false, first_bad_seq: 1 })
  })

  it('keeps lawful refunds valid and records the refund as a chain event', async () => {
    const { call } = await addCall()
    await db.prepare("UPDATE tabs SET state = 'PAID', capture_id = 'capture_one', captured_cents = 10 WHERE id = ?").bind(tab.id).run()
    await db.prepare("INSERT INTO claims (id, ws_id, call_id, reason_text, state, created_at) VALUES ('claim_one', ?, ?, 'bad answer', 'APPROVED', 4)").bind(agent.ws_id, call.id).run()
    const paidTab = (await db.prepare('SELECT * FROM tabs WHERE id = ?').bind(tab.id).first<any>())!
    const result = await refundCall(db, { request: async () => ({ status: 201, body: { id: 'refund_one', status: 'COMPLETED' } }) } as any, 'claim_one', call, paidTab, 'seller', 'signing key')
    expect(result.ok).toBe(true)
    const verified = await verifyLedger(db, agent.id, 'signing key')
    expect(verified).toMatchObject({ ok: true, entries: 2, signature_ok: true })
    expect(await db.prepare('SELECT kind, reference FROM chain_events').first()).toMatchObject({ kind: 'REFUND', reference: 'refund_one' })
  })

  it('reports a deleted final event head', async () => {
    await addCall()
    await recordChainEvent(db, agent.id, 1, 'REFUND', 'refund_one', now++, 'signing key')
    await db.prepare("DELETE FROM chain_heads WHERE entry_kind = 'EVENT'").run()
    expect(await verifyLedger(db, agent.id, 'signing key')).toMatchObject({ ok: false, first_bad_seq: 1 })
  })

  it('seals concurrent requests once', async () => {
    for (const [seq, payload] of [[1, '{"n":1}'], [2, '{"n":2}']] as const) {
      await db.prepare(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, first_status, created_at)
        VALUES (?, ?, ?, ?, ?, 'lookup', '{}', ?, 10, 'BILLABLE', 'BILLABLE', ?)`)
        .bind(`call_${seq}`, seq, agent.ws_id, agent.id, tab.id, payload, seq).run()
    }
    const { sealAgent } = await import('../src/tab/ledger')
    await Promise.all([sealAgent(db, agent.id, 'signing key'), sealAgent(db, agent.id, 'signing key')])
    expect(await db.prepare('SELECT COUNT(*) AS n FROM chain_heads').first<number>('n')).toBe(2)
    expect((await verifyLedger(db, agent.id, 'signing key')).ok).toBe(true)
  })

  it('seals a call and refund event appended at once into one valid chain', async () => {
    await addCall()
    await db.prepare('INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, first_status, created_at) VALUES (?, 2, ?, ?, ?, ?, ?, ?, 10, ?, ?, ?)')
      .bind('call_two', agent.ws_id, agent.id, tab.id, 'lookup', '{}', '{"answer":2}', 'BILLABLE', 'BILLABLE', now++).run()
    await Promise.all([
      sealAgent(db, agent.id, 'signing key', now++),
      recordChainEvent(db, agent.id, 1, 'REFUND', 'refund_concurrent', now++, 'signing key'),
    ])
    expect(await verifyLedger(db, agent.id, 'signing key')).toMatchObject({ ok: true, signature_ok: true, first_bad_seq: null })
  })

  it('keeps the signing secret out of the response and trace', async () => {
    const secret = 'private signing phrase'
    const cookie = `rt_ws=${encodeURIComponent(await signWs('session secret', 'ws_one'))}`
    const env = {
      DB: db, RT_KV: fakeKV(), AI: { run: async () => ({}) } as any,
      ASSETS: { fetch: async () => new Response('desk') } as any, PAYPAL_BASE: 'https://paypal.invalid', AI_MODE: 'replay' as const,
      PAYPAL_CLIENT_ID: 'client', PAYPAL_CLIENT_SECRET: 'paypal secret', SESSION_SECRET: 'session secret', LEDGER_SIGNING_KEY: secret,
    }
    const response = await handle(new Request('https://rt.example/api/ledger/verify/agt_one', { headers: { Cookie: cookie } }), env, {} as ExecutionContext)
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(text).not.toContain(secret)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM trace').first<number>('n')).toBe(0)
    expect((await handle(new Request('https://rt.example/api/ledger/verify/agt_one'), env, {} as ExecutionContext)).status).toBe(401)
  })
})


afterEach(() => vi.restoreAllMocks())
it.each(['match', 'mismatch', 'down', 'http', 'tampered', 'concurrent'])('checks the paid order with PayPal: %s', async mode => {
  const d = await desk()
  d.env.LEDGER_SIGNING_KEY = 'signing key'
  const a = d.workspace.agents[0]
  const t = await currentTab(d.db, { ...a, ws_id: d.workspace.ws_id }, 500, 1)
  const { call } = await recordCall(d.db, { agent: { ...a, ws_id: d.workspace.ws_id }, tab: t, tool: 'lookup', args: {}, result: {}, price_cents: 25, status: 'BILLABLE', duration_ms: 1, now: 2, signingKey: 'signing key' })
  const hash = await d.db.prepare('SELECT chain_hash FROM calls WHERE id = ?').bind(call.id).first<string>('chain_hash')
  await d.db.prepare("UPDATE tabs SET state = 'PAID', order_id = 'ORDER1', paid_at = 3 WHERE id = ?").bind(t.id).run()
  if (mode === 'tampered') await d.db.prepare("UPDATE calls SET args_json = ? WHERE id = ?").bind(JSON.stringify({ changed: true }), call.id).run()
  const custom = mode === 'mismatch' ? 'rt:wrong' : `rt:${hash}`
  const request = vi.spyOn(PayPalClient.prototype, 'request').mockImplementation(async () => {
    if (mode === 'down') throw new Error('offline')
    if (mode === 'concurrent') await new Promise(resolve => setTimeout(resolve, 10))
    return { status: mode === 'http' ? 503 : 200, body: { purchase_units: [{ custom_id: custom }] } } as any
  })
  const get = async (id: string) => (await d.hit(`/api/ledger/verify/${id}`, { headers: { Cookie: d.cookie } })).json() as Promise<any>
  const result = mode === 'concurrent' ? (await Promise.all([get(a.id), get(t.id)]))[0] : await get(a.id)
  expect(result.ok).toBe(mode !== 'tampered')
  if (mode === 'down' || mode === 'http') expect(result.order).toEqual({ id: 'ORDER1', matches: null, error: 'PayPal did not answer' })
  else {
    expect(result.order).toMatchObject({ id: 'ORDER1', custom_id: custom, matches: mode === 'match' || mode === 'concurrent' })
    expect(result.order.ledger_hash).toMatch(/^[a-f0-9]{64}$/)
    if (mode === 'tampered') expect(result.order.ledger_hash).not.toBe(hash)
    await get(t.id)
    expect(request).toHaveBeenCalledTimes(1)
    expect(await d.db.prepare("SELECT value_json FROM cache WHERE key = 'order-hash:ORDER1'").first('value_json')).toBe(JSON.stringify(custom))
  }
  expect(request).toHaveBeenCalledWith('GET', '/v2/checkout/orders/ORDER1', { wsId: d.workspace.ws_id })
  d.db.raw.close()
})
