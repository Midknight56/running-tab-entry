// Wiring: the PayPal client, the model gate and the demo seller's MCP server, built per request from the Env.
import { McpServer } from 'mcp-on-workers'
import type { Env } from './env'
import { PayPalClient } from './paypal/client'
import { writeTrace } from './trace'
import { ModelGate } from './ai/model'
import { utcDay } from './ai/budget'
import { makeModelAudit } from './audit/auditor'
import { makeClaimJudge } from './claims/judge'
import { fileClaim } from './claims/claims'
import { explainBill } from './bill/explain'
import { billNote } from './bill/note'
import { tabFacts } from './bill/facts'
import { withTab, type TabCtx } from './tab/with-tab'
import { agentTools } from './tab/agent-tools'
import { agentByKeyHash, callsOfTab, type Agent, type Tab } from './tab/ledger'
import { businessDays, convertTime, convertedTime, type Fault, type SellerCtx } from './demo/seller'
import { DEMO_THRESHOLD_CENTS, bump, ipDayHash, readCookie, sha256Hex } from './demo/workspace'

export type AppCtx = TabCtx & SellerCtx

export const PRICES = { business_days: 5, convert_time: 25 } as const
// 5 demo runs x 34 calls = 170, so 400 leaves room for a judge's own MCP client while bounding D1 writes per key.
export const AGENT_CALLS_PER_DAY = 400
export const KEY_CALLS_PER_DAY = 100
export const KEY_TABS = 2
// One sandbox app is shared by three apps, so orders and refunds have per network daily caps.
export const ORDERS_PER_IP_PER_DAY = 20
// The shared sandbox app took 40 orders in one minute with no 429 (probe, 2026-11-04T00:11Z, 75 orders, all 201);
// three apps share it, so Running Tab takes half.
export const ORDERS_PER_MINUTE_ALL = 20
export const REFUNDS_PER_IP_PER_DAY = 10

export async function isOwner(env: Env, request: Request): Promise<boolean> {
  if (!env.RT_OWNER_KEY || env.RT_OWNER_KEY.length < 32) return false
  const cookie = readCookie(request, 'rt_owner')
  if (!cookie) return false
  const encoder = new TextEncoder()
  const [expected, supplied] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(env.RT_OWNER_KEY)),
    crypto.subtle.digest('SHA-256', encoder.encode(cookie)),
  ])
  const a = new Uint8Array(expected)
  const b = new Uint8Array(supplied)
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? '127.0.0.1'
}

export async function visitorHash(env: Env, request: Request, now: number): Promise<string> {
  return ipDayHash(clientIp(request), env.SESSION_SECRET, utcDay(now))
}

export function paypal(env: Env, wsId?: string): PayPalClient {
  return new PayPalClient({
    base: env.PAYPAL_BASE, clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET, kv: env.RT_KV,
    trace: (row) => writeTrace(env.DB, { ...row, ws_id: row.ws_id ?? wsId }, [env.PAYPAL_CLIENT_ID]).then(() => undefined),
  })
}

export function gate(env: Env, visitor: string, wsId: string, now: () => number, key?: string): ModelGate {
  return new ModelGate({ db: env.DB, ai: env.AI, mode: env.AI_MODE === 'live' ? 'live' : 'replay', visitor, wsId, key, day: () => utcDay(now()), ledger: env.LEDGER, now })
}

/** The bill note for a tab, from the model when the budget allows, else the template. */
export async function noteFor(env: Env, visitor: string, tab: Tab, now: () => number): Promise<string> {
  const calls = await callsOfTab(env.DB, tab.id)
  return (await billNote(gate(env, visitor, tab.ws_id, now), tabFacts(tab, calls))).text
}

const FAULTS: Fault[] = ['empty', 'error', 'off', 'slow', 'incomplete', 'wrong', 'inject', 'vague']

export function sellerServer(env: Env, now: () => number = Date.now) {
  const requestBodies = new WeakMap<Request, unknown>()
  const authenticated = new WeakMap<Request, Agent>()
  async function authenticate(request: Request): Promise<Agent> {
    const auth = request.headers.get('Authorization') ?? ''
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    const agent = key.startsWith('rt_agent_') ? await agentByKeyHash(env.DB, await sha256Hex(key)) : null
    if (!agent) throw new Error('Unknown agent key. Get one from the desk.')
    if (agent.kind === 'judge' && agent.expires_at != null && agent.expires_at <= now()) {
      throw new Error('This agent key has expired. Get a new one from the desk.')
    }
    return agent
  }
  const tools = [
    withTab<AppCtx>(businessDays as never, { price_cents: PRICES.business_days }),
    withTab<AppCtx>(convertTime as never, {
      price_cents: PRICES.convert_time, audit: 'model',
      requires: (args, answer) => {
        if (!/\b\d{2}:\d{2}\b/.test(answer)) return null
        if (typeof args.date !== 'string' || !args.date.trim()) return null
        const converted = convertedTime(args.date, String(args.time ?? ''), String(args.from ?? ''), String(args.to ?? ''))
        return answer.includes(converted.date) ? null : 'The request asked for a date; the answer gives none.'
      },
    }),
    ...agentTools,
  ]
  const server = new McpServer<AppCtx>({
    info: { name: 'running-tab-demo-seller', title: 'Running Tab demo seller', version: '1.0.0', description: 'Two priced tools on a tab, and the free tab tools.' },
    instructions: 'business_days costs 5 cents and convert_time costs 25 cents. Calls run up a tab. When the tab is due, calls answer TAB_DUE with a pay link until it is paid. Struck calls are never billed. my_tab, explain_bill, report_bad_answer and set_budget are free.',
    tools: tools as never,
    secret: env.SESSION_SECRET,
    allowOrigin: () => false,
    context: async (request) => {
      const agent = authenticated.get(request)!
      const body = requestBodies.get(request) as { method?: string; params?: { name?: string } } | undefined
      if (body?.method === 'tools/call' && (body.params?.name === 'business_days' || body.params?.name === 'convert_time')) {
        if (agent.kind === 'judge') {
          const tabs = (await env.DB.prepare('SELECT state FROM tabs WHERE agent_id = ?').bind(agent.id).all<{ state: string }>()).results
          if (tabs.length >= KEY_TABS && tabs.every(t => t.state === 'PAID')) {
            throw new Error('This key has run up its two tabs. Get a new key from the desk.')
          }
        }
        const limit = agent.kind === 'judge' ? KEY_CALLS_PER_DAY : AGENT_CALLS_PER_DAY
        if (!(await bump(env.DB, `agent:${agent.id}:${utcDay(now())}:calls`, limit))) {
          throw new Error(`This agent key has used its ${limit} calls for today. It works again tomorrow.`)
        }
      }
      const visitor = await visitorHash(env, request, now())
      const origin = new URL(request.url).origin
      const g = gate(env, visitor, agent.ws_id, now, agent.kind === 'judge' ? agent.id : undefined)
      const f = request.headers.get('X-RT-Demo-Fault') as Fault | null
      const ctx: AppCtx = {
        fault: f && FAULTS.includes(f) ? f : undefined,
        tab: {
          db: env.DB, agent, origin, thresholdCents: DEMO_THRESHOLD_CENTS, now, signingKey: env.LEDGER_SIGNING_KEY,
          modelAudit: makeModelAudit(g),
          explain: async (tab, calls, question) => explainBill(g, tab, calls, question),
          claim: (a: Agent, seq: number, reason: string) => claimFor(env, g, visitor, a, seq, reason, now),
        },
      }
      return ctx
    },
  })
  return {
    handle: async (request: Request) => {
      let body: unknown
      try { body = await request.clone().json() } catch { body = undefined }
      try { authenticated.set(request, await authenticate(request)) }
      catch (error) {
        const message = (error as Error).message
        const rpc = body as { id?: unknown; method?: string } | undefined
        const result = rpc?.method === 'tools/call'
          ? { result: { isError: true, content: [{ type: 'text', text: message }] } }
          : { error: { code: -32001, message } }
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc?.id ?? null, ...result }),
          { status: rpc?.method === 'tools/call' ? 200 : 401, headers: { 'Content-Type': 'application/json' } })
      }
      requestBodies.set(request, body)
      try { return await server.handle(request) } finally { requestBodies.delete(request); authenticated.delete(request) }
    },
  }
}

export function refundLimitedPayPal(env: Env, visitor: string, wsId: string, now: () => number): Pick<PayPalClient, 'request'> {
  const pp = paypal(env, wsId)
  return {
    request: async (...a: Parameters<PayPalClient['request']>): Promise<any> => {
      if (a[0] === 'POST' && a[1].endsWith('/refund') && !(await bump(env.DB, `ip:${visitor}:${utcDay(now())}:refund`, REFUNDS_PER_IP_PER_DAY))) {
        return { status: 429, body: { name: 'DEMO_REFUND_LIMIT' }, name: 'DEMO_REFUND_LIMIT' }
      }
      return pp.request(...a)
    },
  }
}

export async function claimFor(env: Env, g: ModelGate, visitor: string, agent: Agent, seq: number, reason: string, now: () => number) {
  const r = await fileClaim({ db: env.DB, pp: refundLimitedPayPal(env, visitor, agent.ws_id, now), judge: makeClaimJudge(g), now, signingKey: env.LEDGER_SIGNING_KEY }, agent, seq, reason)
  return {
    message: r.message, state: r.claim.state, refund_id: r.claim.refund_id,
    evidence: r.claim.evidence, reason_code: r.claim.reason_code, verdict: r.claim.verdict,
  }
}
