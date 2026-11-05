import { beforeEach, describe, expect, it } from 'vitest'
import { agentTools, explainBillTool, myTab, reportBadAnswer } from '../src/tab/agent-tools'
import { createAgent, currentTab, recordCall } from '../src/tab/ledger'
import type { TabCtx } from '../src/tab/with-tab'
import { fakeD1, type FakeD1 } from './helpers/d1'

let db: FakeD1
let ctx: TabCtx
let now = 1_000

beforeEach(async () => {
  db = fakeD1()
  now = 1_000
  const agent = await createAgent(db, 'ws1', 'Agent A', 'hash-a', now, 'agt_a')
  ctx = { tab: { db, agent, origin: 'https://rt.example', thresholdCents: 500, now: () => now++ } }
})

describe('my_tab', () => {
  it('reports NONE before the agent has a tab', async () => {
    const result = await myTab.run({}, ctx)
    expect(result.content[0].text).toContain('Your first priced call opens one.')
    expect(result.structuredContent).toEqual({ state: 'NONE' })
  })

  it('reports the total, threshold, call count and struck reason for an OPEN tab', async () => {
    const tab = await currentTab(db, ctx.tab.agent, 500, now++)
    await recordCall(db, { agent: ctx.tab.agent, tab, tool: 'alpha', args: {}, result: {}, price_cents: 125, status: 'BILLABLE', duration_ms: 1, now: now++ })
    await recordCall(db, { agent: ctx.tab.agent, tab, tool: 'beta', args: {}, result: {}, price_cents: 50, status: 'STRUCK', reason_code: 'EMPTY', duration_ms: 1, now: now++ })
    const result = await myTab.run({}, ctx)
    expect(result.structuredContent).toMatchObject({ state: 'OPEN', total: '1.25', threshold: '5.00', calls: 2, struck_calls: [{ tool: 'beta', reason: 'EMPTY' }] })
    expect(result.structuredContent).not.toHaveProperty('pay_url')
  })

  it('includes the payment URL and says the tab is due', async () => {
    const tab = await currentTab(db, ctx.tab.agent, 500, now++)
    await db.prepare("UPDATE tabs SET state = 'DUE', total_cents = 500 WHERE id = ?").bind(tab.id).run()
    const result = await myTab.run({}, ctx)
    expect(result.content[0].text).toContain('is due')
    expect(result.structuredContent?.pay_url).toMatch(new RegExp(`/pay/${tab.id}$`))
  })

  it('does not expose another agent tab', async () => {
    const other = await createAgent(db, 'ws2', 'Agent B', 'hash-b', now++, 'agt_b')
    await currentTab(db, other, 500, now++)
    const result = await myTab.run({}, ctx)
    expect(result.structuredContent).toEqual({ state: 'NONE' })
  })
})

describe('explain_bill', () => {
  it('reports when explanations are not configured', async () => {
    const tab = await currentTab(db, ctx.tab.agent, 500, now++)
    const result = await explainBillTool.run({ tab_id: tab.id }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('Explanations are not set up on this server.')
  })

  it('passes the tab, its calls and the question to the explain hook', async () => {
    const tab = await currentTab(db, ctx.tab.agent, 500, now++)
    await recordCall(db, { agent: ctx.tab.agent, tab, tool: 'alpha', args: {}, result: {}, price_cents: 25, status: 'BILLABLE', duration_ms: 1, now: now++ })
    const calls = await db.prepare('SELECT * FROM calls WHERE tab_id = ?').bind(tab.id).all<any>()
    const explain = async (...args: Parameters<NonNullable<typeof ctx.tab.explain>>) => {
      expect(args[0]).toMatchObject({ id: tab.id })
      expect(args[1]).toHaveLength(1)
      expect(args[1][0]).toMatchObject(calls.results[0])
      expect(args[2]).toBe('Why is my bill this amount?')
      return { answer: 'The call cost 25 cents.', cited: [1] }
    }
    const result = await explainBillTool.run({ tab_id: tab.id }, { tab: { ...ctx.tab, explain } })
    expect(result.content[0].text).toBe('The call cost 25 cents.')
    expect(result.structuredContent).toMatchObject({ answer: 'The call cost 25 cents.', cited_call_ids: [1] })
  })

  it('rejects an explicit tab owned by another agent', async () => {
    const other = await createAgent(db, 'ws2', 'Agent B', 'hash-b', now++, 'agt_b')
    const tab = await currentTab(db, other, 500, now++)
    const result = await explainBillTool.run({ tab_id: tab.id }, { tab: { ...ctx.tab, explain: async () => ({ answer: 'no', cited: [] }) } })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('No such tab of yours.')
  })
})

describe('report_bad_answer', () => {
  it('reports when claims are not configured', async () => {
    const result = await reportBadAnswer.run({ call_id: 3, reason: 'wrong answer' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('Claims are not set up on this server.')
  })

  it('passes the agent, numeric call ID and reason, then returns the claim result', async () => {
    const claim = async (...args: Parameters<NonNullable<typeof ctx.tab.claim>>) => {
      expect(args).toEqual([ctx.tab.agent, 7, 'wrong answer'])
      return { message: 'Call refunded.', state: 'PAID', refund_id: 'refund_1' }
    }
    const result = await reportBadAnswer.run({ call_id: '7', reason: 'wrong answer' }, { tab: { ...ctx.tab, claim } })
    expect(result.content[0].text).toBe('Call refunded.')
    expect(result.structuredContent).toEqual({ state: 'PAID', refund_id: 'refund_1' })
  })

  it('turns a thrown claim error into an error result', async () => {
    const claim = async () => { throw new Error('claim unavailable') }
    const result = await reportBadAnswer.run({ call_id: 7, reason: 'wrong answer' }, { tab: { ...ctx.tab, claim } })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('claim unavailable')
  })
})


describe('set_budget', () => {
  it('sets only the calling agent limits and reports them even before a tab', async () => {
    const other = await createAgent(db, 'ws1', 'Other', 'other', now++)
    const tool = agentTools.find(t => t.name === 'set_budget')!
    expect(tool).toBeDefined()
    expect((await tool.run({ monthly_cents: 500, max_call_cents: 25 }, ctx)).structuredContent).toMatchObject({ budget_month_cents: 500, budget_call_cents: 25, spent_cents: 0 })
    expect((await myTab.run({}, ctx)).structuredContent).toMatchObject({ budget_month_cents: 500, budget_call_cents: 25, budget_left: 500 })
    expect(await db.prepare('SELECT budget_month_cents FROM agents WHERE id = ?').bind(other.id).first('budget_month_cents')).toBeNull()
    const tab = await currentTab(db, ctx.tab.agent, 500, now++)
    await recordCall(db, { agent: ctx.tab.agent, tab, tool: 'alpha', args: {}, result: {}, price_cents: 25, status: 'BILLABLE', duration_ms: 1, now: now++ })
    expect((await tool.run({ max_call_cents: 10 }, ctx)).structuredContent).toMatchObject({ budget_month_cents: 500, budget_call_cents: 10, spent_cents: 25 })
    expect((await myTab.run({}, ctx)).structuredContent?.budget_left).toBe(475)
  })
  it.each([{ monthly_cents: -1 }, { monthly_cents: 100001 }, { max_call_cents: 10001 }, { max_call_cents: 1.5 }, { monthly_cents: '5' }])('rejects bad limits %j', async args => {
    const tool = agentTools.find(t => t.name === 'set_budget')!
    expect(tool).toBeDefined()
    expect((await tool.run(args, ctx)).isError).toBe(true)
  })
})
