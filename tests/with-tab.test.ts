import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tool } from 'mcp-on-workers'
import { withTab, type TabCtx } from '../src/tab/with-tab'
import { cents, sumCents } from '../src/tab/pricing'
import { createAgent } from '../src/tab/ledger'
import { fakeD1, type FakeD1 } from './helpers/d1'

interface Ctx extends TabCtx { fail?: 'empty' | 'error' | 'shape' | 'throw' }

const echo: Tool<Ctx> = {
  name: 'echo', title: 'Echo', description: 'Echoes.',
  inputSchema: { type: 'object', properties: { s: { type: 'string' } }, required: ['s'] },
  outputSchema: { type: 'object', properties: { s: { type: 'string' } }, required: ['s'] },
  async run(args, ctx) {
    if (ctx.fail === 'empty') return { content: [{ type: 'text', text: '  ' }] }
    if (ctx.fail === 'error') return { content: [{ type: 'text', text: 'boom' }], isError: true }
    if (ctx.fail === 'shape') return { content: [{ type: 'text', text: 'x' }], structuredContent: { nope: 1 } }
    if (ctx.fail === 'throw') throw new Error('kaput')
    return { content: [{ type: 'text', text: String(args.s) }], structuredContent: { s: String(args.s) } }
  },
}

let db: FakeD1
let ctx: Ctx
let t = 1_000

beforeEach(async () => {
  db = fakeD1()
  const a = await createAgent(db, 'ws1', 'Agent A', 'hash-a', t)
  ctx = { tab: { db, agent: a, origin: 'https://rt.example', thresholdCents: 500, now: () => t++ } }
})

describe('pricing', () => {
  it('20 calls at 25 cents is 500 cents, and cents(510) is "5.10"', () => {
    expect(sumCents(Array(20).fill(25))).toBe(500)
    expect(cents(510)).toBe('5.10')
    expect(cents(5)).toBe('0.05')
    expect(() => cents(1.5)).toThrow()
  })
})

describe('withTab', () => {
  it('logs a wrapped call with its price and adds it to the tab', async () => {
    const tool = withTab(echo, { price_cents: 25 })
    const r = await tool.run({ s: 'hi' }, ctx)
    expect(r.isError).toBeFalsy()
    const meta = (r as any)._meta['running-tab/call']
    expect(meta).toMatchObject({ seq: 1, price_cents: 25, status: 'BILLABLE', tab_total_cents: 25 })
    const row = await db.prepare('SELECT * FROM calls').first<any>()
    expect(row).toMatchObject({ tool: 'echo', price_cents: 25, status: 'BILLABLE', args_json: '{"s":"hi"}' })
  })

  it('keeps the reserved charge when sealing fails after the call is written', async () => {
    db.raw.exec(`CREATE TRIGGER fail_chain_head BEFORE INSERT ON chain_heads BEGIN SELECT RAISE(ABORT, 'seal failed'); END`)
    const tool = withTab(echo, { price_cents: 25 })
    await tool.run({ s: 'hi' }, ctx)
    expect(await db.prepare('SELECT status FROM calls').first<string>('status')).toBe('BILLABLE')
    expect(await db.prepare('SELECT total_cents FROM tabs').first<number>('total_cents')).toBe(25)
  })

  it('serves the call that crosses the threshold, then answers TAB_DUE with a pay_url', async () => {
    const tool = withTab(echo, { price_cents: 25 })
    for (let i = 0; i < 19; i++) await tool.run({ s: String(i) }, ctx)
    const crossing = await tool.run({ s: 'twenty' }, ctx)
    expect(crossing.isError).toBeFalsy()
    expect((crossing as any)._meta['running-tab/call']).toMatchObject({ tab_total_cents: 500, tab_state: 'DUE' })
    const next = await tool.run({ s: 'more' }, ctx)
    expect(next.isError).toBe(true)
    expect(next.structuredContent).toMatchObject({ code: 'TAB_DUE', total_cents: 500, amount: '5.00' })
    expect(String(next.structuredContent!.pay_url)).toMatch(/^https:\/\/rt\.example\/pay\/tab_/)
    const n = await db.prepare('SELECT COUNT(*) AS n FROM calls').first<number>('n')
    expect(n).toBe(20)
  })

  it('strikes EMPTY, ERROR and SHAPE by code and never bills them', async () => {
    const tool = withTab(echo, { price_cents: 25 })
    for (const fail of ['empty', 'error', 'shape', 'throw'] as const) {
      const r = await tool.run({ s: 'x' }, { ...ctx, fail })
      expect((r as any)._meta['running-tab/call'].status).toBe('STRUCK')
    }
    const rows = (await db.prepare('SELECT reason_code, judged_by FROM calls ORDER BY seq').all<any>()).results
    expect(rows.map((r) => r.reason_code)).toEqual(['EMPTY', 'ERROR', 'SHAPE', 'ERROR'])
    expect(rows.every((r) => r.judged_by === 'code')).toBe(true)
    const tab = await db.prepare('SELECT total_cents FROM tabs').first<number>('total_cents')
    expect(tab).toBe(0)
  })

  it('leaves a call PENDING_AUDIT and unbilled when the model audit cannot settle it', async () => {
    const tool = withTab(echo, { price_cents: 25, audit: 'model' })
    const r = await tool.run({ s: 'x' }, { ...ctx, tab: { ...ctx.tab, modelAudit: async () => ({ status: 'PENDING_AUDIT' }) } })
    expect((r as any)._meta['running-tab/call'].status).toBe('PENDING_AUDIT')
    expect(await db.prepare('SELECT total_cents FROM tabs').first<number>('total_cents')).toBe(0)
  })

  it('records missing required parts as code strikes before asking the model', async () => {
    const requires = vi.fn(() => 'The requested date is missing.')
    const modelAudit = vi.fn(async () => ({ status: 'BILLABLE' as const }))
    const tool = withTab(echo, { price_cents: 25, audit: 'model', requires })
    const result = await tool.run({ s: 'hi' }, { ...ctx, tab: { ...ctx.tab, modelAudit } })
    expect(requires).toHaveBeenCalledWith({ s: 'hi' }, 'hi')
    expect(modelAudit).not.toHaveBeenCalled()
    expect((result as any)._meta['running-tab/call']).toMatchObject({ status: 'STRUCK', reason_code: 'INCOMPLETE', tab_total_cents: 0 })
    expect(await db.prepare('SELECT status, reason_code, judged_by, evidence FROM calls').first()).toEqual({
      status: 'STRUCK', reason_code: 'INCOMPLETE', judged_by: 'code', evidence: 'The requested date is missing.',
    })
  })

  it.each(['empty', 'error', 'shape', 'throw'] as const)('keeps existing code rules before requires for $0', async (fail) => {
    const requires = vi.fn(() => 'A required part is missing.')
    const modelAudit = vi.fn(async () => ({ status: 'BILLABLE' as const }))
    await withTab(echo, { price_cents: 25, audit: 'model', requires }).run({ s: 'hi' }, { ...ctx, fail, tab: { ...ctx.tab, modelAudit } })
    expect(requires).not.toHaveBeenCalled()
    expect(modelAudit).not.toHaveBeenCalled()
  })

  it.each(['complete', 'throws', 'absent'] as const)('bills normally when requires is $0', async (mode) => {
    const requires = mode === 'absent' ? undefined : vi.fn(() => {
      if (mode === 'throws') throw new Error('Broken seller rule')
      return null
    })
    const modelAudit = vi.fn(async () => ({ status: 'BILLABLE' as const, judged_by: 'model' as const }))
    const result = await withTab(echo, { price_cents: 25, audit: 'model', requires }).run({ s: 'hi' }, { ...ctx, tab: { ...ctx.tab, modelAudit } })
    if (requires) expect(requires).toHaveBeenCalledWith({ s: 'hi' }, 'hi')
    expect(modelAudit).toHaveBeenCalledOnce()
    expect((result as any)._meta['running-tab/call']).toMatchObject({ status: 'BILLABLE', tab_total_cents: 25 })
    expect(await db.prepare('SELECT judged_by FROM calls').first('judged_by')).toBe('model')
  })

  it('keeps each agent on its own tab', async () => {
    const b = await createAgent(db, 'ws2', 'Agent B', 'hash-b', t)
    const tool = withTab(echo, { price_cents: 25 })
    await tool.run({ s: 'a' }, ctx)
    await tool.run({ s: 'b' }, { tab: { ...ctx.tab, agent: b } })
    const tabs = (await db.prepare('SELECT agent_id, ws_id, total_cents FROM tabs ORDER BY ws_id').all<any>()).results
    expect(tabs).toHaveLength(2)
    expect(tabs.map((x) => x.ws_id)).toEqual(['ws1', 'ws2'])
    const seqs = (await db.prepare('SELECT ws_id, seq FROM calls ORDER BY ws_id').all<any>()).results
    expect(seqs.map((s) => s.seq)).toEqual([1, 1])
  })
})


describe('buyer budgets', () => {
  function limits(monthly: number | null, perCall: number | null = null) {
    Object.assign(ctx.tab.agent, { budget_month_cents: monthly, budget_call_cents: perCall })
  }
  const tool = withTab(echo, { price_cents: 25 })
  it('refuses a call over the per call limit without billing', async () => {
    limits(null, 10)
    const r = await tool.run({ s: 'hi' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toEqual({ code: 'OVER_BUDGET', limit: 'per_call', price_cents: 25, max_call_cents: 10 })
    expect(r.content[0].text).toBe('This call costs 25c, over your 10c limit per call. Nothing was billed.')
    expect(await db.prepare('SELECT COUNT(*) AS n FROM calls').first('n')).toBe(0)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tabs').first('n')).toBe(0)
  })
  it('refuses spending beyond the monthly limit', async () => {
    await withTab(echo, { price_cents: 490 }).run({ s: 'hi' }, ctx)
    limits(500)
    const r = await tool.run({ s: 'hi' }, ctx)
    expect(r.structuredContent).toMatchObject({ code: 'OVER_BUDGET', limit: 'monthly', spent_cents: 490, budget_left: 10 })
    expect(r.content[0].text).toBe('Your monthly budget of $5.00 has $0.10 left. This call costs 25c. Nothing was billed.')
    expect(await db.prepare('SELECT COUNT(*) AS n FROM calls').first('n')).toBe(1)
    expect(await db.prepare('SELECT total_cents FROM tabs').first('total_cents')).toBe(490)
  })
  it('excludes struck calls from monthly spend', async () => {
    await tool.run({ s: 'hi' }, { ...ctx, fail: 'empty' })
    limits(25)
    expect((await tool.run({ s: 'hi' }, ctx)).isError).toBeFalsy()
    expect((await tool.run({ s: 'hi' }, ctx)).structuredContent?.code).toBe('OVER_BUDGET')
  })
  it('gives refunded calls back and excludes the previous UTC month', async () => {
    t = Date.UTC(2026, 9, 31, 23, 59)
    await tool.run({ s: 'old' }, ctx)
    t = Date.UTC(2026, 10, 1)
    await tool.run({ s: 'refund' }, ctx)
    await db.prepare("UPDATE calls SET status = 'REFUNDED' WHERE seq = 2").run()
    await db.prepare("UPDATE tabs SET state = 'PAID', captured_cents = 50, refunded_cents = 25").run()
    limits(25)
    expect((await tool.run({ s: 'hi' }, ctx)).isError).toBeFalsy()
    expect((await tool.run({ s: 'hi' }, ctx)).structuredContent?.code).toBe('OVER_BUDGET')
  })
  it('keeps TAB_DUE ahead of budget refusal', async () => {
    await withTab(echo, { price_cents: 500 }).run({ s: 'hi' }, ctx)
    limits(0, 0)
    expect((await tool.run({ s: 'hi' }, ctx)).structuredContent?.code).toBe('TAB_DUE')
    await db.prepare("UPDATE tabs SET state = 'PAID'").run()
    expect((await tool.run({ s: 'hi' }, ctx)).structuredContent?.code).toBe('OVER_BUDGET')
  })
  it('allows only one racing call to spend the last cents', async () => {
    limits(25)
    const results = await Promise.all([tool.run({ s: 'one' }, ctx), tool.run({ s: 'two' }, ctx)])
    expect(results.filter(r => r.structuredContent?.code === 'OVER_BUDGET')).toHaveLength(1)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM calls').first('n')).toBe(1)
    expect(await db.prepare('SELECT total_cents FROM tabs').first('total_cents')).toBe(25)
  })
  it('never refuses a free call', async () => {
    await withTab(echo, { price_cents: 500 }).run({ s: 'due' }, ctx)
    limits(0, 0)
    expect((await withTab(echo, { price_cents: 0 }).run({ s: 'free' }, ctx)).isError).toBeFalsy()
    expect((await tool.run({ s: 'paid' }, ctx)).structuredContent?.code).toBe('TAB_DUE')
  })
})
