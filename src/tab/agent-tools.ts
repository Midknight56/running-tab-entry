// The add on's free tools, for the agent that runs up the tab: my_tab, explain_bill, report_bad_answer, set_budget.
import type { Tool, ToolResult } from 'mcp-on-workers'
import { callsOfTab, type Tab } from './ledger'
import { budgetError, budgetSummary, type BudgetInput } from './budgets'
import { cents, dollars } from './pricing'
import { payUrl, type TabCtx } from './with-tab'

async function latestTab(ctx: TabCtx, tabId?: string): Promise<Tab | null> {
  const { db, agent } = ctx.tab
  if (tabId) return db.prepare('SELECT * FROM tabs WHERE id = ? AND agent_id = ?').bind(tabId, agent.id).first<Tab>()
  return db.prepare('SELECT * FROM tabs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1').bind(agent.id).first<Tab>()
}

function say(text: string, structured?: Record<string, unknown>, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}), ...(isError ? { isError: true } : {}) }
}

export const myTab: Tool<TabCtx> = {
  name: 'my_tab', title: 'My tab', description: 'Your current tab: total, threshold, state, struck calls, and the pay link when it is due. Free.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  async run(_args, ctx) {
    const tab = await latestTab(ctx)
    const budget = await budgetSummary(ctx.tab.db, ctx.tab.agent, (ctx.tab.now ?? Date.now)())
    const { spent_cents, ...limits } = budget
    if (!tab) return say('You have no tab yet. Your first priced call opens one.', { state: 'NONE', ...limits })
    const calls = await callsOfTab(ctx.tab.db, tab.id)
    const struck = calls.filter((c) => c.status === 'STRUCK').map((c) => ({ call_id: c.seq, tool: c.tool, reason: c.reason_code }))
    const s = {
      ...limits, tab_id: tab.id, state: tab.state, total: cents(tab.total_cents), threshold: cents(tab.threshold_cents), currency: 'USD',
      calls: calls.length, struck_calls: struck, refunded: cents(tab.refunded_cents),
      ...(tab.state === 'DUE' ? { pay_url: payUrl(ctx.tab.origin, tab.id) } : {}),
    }
    const line = tab.state === 'DUE'
      ? `Your tab of ${dollars(tab.total_cents)} is due. Pay at ${s.pay_url}.`
      : `Your tab is ${tab.state.toLowerCase()} at ${dollars(tab.total_cents)} of ${dollars(tab.threshold_cents)}. ${struck.length} calls struck and not billed.`
    return say(line, s)
  },
}

export const explainBillTool: Tool<TabCtx> = {
  name: 'explain_bill', title: 'Explain my bill', description: 'Ask why your tab came to its total. The answer cites call numbers. Free.',
  inputSchema: {
    type: 'object',
    properties: { question: { type: 'string', maxLength: 300 }, tab_id: { type: 'string', maxLength: 64 } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  async run(args, ctx) {
    const tab = await latestTab(ctx, typeof args.tab_id === 'string' ? args.tab_id : undefined)
    if (!tab) return say('No such tab of yours.', undefined, true)
    if (!ctx.tab.explain) return say('Explanations are not set up on this server.', undefined, true)
    const calls = await callsOfTab(ctx.tab.db, tab.id)
    const r = await ctx.tab.explain(tab, calls, typeof args.question === 'string' ? args.question : 'Why is my bill this amount?')
    return say(r.answer, { tab_id: tab.id, answer: r.answer, cited_call_ids: r.cited })
  },
}

export const reportBadAnswer: Tool<TabCtx> = {
  name: 'report_bad_answer', title: 'Report a bad answer',
  description: 'Claim that one of your billed calls was bad (for example billed twice for a retry). If the log supports it, the call is struck before billing, or refunded through PayPal when the tab is already paid. Free.',
  inputSchema: {
    type: 'object',
    properties: { call_id: { type: 'integer', minimum: 1 }, reason: { type: 'string', minLength: 5, maxLength: 500 } },
    required: ['call_id', 'reason'], additionalProperties: false,
  },
  async run(args, ctx) {
    if (!ctx.tab.claim) return say('Claims are not set up on this server.', undefined, true)
    try {
      const r = await ctx.tab.claim(ctx.tab.agent, Number(args.call_id), String(args.reason))
      return say(r.message, { state: r.state, ...(r.refund_id ? { refund_id: r.refund_id } : {}) })
    } catch (e) {
      return say((e as Error).message, undefined, true)
    }
  },
}

export const setBudget: Tool<TabCtx> = {
  name: 'set_budget', title: 'Set my budget', description: 'Set your monthly spend and maximum call price in cents. Free.',
  inputSchema: {
    type: 'object', properties: {
      monthly_cents: { type: 'integer', minimum: 0, maximum: 100000 },
      max_call_cents: { type: 'integer', minimum: 0, maximum: 10000 },
    }, additionalProperties: false,
  },
  async run(args, ctx) {
    const error = budgetError(args)
    if (error) return say(error, undefined, true)
    const input = args as BudgetInput
    const { db, agent } = ctx.tab
    await db.prepare(`UPDATE agents SET budget_month_cents = COALESCE(?, budget_month_cents),
      budget_call_cents = COALESCE(?, budget_call_cents) WHERE id = ? AND ws_id = ?`)
      .bind(input.monthly_cents ?? null, input.max_call_cents ?? null, agent.id, agent.ws_id).run()
    const summary = await budgetSummary(db, agent, (ctx.tab.now ?? Date.now)())
    Object.assign(agent, { budget_month_cents: summary.budget_month_cents, budget_call_cents: summary.budget_call_cents })
    return say(`Budget saved. This month you have spent ${dollars(summary.spent_cents)}.`, summary)
  },
}

export const agentTools = [myTab, explainBillTool, reportBadAnswer, setBudget]
