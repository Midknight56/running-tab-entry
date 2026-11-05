import { describe, expect, it } from 'vitest'
import { createAgent, currentTab, MAX_RESULT_CHARS, recordCall, verifyLedger } from '../src/tab/ledger'
import { answerText } from '../src/claims/judge'
import { fakeD1 } from './helpers/d1'

describe('stored answers', () => {
  it.each([
    { content: [{ type: 'text', text: 'short answer' }], structuredContent: { value: 42 }, isError: false },
    { content: Array.from({ length: 3000 }, () => ({ type: 'text', text: 'answer' })) },
    { content: [{ type: 'text', text: 'answer' }], structuredContent: { rows: Array(5000).fill({ value: 42 }) } },
  ])('keeps short answers unchanged and bounds large containers', async result => {
    const db = fakeD1()
    const agent = await createAgent(db, 'ws1', 'Agent', 'hash', 1)
    const tab = await currentTab(db, agent, 500, 1)
    const { call } = await recordCall(db, { agent, tab, tool: 'echo', args: {}, result, price_cents: 25,
      status: 'BILLABLE', duration_ms: 1, now: 2 })
    const parsed = JSON.parse(call.result_json)
    expect(call.result_json.length).toBeLessThanOrEqual(MAX_RESULT_CHARS)
    expect(answerText(call.result_json).length).toBeGreaterThan(0)
    if (JSON.stringify(result).length <= MAX_RESULT_CHARS) expect(parsed).toEqual(result)
    else expect(parsed.truncated).toBe(true)
  })

  it.each(['x'.repeat(4500), '"\\\n'.repeat(2000)])('keeps long text as bounded valid JSON with a truncation marker', async text => {
    const db = fakeD1()
    const agent = await createAgent(db, 'ws1', 'Agent', 'hash', 1)
    const tab = await currentTab(db, agent, 500, 1)
    const { call } = await recordCall(db, { agent, tab, tool: 'echo', args: {},
      result: { content: [{ type: 'text', text }], isError: false }, price_cents: 25,
      status: 'BILLABLE', duration_ms: 1, now: 2, signingKey: 'test key' })
    expect(() => JSON.parse(call.result_json)).not.toThrow()
    expect(call.result_json.length).toBeLessThanOrEqual(MAX_RESULT_CHARS)
    expect(JSON.parse(call.result_json)).toMatchObject({ truncated: true, content: [{ type: 'text' }] })
    expect(answerText(call.result_json).length).toBeGreaterThan(0)
    expect(text.startsWith(answerText(call.result_json))).toBe(true)
    expect(await verifyLedger(db, agent.id, 'test key')).toMatchObject({ ok: true })
  })
})
