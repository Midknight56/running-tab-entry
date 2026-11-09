import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sellerServer } from '../src/app'
import { ModelGate } from '../src/ai/model'
import { sha256Hex } from '../src/demo/workspace'
import { convertTime } from '../src/demo/seller'
import type { Env } from '../src/env'
import { createAgent } from '../src/tab/ledger'
import { fakeD1, fakeKV } from './helpers/d1'

const args = { time: '09:00', date: '2026-10-23', from: 'America/Halifax', to: 'Europe/London' }

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request') }))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function call(fault?: string, input = args, verdict: 'keep' | 'strike' = 'keep') {
  const db = fakeD1()
  const key = 'rt_agent_requires_test'
  await createAgent(db, 'ws1', 'Test agent', await sha256Hex(key), 1000)
  const ask = vi.spyOn(ModelGate.prototype, 'ask').mockImplementation(async (_job, messages) => {
    const sent = JSON.parse(messages[1].content)
    return { text: JSON.stringify({ call_id: sent.call_id, verdict, ...(verdict === 'strike' ? { reason_code: 'OFF_REQUEST', evidence: 'London has mild weather this week' } : {}) }), source: 'replay', neurons: 0 }
  })
  const env: Env = {
    DB: db, RT_KV: fakeKV(), SESSION_SECRET: 'requires_test_session_secret', AI_MODE: 'replay',
    AI: { run: async () => { throw new Error('Unexpected model request') } },
    ASSETS: { fetch: async () => new Response('') } as unknown as Fetcher,
    PAYPAL_BASE: 'https://rt.example', PAYPAL_CLIENT_ID: 'test_id', PAYPAL_CLIENT_SECRET: 'test_secret',
  }
  const server = sellerServer(env, () => 1000)
  const initialized = await server.handle(new Request('https://rt.example/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } }),
  }))
  expect(initialized.status).toBe(200)
  const response = await server.handle(new Request('https://rt.example/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'MCP-Session-Id': initialized.headers.get('MCP-Session-Id')!, ...(fault ? { 'X-RT-Demo-Fault': fault } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'convert_time', arguments: input } }),
  }))
  const body = await response.json() as any
  expect(body.error).toBeUndefined()
  expect(body.result.isError).not.toBe(true)
  const row = await db.prepare('SELECT status, reason_code, judged_by, evidence FROM calls').first()
  return { db, ask, row, meta: body.result._meta['running-tab/call'] }
}

describe('convert time required date', () => {
  it('passes an off-topic answer without a clock time to the model auditor', async () => {
    const { ask, row } = await call('off', args, 'strike')
    expect(ask).toHaveBeenCalledOnce()
    expect(JSON.parse(ask.mock.calls[0][1][1].content).answer).toContain('weather')
    expect(row).toMatchObject({ status: 'STRUCK', reason_code: 'OFF_REQUEST', judged_by: 'model' })
  })

  it('asks the model about a vague answer with no clock time, and holds it when the model would bill it', async () => {
    const { ask, row } = await call('vague')
    expect(ask).toHaveBeenCalledOnce()
    expect(JSON.parse(ask.mock.calls[0][1][1].content).answer).toContain('It depends')
    expect(row).toMatchObject({ status: 'PENDING_AUDIT' })
  })

  it('strikes the incomplete fault by code without calling the model gate', async () => {
    const { db, ask, row, meta } = await call('incomplete')
    expect(ask).not.toHaveBeenCalled()
    expect(row).toEqual({ status: 'STRUCK', reason_code: 'INCOMPLETE', judged_by: 'code', evidence: 'The request asked for a date; the answer gives none.' })
    expect(meta).toMatchObject({ status: 'STRUCK', reason_code: 'INCOMPLETE', tab_total_cents: 0 })
    expect(await db.prepare('SELECT total_cents FROM tabs').first('total_cents')).toBe(0)
  })

  it('passes a complete answer to the model for a valid call', async () => {
    const { ask, row, meta } = await call(undefined)
    expect(ask).toHaveBeenCalledOnce()
    expect(row).toMatchObject({ status: 'BILLABLE', judged_by: 'model' })
    expect(meta.tab_total_cents).toBe(25)
  })

  it('four convert_time calls with fault wrong are all STRUCK unbilled and valid calls stay BILLABLE', async () => {
    const db = fakeD1()
    const key = 'rt_agent_app_wrong_test'
    await createAgent(db, 'ws1', 'Test agent', await sha256Hex(key), 1000)
    vi.spyOn(ModelGate.prototype, 'ask').mockImplementation(async (_job, messages) => {
      const sent = JSON.parse(messages[1].content)
      return { text: JSON.stringify({ call_id: sent.call_id, verdict: 'keep' }), source: 'replay', neurons: 0 }
    })
    const env: Env = {
      DB: db, RT_KV: fakeKV(), SESSION_SECRET: 'requires_test_session_secret', AI_MODE: 'replay',
      AI: { run: async () => { throw new Error('Unexpected model request') } },
      ASSETS: { fetch: async () => new Response('') } as unknown as Fetcher,
      PAYPAL_BASE: 'https://rt.example', PAYPAL_CLIENT_ID: 'test_id', PAYPAL_CLIENT_SECRET: 'test_secret',
    }
    const server = sellerServer(env, () => 1000)
    const initialized = await server.handle(new Request('https://rt.example/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } }),
    }))
    const sid = initialized.headers.get('MCP-Session-Id')!

    for (let i = 1; i <= 4; i++) {
      const response = await server.handle(new Request('https://rt.example/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'MCP-Session-Id': sid, 'X-RT-Demo-Fault': 'wrong' },
        body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'convert_time', arguments: args } }),
      }))
      const body = await response.json() as any
      expect(body.result._meta['running-tab/call']).toMatchObject({
        status: 'STRUCK',
        reason_code: 'WRONG',
        tab_total_cents: 0,
      })
    }

    expect(await db.prepare('SELECT total_cents FROM tabs').first('total_cents')).toBe(0)

    const validResponse = await server.handle(new Request('https://rt.example/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, 'MCP-Session-Id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'convert_time', arguments: args } }),
    }))
    const validBody = await validResponse.json() as any
    expect(validBody.result._meta['running-tab/call']).toMatchObject({
      status: 'BILLABLE',
      tab_total_cents: 25,
    })
    expect(await db.prepare('SELECT total_cents FROM tabs').first('total_cents')).toBe(25)
  })

  it('accepts the converted date when it differs from the requested date', async () => {
    const { ask, row } = await call(undefined, { time: '23:30', date: '2026-10-23', from: 'America/Los_Angeles', to: 'Asia/Tokyo' })
    expect(ask).toHaveBeenCalledOnce()
    expect(JSON.parse(ask.mock.calls[0][1][1].content).answer).toContain('15:30 on 2026-10-24')
    expect(row).toMatchObject({ status: 'BILLABLE', judged_by: 'model' })
  })

  it('requires the converted date even when the answer includes the source date', async () => {
    vi.spyOn(convertTime, 'run').mockResolvedValue({ content: [{ type: 'text', text: '23:30 on 2026-10-23 in America/Los_Angeles is 15:30 in Asia/Tokyo.' }] })
    const { ask, row } = await call(undefined, { time: '23:30', date: '2026-10-23', from: 'America/Los_Angeles', to: 'Asia/Tokyo' })
    expect(ask).not.toHaveBeenCalled()
    expect(row).toMatchObject({ status: 'STRUCK', reason_code: 'INCOMPLETE', judged_by: 'code' })
  })
})
