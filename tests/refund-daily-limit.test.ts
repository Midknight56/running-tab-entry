import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { claimFor, gate, REFUNDS_PER_IP_PER_DAY, visitorHash } from '../src/app'
import { utcDay } from '../src/ai/budget'
import { signWs } from '../src/demo/workspace'
import { handle } from '../src/worker'
import type { Env } from '../src/env'
import { fakeD1, fakeKV, type FakeD1 } from './helpers/d1'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const agent = { id: 'agt_1', ws_id: 'ws1', name: 'Agent A' }
const today = Date.UTC(2026, 10, 5, 12)
let db: FakeD1
let env: Env
let cookie: string
let refunds: string[]

function request(id: string) {
  return new Request(`https://rt.example/api/claims/${id}/approve`, {
    method: 'POST', headers: { Cookie: cookie, 'CF-Connecting-IP': '203.0.113.7' },
  })
}

async function counterKey(now = today) {
  return `ip:${await visitorHash(env, request('clm_1'), now)}:${utcDay(now)}:refund`
}

async function used() {
  return db.prepare('SELECT n FROM counters WHERE key = ?').bind(await counterKey()).first<number>('n')
}

async function seedClaim(id: string, seq: number, state = 'WAITING_SELLER', status: string | null = null) {
  await db.prepare(`INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, capture_id, captured_cents, created_at)
    VALUES (?, 'ws1', 'agt_1', 'PAID', 1000, 500, ?, 1000, 1)`).bind(`tab_${seq}`, `CAP${seq}`).run()
  await db.prepare(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
    VALUES (?, ?, 'ws1', 'agt_1', ?, 'convert_time', '{}', '{"content":[{"text":"bad answer"}]}', 25, 'BILLABLE', 1)`)
    .bind(`call_${seq}`, seq, `tab_${seq}`).run()
  if (id) await db.prepare(`INSERT INTO claims (id, ws_id, call_id, reason_text, state, refund_status, created_at)
    VALUES (?, 'ws1', ?, 'bad answer', ?, ?, 1)`).bind(id, `call_${seq}`, state, status).run()
}

beforeEach(async () => {
  db = fakeD1()
  refunds = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname
    if (path === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'TEST_TOKEN', expires_in: 3600 }), { status: 200 })
    if (!path.endsWith('/refund')) throw new Error(`Unexpected request: ${path}`)
    refunds.push(path)
    return new Response(JSON.stringify({ id: `REF${refunds.length}`, status: 'COMPLETED' }), { status: 201 })
  }))
  env = {
    DB: db, RT_KV: fakeKV(), AI: { run: async () => ({ response: JSON.stringify({ verdict: 'approve', claim_names: 'NONSENSE', reason_code: 'NONSENSE', evidence: 'bad answer', cited_call_ids: [2] }) }) } as any,
    ASSETS: { fetch: async () => new Response('desk') } as unknown as Fetcher,
    PAYPAL_BASE: 'https://paypal.example', PAYPAL_CLIENT_ID: 'cid_TEST', PAYPAL_CLIENT_SECRET: 'secret_TEST',
    SESSION_SECRET: 'session secret for tests', AI_MODE: 'live',
  }
  await db.prepare("INSERT INTO workspaces (id, ip_day_hash, created_at) VALUES ('ws1', 'test', 1)").run()
  cookie = `rt_ws=${encodeURIComponent(await signWs(env.SESSION_SECRET, 'ws1'))}`
})

afterEach(() => vi.unstubAllGlobals())

describe('daily refund limit', () => {
  it('keeps uncertain refund reconciliation behind the daily cap', async () => {
    await seedClaim('clm_1', 1, 'REFUNDING', 'RETRY_AUTO')
    await db.prepare('UPDATE tabs SET refunded_cents = 25').run()
    await db.prepare('INSERT INTO counters (key, n) VALUES (?, ?)').bind(await counterKey(), REFUNDS_PER_IP_PER_DAY).run()
    const response = await handle(new Request('https://rt.example/api/desk/data', {
      headers: { Cookie: cookie, 'CF-Connecting-IP': '203.0.113.7' },
    }), env, ctx, () => today)
    expect(response.status).toBe(200)
    expect(refunds).toHaveLength(0)
    expect(await db.prepare('SELECT refund_status FROM claims').first('refund_status')).toBe('RETRY_AUTO')
    expect(await db.prepare('SELECT refunded_cents FROM tabs').first('refunded_cents')).toBe(25)
    expect(await used()).toBe(REFUNDS_PER_IP_PER_DAY)
  })

  it('returns 404 for an unknown claim without calling PayPal', async () => {
    const response = await handle(request('missing'), env, ctx, () => today)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'No such claim.' })
    expect(refunds).toHaveLength(0)
  })

  it('returns 404 for another workspace claim without calling PayPal', async () => {
    await db.prepare("INSERT INTO workspaces (id, ip_day_hash, created_at) VALUES ('ws2', 'other', 1)").run()
    await db.prepare(`INSERT INTO claims (id, ws_id, call_id, reason_text, state, created_at)
      VALUES ('foreign_claim', 'ws2', 'foreign_call', 'bad answer', 'WAITING_SELLER', 1)`).run()
    const response = await handle(request('foreign_claim'), env, ctx, () => today)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'No such claim.' })
    expect(refunds).toHaveLength(0)
  })

  it.each([
    ['WAITING_SELLER', null], ['APPROVED', 'FAILED UNPROCESSABLE_ENTITY'],
  ])('keeps %s unchanged at the cap and allows the same approval tomorrow', async (state, status) => {
    await seedClaim('clm_1', 1, state!, status)
    await db.prepare('INSERT INTO counters (key, n) VALUES (?, ?)').bind(await counterKey(), REFUNDS_PER_IP_PER_DAY).run()
    const response = await handle(request('clm_1'), env, ctx, () => today)
    expect.soft(response.status).toBe(429)
    expect.soft(await response.json()).toEqual({ error: 'Ten refunds a day from one network. Try again tomorrow.' })
    expect.soft(REFUNDS_PER_IP_PER_DAY).toBe(10)
    expect.soft(refunds).toHaveLength(0)
    expect.soft(await db.prepare("SELECT state, refund_status FROM claims WHERE id = 'clm_1'").first()).toEqual({ state, refund_status: status })
    expect.soft(await db.prepare("SELECT refunded_cents FROM tabs WHERE id = 'tab_1'").first('refunded_cents')).toBe(0)
    expect.soft(await used()).toBe(REFUNDS_PER_IP_PER_DAY)
    const next = await handle(request('clm_1'), env, ctx, () => today + 86400000)
    expect(next.status).toBe(200)
    expect(refunds).toHaveLength(1)
    expect(await db.prepare("SELECT refunded_cents FROM tabs WHERE id = 'tab_1'").first('refunded_cents')).toBe(25)
  })

  it.each(['claim', 'seller'])('shares the counter when %s uses the last slot', async first => {
    await seedClaim('clm_1', 1)
    await seedClaim('', 2)
    await db.prepare('INSERT INTO counters (key, n) VALUES (?, ?)').bind(await counterKey(), REFUNDS_PER_IP_PER_DAY - 1).run()
    const visitor = await visitorHash(env, request('clm_1'), today)
    const claim = () => claimFor(env, gate(env, visitor, 'ws1', () => today), visitor, agent, 2, 'bad answer', () => today)
    if (first === 'claim') {
      expect((await claim()).state).toBe('REFUNDED')
      expect((await handle(request('clm_1'), env, ctx, () => today)).status).toBe(429)
    } else {
      expect((await handle(request('clm_1'), env, ctx, () => today)).status).toBe(200)
      expect((await claim()).state).not.toBe('REFUNDED')
    }
    expect(refunds).toHaveLength(1)
    expect(await used()).toBe(REFUNDS_PER_IP_PER_DAY)
  })
})
