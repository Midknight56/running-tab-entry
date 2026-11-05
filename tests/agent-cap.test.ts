import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_CALLS_PER_DAY } from '../src/app'
import { utcDay } from '../src/ai/budget'
import type { Env } from '../src/env'
import { handle } from '../src/worker'
import { fakeD1, fakeKV, type FakeD1 } from './helpers/d1'

let db: FakeD1
let env: Env
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

async function hit(path: string, init: RequestInit = {}) {
  return handle(new Request(`https://rt.example${path}`, init), env, ctx)
}

async function mcp(key: string, method: string, params: Record<string, unknown>, sid?: string) {
  const response = await hit('/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${key}`,
      ...(sid ? { 'MCP-Session-Id': sid } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return { response, body: await response.json() as any }
}

beforeEach(() => {
  db = fakeD1()
  env = {
    DB: db, RT_KV: fakeKV(), AI: { run: async () => ({ response: '{}' }) } as unknown as Ai,
    ASSETS: { fetch: async () => new Response('desk') } as unknown as Fetcher,
    PAYPAL_BASE: 'https://api-m.sandbox.paypal.com', AI_MODE: 'replay',
    PAYPAL_CLIENT_ID: 'cid_test', PAYPAL_CLIENT_SECRET: 'secret_test', SESSION_SECRET: 'agent-cap-test-secret',
  }
})
afterEach(() => { vi.unstubAllGlobals() })

describe('daily MCP call limit per agent key', () => {
  it('caps priced calls per key while leaving free tools and other agents available', async () => {
    const session = await hit('/api/session', { method: 'POST' })
    expect(session.status).toBe(200)
    const workspace = await session.json() as { agents: { id: string; key: string }[] }
    const [first, second] = workspace.agents
    const init = await mcp(first.key, 'initialize', { protocolVersion: '2025-11-25' })
    const sid = init.response.headers.get('MCP-Session-Id')!
    const counterKey = `agent:${first.id}:${utcDay(Date.now())}:calls`
    await db.prepare('INSERT INTO counters (key, n) VALUES (?, ?)').bind(counterKey, AGENT_CALLS_PER_DAY - 1).run()

    const call = (key: string, name: string, args: Record<string, unknown> = {}) => mcp(key, 'tools/call', { name, arguments: args }, sid)
    const args = { start: '2026-10-01', end: '2026-10-07' }
    const lastAllowed = await call(first.key, 'business_days', args)
    expect(lastAllowed.body.result.isError).not.toBe(true)

    const refused = await call(first.key, 'business_days', args)
    expect(refused.body.result).toMatchObject({ isError: true, content: [{ text: 'This agent key has used its 400 calls for today. It works again tomorrow.' }] })

    const free = await call(first.key, 'my_tab')
    expect(free.body.result.isError).not.toBe(true)
    expect(free.body.result.structuredContent).toBeTruthy()

    const otherAgent = await call(second.key, 'business_days', args)
    expect(otherAgent.body.result.isError).not.toBe(true)
  })
})
