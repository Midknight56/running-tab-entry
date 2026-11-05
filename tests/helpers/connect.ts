import type { Env } from '../../src/env'
import { handle } from '../../src/worker'
import { fakeD1, fakeKV } from './d1'

export async function desk() {
  const db = fakeD1()
  let time = Date.now()
  const env = {
    DB: db, RT_KV: fakeKV(), AI: { run: async () => ({ response: '{}' }) },
    ASSETS: { fetch: async () => new Response('desk') }, AI_MODE: 'replay',
    PAYPAL_BASE: 'https://example.invalid', PAYPAL_CLIENT_ID: 'test', PAYPAL_CLIENT_SECRET: 'test', SESSION_SECRET: 'test',
  } as unknown as Env
  const ctx = { waitUntil: () => {} } as unknown as ExecutionContext
  const hit = (path: string, init: RequestInit = {}) => handle(new Request(`https://rt.example${path}`, init), env, ctx, () => time)
  const session = await hit('/api/session', { method: 'POST' })
  const cookie = session.headers.get('Set-Cookie')!.split(';')[0]
  const workspace = await session.json() as any
  const connect = () => hit('/api/connect', { method: 'POST', headers: { Cookie: cookie } })
  let sid = ''
  const rpc = async (key: string, method: string, params: unknown = {}) => {
    const r = await hit('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...(sid ? { 'MCP-Session-Id': sid } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    sid = r.headers.get('MCP-Session-Id') ?? sid
    return await r.json() as any
  }
  const call = (key: string, name = 'business_days', args: unknown = { start: '2026-10-01', end: '2026-10-07' }) => rpc(key, 'tools/call', { name, arguments: args })
  return { db, env, hit, cookie, workspace, connect, rpc, call, advance: () => { time += 7200000 } }
}
