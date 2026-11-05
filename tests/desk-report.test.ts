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
