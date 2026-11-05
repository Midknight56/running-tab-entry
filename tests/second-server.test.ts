import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import worker, { createSeller } from '../examples/second-server'
import { createAgent, sha256Hex } from '../src/tab'
import { PayPalClient } from '../src/paypal/client'
import { fakeD1, fakeKV } from './helpers/d1'

const key = 'rt_agent_second_server_key'
const sellerKey = 'seller_secret_with_at_least_32_characters'
const sellerHeaders = { Authorization: `Bearer ${sellerKey}` }
const url = 'https://second.test/mcp'
const env = (DB: D1Database) => ({
  DB, SELLER_KEY: sellerKey, SELLER_WORKSPACE_ID: 'ws2', SESSION_SECRET: 'second-secret', RT_KV: fakeKV(),
  PAYPAL_BASE: 'https://paypal.invalid', PAYPAL_CLIENT_ID: 'test', PAYPAL_CLIENT_SECRET: 'test', PAYPAL_WEBHOOK_ID: 'HOOK1',
})
const approval = 'https://paypal.invalid/approve?token=ORD1'
let amount: string
let verified: boolean
let pp: MockInstance<PayPalClient['request']>

beforeEach(() => {
  amount = '0.03'
  verified = true
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden') }))
  pp = vi.spyOn(PayPalClient.prototype, 'request').mockImplementation(async (_method, path, opts = {}) => {
    if (path === '/v2/checkout/orders') {
      amount = (opts.body as any).purchase_units[0].amount.value
      return { status: 201, body: { id: 'ORD1', status: 'CREATED', links: [{ rel: 'approve', href: approval }] } } as any
    }
    if (path === '/v2/checkout/orders/ORD1/capture') return { status: 201, body: {
      purchase_units: [{ payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'USD', value: amount } }] } }],
    } } as any
    if (path === '/v2/payments/captures/CAP1/refund') return { status: 201, body: { id: 'REF1', status: 'COMPLETED' } } as any
    if (path === '/v1/notifications/verify-webhook-signature') return {
      status: 200, body: { verification_status: verified ? 'SUCCESS' : 'FAILURE' },
    } as any
    throw new Error('Unexpected PayPal path ' + path)
  })
})

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function seller(options?: { judge?: NonNullable<Parameters<typeof createSeller>[0]>['judge'] }) {
  const db = fakeD1()
  await createAgent(db, 'ws2', 'Second agent', await sha256Hex(key))
  const settings = env(db)
  const handler = options ? createSeller(options) : worker
  const hit = (path: string, init?: RequestInit) => handler.fetch(new Request(`https://second.test${path}`, init), settings)
  const sid = await initialize(db)
  return { db, settings, hit, sid }
}

async function pay(s: Awaited<ReturnType<typeof seller>>, tabId: string) {
  const started = await s.hit(`/pay/${tabId}`)
  expect(started.status).toBe(302)
  expect(started.headers.get('Location')).toBe(approval)
  return s.hit('/paypal/return?token=ORD1')
}

function request(method: string, params: Record<string, unknown>, sid = '') {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...(sid ? { 'MCP-Session-Id': sid } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

async function initialize(db: D1Database) {
  const response = await worker.fetch(request('initialize', { protocolVersion: '2025-11-25' }), env(db))
  return response.headers.get('MCP-Session-Id')!
}

async function call(db: D1Database, sid: string, name: string, args: Record<string, unknown> = {}) {
  const response = await worker.fetch(request('tools/call', { name, arguments: args }, sid), env(db))
  return (await response.json() as { result: any }).result
}

describe('second kit server', () => {
  it('bills the priced tool and keeps the free tool callable when due', async () => {
    const db = fakeD1()
    await createAgent(db, 'ws2', 'Second agent', await sha256Hex(key))
    const sid = await initialize(db)

    const priced = await call(db, sid, 'convert_units', { value: 2, from: 'km', to: 'm' })
    expect(priced.structuredContent.value).toBe(2000)
    expect(priced._meta['running-tab/call'].price_cents).toBe(3)
    expect(priced._meta['running-tab/call'].tab_state).toBe('DUE')

    const free = await call(db, sid, 'convert_temperature', { value: 20 })
    expect(free.isError).not.toBe(true)
    expect(free.structuredContent.value).toBe(68)
    expect(free._meta).toBeUndefined()
    expect((await db.prepare('SELECT COUNT(*) AS count FROM calls').first<{ count: number }>())?.count).toBe(1)
  })

  it('serves the due link, captures payment, and bills the next call on a new tab', async () => {
    const s = await seller()
    const first = await call(s.db, s.sid, 'convert_units', { value: 2 })
    const meta = first._meta['running-tab/call']
    expect(meta).toMatchObject({ price_cents: 3, tab_state: 'DUE' })
    const due = await call(s.db, s.sid, 'convert_units', { value: 3 })
    expect(due.structuredContent).toMatchObject({ code: 'TAB_DUE', pay_url: `https://second.test/pay/${meta.tab_id}` })
    const tab = await call(s.db, s.sid, 'my_tab')
    expect(tab).toBeDefined()
    expect(tab.structuredContent).toMatchObject({ state: 'DUE', pay_url: due.structuredContent.pay_url })
    const paid = await pay(s, meta.tab_id)
    expect(paid.status).toBe(200)
    expect(await paid.text()).toBe('Paid. Your agent can carry on.')
    expect(await s.db.prepare('SELECT state, capture_id FROM tabs WHERE id = ?').bind(meta.tab_id).first())
      .toEqual({ state: 'PAID', capture_id: 'CAP1' })
    const resumed = await call(s.db, s.sid, 'convert_units', { value: 4 })
    expect(resumed.structuredContent.value).toBe(4000)
    expect(resumed._meta['running-tab/call']).toMatchObject({ price_cents: 3, status: 'BILLABLE' })
    expect(resumed._meta['running-tab/call'].tab_id).not.toBe(meta.tab_id)
    expect(await s.db.prepare('SELECT COUNT(*) FROM calls').first('COUNT(*)')).toBe(2)
  })

  it('refunds exactly one paid call once when the judge upholds the claim', async () => {
    const judge = vi.fn(async () => ({ approve: true as const, reason_code: 'NONSENSE', evidence: '2000 m', cited_seqs: [1] }))
    const s = await seller({ judge })
    const first = await call(s.db, s.sid, 'convert_units', { value: 2 })
    const meta = first._meta['running-tab/call']
    await pay(s, meta.tab_id)
    const claim = async () => {
      const response = await s.hit('/mcp', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'MCP-Session-Id': s.sid },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'report_bad_answer', arguments: { call_id: meta.seq, reason: 'The answer was not useful' },
        } }),
      })
      return (await response.json() as any).result
    }
    expect((await claim()).structuredContent).toEqual({ state: 'WAITING_SELLER' })
    expect(pp.mock.calls.filter(args => args[1].endsWith('/refund'))).toHaveLength(0)
    const stored = await s.db.prepare('SELECT * FROM claims').first<any>()
    const listed = await s.hit('/seller/claims', { headers: sellerHeaders })
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual([{ id: stored.id, seq: meta.seq, tool: 'convert_units', price_cents: 3,
      reason_text: 'The answer was not useful', created_at: stored.created_at }])
    const approved = await s.hit(`/seller/claims/${stored.id}/approve`, { method: 'POST', headers: sellerHeaders })
    expect(approved.status).toBe(200)
    expect(await approved.json()).toMatchObject({ id: stored.id, state: 'REFUNDED', refund_id: 'REF1' })
    const repeated = await s.hit(`/seller/claims/${stored.id}/approve`, { method: 'POST', headers: sellerHeaders })
    expect(repeated.status).toBe(409)
    expect(await repeated.json()).toEqual({ name: 'NOT_WAITING' })
    expect(await (await s.hit('/seller/claims', { headers: sellerHeaders })).json()).toEqual([])
    expect((await claim()).structuredContent.state).toBe('REFUNDED')
    const refunds = pp.mock.calls.filter((args: any[]) => args[1].endsWith('/refund'))
    expect(refunds).toHaveLength(1)
    expect((refunds[0][2]?.body as { amount: unknown }).amount).toEqual({ currency_code: 'USD', value: '0.03' })
    expect(judge).toHaveBeenCalledTimes(1)
    expect(await s.db.prepare('SELECT refunded_cents FROM tabs WHERE id = ?').bind(meta.tab_id).first('refunded_cents')).toBe(3)
  })

  it.each([
    ['missing authorization', undefined, sellerKey],
    ['wrong authorization', 'Bearer wrong_secret_with_at_least_32_characters', sellerKey],
    ['short secret', 'Bearer short', 'short'],
    ['unset secret', `Bearer ${sellerKey}`, undefined],
    ['wrong scheme', `Basic ${sellerKey}`, sellerKey],
  ])('refuses seller routes with %s', async (_label, authorization, secret) => {
    const s = await seller()
    Object.assign(s.settings, { SELLER_KEY: secret })
    const headers: Record<string, string> = authorization ? { Authorization: authorization } : {}
    expect((await s.hit('/seller/claims', { headers })).status).toBe(401)
    expect((await s.hit('/seller/claims/missing/approve', { method: 'POST', headers })).status).toBe(401)
    expect(pp).not.toHaveBeenCalled()
  })

  it('lists only waiting claims in its workspace, newest first, at most 50', async () => {
    const s = await seller()
    const first = await call(s.db, s.sid, 'convert_units', { value: 2 })
    const callId = await s.db.prepare('SELECT id FROM calls').first('id')
    for (let i = 0; i < 55; i++) {
      await s.db.prepare(`INSERT INTO claims (id, ws_id, call_id, reason_text, state, refund_status, created_at)
        VALUES (?, ?, ?, 'Review this answer', ?, ?, ?)`)
        .bind(`claim_${i}`, i === 54 ? 'other' : 'ws2', `${callId}_${i}`,
          i === 53 ? 'REJECTED' : i === 52 ? 'APPROVED' : 'WAITING_SELLER', i === 52 ? 'FAILED DECLINED' : null, i).run()
      await s.db.prepare(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
        SELECT ?, ?, ?, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at FROM calls WHERE id = ?`)
        .bind(`${callId}_${i}`, i + 2, i === 54 ? 'other' : 'ws2', callId).run()
    }
    const response = await s.hit('/seller/claims', { headers: sellerHeaders })
    expect(response.status).toBe(200)
    const claims = await response.json() as any[]
    expect(claims).toHaveLength(50)
    expect(claims.map(c => c.id)).toEqual(Array.from({ length: 50 }, (_, i) => `claim_${52 - i}`))
    expect(claims[0]).toMatchObject({ seq: 54, tool: 'convert_units', price_cents: 3, created_at: 52 })
    expect(first._meta['running-tab/call'].tab_state).toBe('DUE')
    expect((await s.hit('/seller/claims/claim_54/approve', { method: 'POST', headers: sellerHeaders })).status).toBe(404)
    expect((await s.hit('/seller/claims/missing/approve', { method: 'POST', headers: sellerHeaders })).status).toBe(404)
    expect(pp).not.toHaveBeenCalled()
  })

  it('reports unpaid and over capture claims without sending a refund', async () => {
    const s = await seller()
    const first = await call(s.db, s.sid, 'convert_units', { value: 2 })
    await call(s.db, s.sid, 'report_bad_answer', { call_id: first._meta['running-tab/call'].seq, reason: 'Review this answer' })
    const id = await s.db.prepare('SELECT id FROM claims').first('id')
    const approve = () => s.hit(`/seller/claims/${id}/approve`, { method: 'POST', headers: sellerHeaders })
    const unpaid = await approve()
    expect(unpaid.status).toBe(409)
    expect(await unpaid.json()).toEqual({ name: 'NOT_PAID' })
    await pay(s, first._meta['running-tab/call'].tab_id)
    await s.db.prepare('UPDATE tabs SET refunded_cents = captured_cents').run()
    const over = await approve()
    expect(over.status).toBe(409)
    expect(await over.json()).toEqual({ name: 'OVER_CAPTURE' })
    expect(pp.mock.calls.filter(args => args[1].endsWith('/refund'))).toHaveLength(0)
  })

  it('retries an approved claim whose refund failed', async () => {
    const s = await seller()
    const first = await call(s.db, s.sid, 'convert_units', { value: 2 })
    await pay(s, first._meta['running-tab/call'].tab_id)
    await call(s.db, s.sid, 'report_bad_answer', { call_id: first._meta['running-tab/call'].seq, reason: 'Review this answer' })
    const id = await s.db.prepare('SELECT id FROM claims').first('id')
    const approve = () => s.hit(`/seller/claims/${id}/approve`, { method: 'POST', headers: sellerHeaders })
    pp.mockResolvedValueOnce({ status: 422, body: { name: 'UNPROCESSABLE_ENTITY' }, name: 'UNPROCESSABLE_ENTITY' })
    const failed = await approve()
    expect(failed.status).toBe(409)
    expect(await failed.json()).toEqual({ name: 'UNPROCESSABLE_ENTITY' })
    expect(await s.db.prepare('SELECT state, refund_status FROM claims').first())
      .toEqual({ state: 'APPROVED', refund_status: 'FAILED UNPROCESSABLE_ENTITY' })
    const listed = await s.hit('/seller/claims', { headers: sellerHeaders })
    expect(await listed.json()).toMatchObject([{ id }])
    const retried = await approve()
    expect(retried.status).toBe(200)
    expect(await retried.json()).toMatchObject({ state: 'REFUNDED', refund_id: 'REF1' })
    expect(await s.db.prepare('SELECT refunded_cents FROM tabs').first('refunded_cents')).toBe(3)
  })

  it('uses the configured workspace for agents and seller review', async () => {
    const s = await seller()
    await createAgent(s.db, 'other', 'Other agent', await sha256Hex('other_agent_key'))
    const response = await s.hit('/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer other_agent_key', 'MCP-Session-Id': s.sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'convert_units', arguments: { value: 2 } } }),
    })
    expect(JSON.stringify(await response.json())).toContain('Unknown agent key.')
    expect(await s.db.prepare('SELECT COUNT(*) AS n FROM calls').first('n')).toBe(0)
    Object.assign(s.settings, { SELLER_WORKSPACE_ID: '' })
    expect((await s.hit('/seller/claims', { headers: sellerHeaders })).status).toBe(503)
    expect(pp).not.toHaveBeenCalled()
  })

  it('verifies webhook signatures before marking a tab paid', async () => {
    const s = await seller()
    const first = await call(s.db, s.sid, 'convert_units', { value: 2 })
    const tabId = first._meta['running-tab/call'].tab_id
    const start = await s.hit(`/pay/${tabId}`)
    expect(start.status).toBe(302)
    const headers = Object.fromEntries(['auth-algo', 'cert-url', 'transmission-id', 'transmission-sig', 'transmission-time']
      .map(name => [`paypal-${name}`, 'test']))
    const body = JSON.stringify({ id: 'EVENT1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {
      id: 'CAP1', amount: { currency_code: 'USD', value: '0.03' }, supplementary_data: { related_ids: { order_id: 'ORD1' } },
    } })
    verified = false
    expect((await s.hit('/paypal/webhook', { method: 'POST', headers, body })).status).toBe(400)
    expect(await s.db.prepare('SELECT state FROM tabs WHERE id = ?').bind(tabId).first('state')).toBe('DUE')
    verified = true
    expect((await s.hit('/paypal/webhook', { method: 'POST', headers, body })).status).toBe(200)
    expect(await s.db.prepare('SELECT state FROM tabs WHERE id = ?').bind(tabId).first('state')).toBe('PAID')
  })

  it('refuses unknown payments and returns without reporting success', async () => {
    const s = await seller()
    expect((await s.hit('/pay/missing')).status).toBe(400)
    expect((await s.hit('/paypal/return?token=missing')).status).toBe(400)
    expect((await s.hit('/missing')).status).toBe(404)
    expect(pp).not.toHaveBeenCalled()
  })

  it('keeps a tab due when capture fails', async () => {
    const s = await seller()
    const first = await call(s.db, s.sid, 'convert_units', { value: 2 })
    const tabId = first._meta['running-tab/call'].tab_id
    expect((await s.hit(`/pay/${tabId}`)).status).toBe(302)
    pp.mockResolvedValueOnce({ status: 500, body: {}, name: 'INTERNAL_SERVER_ERROR' })
    const response = await s.hit('/paypal/return?token=ORD1')
    expect(response.status).toBe(400)
    expect(await response.text()).toBe('Payment was not completed.')
    expect(await s.db.prepare('SELECT state FROM tabs WHERE id = ?').bind(tabId).first('state')).toBe('DUE')
    expect((await call(s.db, s.sid, 'convert_units', { value: 3 })).structuredContent.code).toBe('TAB_DUE')
  })

  it('records a claim for the seller when no judge is configured', async () => {
    const s = await seller()
    const first = await call(s.db, s.sid, 'convert_units', { value: 2 })
    const claim = await call(s.db, s.sid, 'report_bad_answer', {
      call_id: first._meta['running-tab/call'].seq, reason: 'A retry was billed twice',
    })
    expect(claim.structuredContent.state).toBe('WAITING_SELLER')
    expect(pp).not.toHaveBeenCalled()
  })

  it('keeps the README integration block identical to the example', () => {
    const readme = readFileSync(resolve(import.meta.dirname, '../src/tab/README.md'), 'utf8')
    const example = readFileSync(resolve(import.meta.dirname, '../examples/second-server.ts'), 'utf8')
    const installSection = readme.split('## Install in your own server')[1]
    const block = installSection.match(/```ts\r?\n([\s\S]*?)\r?\n```/)?.[1]
    expect(block).toBe(example.trim())
  })

  it('imports only the kit and the add on', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../examples/second-server.ts'), 'utf8')
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
    expect(imports).toEqual(['mcp-on-workers', '../src/tab', '../src/tab/paypal'])
  })
})
