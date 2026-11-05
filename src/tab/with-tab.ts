// The add on. withTab(tool, { price_cents }) wraps any mcp-on-workers tool: each call is logged with its price,
// audited, and added to the agent's tab. When the tab reaches its threshold the call that crossed it is served and the
// next call answers TAB_DUE with a pay link, until the tab is paid.
//
// This folder imports nothing outside itself and the kit, so it can move into the kit unchanged.
import type { Tool, ToolResult } from 'mcp-on-workers'
import { currentTab, recordCall, releaseCall, reserveCall, unpaidTab, type Agent, type Call, type Tab } from './ledger'
import { monthSpend } from './budgets'
import { cents, dollars } from './pricing'
import { codeRules } from './rules'

export interface AuditOutcome {
  status: 'BILLABLE' | 'STRUCK' | 'PENDING_AUDIT'
  reason_code?: string
  evidence?: string
  judged_by?: 'code' | 'model' | 'claim'
}

/** What the model auditor sees: one request and one answer. */
export interface AuditInput { tool: string; args: unknown; answer_text: string; structured?: unknown; price_cents: number; ws_id: string }

export interface TabRuntime {
  db: D1Database
  agent: Agent
  /** Where pay links point, such as https://running-tab.example.workers.dev */
  origin: string
  thresholdCents: number
  signingKey?: string
  /** Judges calls that no code rule settled, for tools marked audit: "model". */
  modelAudit?: (input: AuditInput) => Promise<AuditOutcome>
  /** Answers explain_bill for one of this agent's tabs. */
  explain?: (tab: Tab, calls: Call[], question: string) => Promise<{ answer: string; cited: number[] }>
  /** Files report_bad_answer for one of this agent's calls. */
  claim?: (agent: Agent, seq: number, reason: string) => Promise<{ message: string; state: string; refund_id?: string | null }>
  now?: () => number
}

export interface TabCtx { tab: TabRuntime }

export interface TabOptions {
  price_cents: number
  audit?: 'code' | 'model'
  requires?: (args: Record<string, unknown>, answer: string) => string | null
}

export type TabbedTool<C> = Tool<C> & { tab: TabOptions }

export const META_KEY = 'running-tab/call'

const agentQueues = new Map<string, Promise<void>>()

async function serialForAgent<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = agentQueues.get(key) ?? Promise.resolve()
  let release!: () => void
  const queued = new Promise<void>((resolve) => { release = resolve })
  agentQueues.set(key, queued)
  await previous
  try {
    return await work()
  } finally {
    release()
    if (agentQueues.get(key) === queued) agentQueues.delete(key)
  }
}

export function payUrl(origin: string, tabId: string) {
  return `${origin.replace(/\/$/, '')}/pay/${tabId}`
}

export function tabDue(origin: string, tab: Tab): ToolResult {
  const pay_url = payUrl(origin, tab.id)
  return {
    content: [{ type: 'text', text: `Your tab of ${dollars(tab.total_cents)} is due. Pay it at ${pay_url} and calls resume once it is paid.` }],
    structuredContent: { code: 'TAB_DUE', tab_id: tab.id, total_cents: tab.total_cents, amount: cents(tab.total_cents), currency: 'USD', pay_url },
    isError: true,
  }
}

export function withTab<C extends TabCtx>(tool: Tool<C>, opts: TabOptions): TabbedTool<C> {
  if (!Number.isInteger(opts.price_cents) || opts.price_cents < 0) throw new Error(`${tool.name}: price_cents must be whole cents`)
  return {
    ...tool,
    tab: opts,
    async run(args, ctx) {
      const rt = ctx.tab
      return serialForAgent(`${rt.agent.ws_id}:${rt.agent.id}`, async () => {
        const now = rt.now ?? Date.now
        const existing = await unpaidTab(rt.db, rt.agent)
        if (opts.price_cents > 0 && existing?.state === 'DUE') return tabDue(rt.origin, existing)
        const refusal = async (): Promise<ToolResult | null> => {
          if (opts.price_cents === 0) return null
          const max = rt.agent.budget_call_cents
          if (max != null && opts.price_cents > max) return {
            isError: true,
            content: [{ type: 'text', text: `This call costs ${opts.price_cents}c, over your ${max}c limit per call. Nothing was billed.` }],
            structuredContent: { code: 'OVER_BUDGET', limit: 'per_call', price_cents: opts.price_cents, max_call_cents: max },
          }
          const monthly = rt.agent.budget_month_cents
          if (monthly == null) return null
          const spent = await monthSpend(rt.db, rt.agent.id, now(), true)
          const left = Math.max(0, monthly - spent)
          if (spent + opts.price_cents <= monthly) return null
          return {
            isError: true,
            content: [{ type: 'text', text: `Your monthly budget of ${dollars(monthly)} has ${dollars(left)} left. This call costs ${opts.price_cents}c. Nothing was billed.` }],
            structuredContent: { code: 'OVER_BUDGET', limit: 'monthly', price_cents: opts.price_cents, budget_month_cents: monthly, spent_cents: spent, budget_left: left },
          }
        }
        const overBudget = await refusal()
        if (overBudget) return overBudget
        const tab = existing ?? await currentTab(rt.db, rt.agent, rt.thresholdCents, now())
        if (opts.price_cents > 0 && tab.state === 'DUE') return tabDue(rt.origin, tab)
        if (opts.price_cents > 0 && !(await reserveCall(rt.db, tab.id, opts.price_cents, now(), rt.agent))) {
          const latest = await currentTab(rt.db, rt.agent, rt.thresholdCents, now())
          if (latest.state === 'DUE') return tabDue(rt.origin, latest)
          return (await refusal()) ?? tabDue(rt.origin, latest)
        }

        const started = now()
        let result: ToolResult
        try {
          result = await tool.run(args, ctx)
        } catch (e) {
          result = { content: [{ type: 'text', text: 'The tool failed: ' + (e as Error).message }], isError: true }
        }
        const duration = Math.max(0, now() - started)

        let outcome: AuditOutcome
        let rule: { reason_code: string; evidence: string } | null = codeRules(result, tool.outputSchema)
        if (!rule && opts.requires) {
          try {
            const evidence = opts.requires(args, textOf(result))
            if (evidence !== null) rule = { reason_code: 'INCOMPLETE', evidence }
          } catch { /* A broken seller rule does not block billing. */ }
        }
        if (rule) outcome = { status: 'STRUCK', reason_code: rule.reason_code, evidence: rule.evidence, judged_by: 'code' }
        else if (opts.audit === 'model') {
          outcome = rt.modelAudit
            ? await rt.modelAudit({
              tool: tool.name, args, answer_text: textOf(result), structured: result.structuredContent,
              price_cents: opts.price_cents, ws_id: rt.agent.ws_id,
            }).catch((): AuditOutcome => ({ status: 'PENDING_AUDIT' }))
            : { status: 'PENDING_AUDIT' }
        } else outcome = { status: 'BILLABLE' }

        const recorded = await recordCall(rt.db, {
          agent: rt.agent, tab, tool: tool.name, args, result: { content: result.content, structuredContent: result.structuredContent, isError: result.isError },
          price_cents: opts.price_cents, status: outcome.status, reason_code: outcome.reason_code,
          evidence: outcome.evidence, judged_by: outcome.judged_by, duration_ms: duration, now: now(), reserved: true, signingKey: rt.signingKey,
        }).catch(async (e) => {
          // A call that could not be written is not billed: give its reserved price back.
          if (!(e instanceof Error && (e as Error & { callWritten?: boolean }).callWritten)) {
            await releaseCall(rt.db, tab.id, opts.price_cents)
          }
          throw e
        })
        const { call, tab: after } = recorded
        return withMeta(result, call, after)
      })
    },
  }
}

export function textOf(r: ToolResult): string {
  return (r.content ?? []).map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n')
}

function withMeta(result: ToolResult, call: Call, tab: Tab): ToolResult {
  const meta = {
    call_id: call.id, seq: call.seq, price_cents: call.price_cents, status: call.status, reason_code: call.reason_code,
    tab_id: tab.id, tab_total_cents: tab.total_cents, tab_state: tab.state,
  }
  return { ...result, _meta: { [META_KEY]: meta } } as ToolResult
}
