// The scripted buyer agent. It speaks MCP to the demo seller like any outside agent would, with its own key. Faults
// are injected on fixed calls through the labelled X-RT-Demo-Fault header, so every run tells the same story:
//   calls 9 (EMPTY) and 14 (ERROR) are struck by code, call 21 (OFF_REQUEST) by the model auditor,
//   call 23 is slow (2.5 s) and the agent's client retries it as call 24 with the same arguments,
//   call 30 takes the tab past $5.00, and the next call answers TAB_DUE.
// After the tab is paid, the agent claims call 24 was a double bill and asks explain_bill why it paid what it paid.
import type { Fault } from './seller'

export interface Step { tool: 'business_days' | 'convert_time'; args: Record<string, string>; fault?: Fault }

const ct = (time: string, from: string, to: string, date = '2026-10-23') => ({ tool: 'convert_time' as const, args: { time, date, from, to } })
const bd = (start: string, end: string) => ({ tool: 'business_days' as const, args: { start, end } })

const A = ct('09:00', 'America/Halifax', 'Europe/London')
const B = ct('14:30', 'America/New_York', 'Asia/Tokyo')
const C = ct('08:15', 'Europe/Berlin', 'America/Los_Angeles')
const D = ct('17:45', 'Australia/Sydney', 'Europe/Paris')
const E = ct('12:00', 'Asia/Kolkata', 'America/Chicago')
const F = ct('10:00', 'America/Halifax', 'Europe/London')
const G = ct('16:00', 'America/Toronto', 'Europe/Dublin')

/** Thirty calls. Index 0 is call 1. */
export const SCRIPT: Step[] = [
  A, bd('2026-10-20', '2026-10-27'), B, C, bd('2026-11-02', '2026-11-16'), D, E, A,
  { ...bd('2026-12-01', '2026-12-08'), fault: 'empty' },
  B, C, bd('2026-10-01', '2026-10-31'), D,
  { ...bd('2026-11-01', '2026-11-30'), fault: 'error' },
  E, A, bd('2026-12-14', '2026-12-24'), B, bd('2027-01-04', '2027-01-15'), bd('2026-10-26', '2026-10-31'),
  { ...F, fault: 'off' },
  D,
  { ...G, fault: 'slow' },
  G,
  bd('2026-11-09', '2026-11-13'), E, A, bd('2026-11-16', '2026-11-27'), B, C,
]

export const CLAIMED_CALL = 24
export const CLAIM_TEXT = 'Call 24 was a retry of call 23 after my client timed out. I was billed twice for the same request.'

export interface StepLog { n: number; tool: string; status?: string; reason_code?: string | null; total_cents?: number; tab_state?: string; due?: { pay_url: string; amount: string }; text?: string }

/** A small MCP client over a handler, so the demo agent goes through exactly the path an outside agent uses. */
export class McpClient {
  private sid = ''
  private id = 0
  constructor(private handle: (r: Request) => Promise<Response>, private url: string, private key: string, private extraHeaders: Record<string, string> = {}) {}

  private async rpc(method: string, params: unknown, headers: Record<string, string> = {}): Promise<any> {
    const res = await this.handle(new Request(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + this.key,
        'MCP-Protocol-Version': '2025-11-25', ...(this.sid ? { 'MCP-Session-Id': this.sid } : {}), ...this.extraHeaders, ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
    }))
    const sid = res.headers.get('MCP-Session-Id')
    if (sid) this.sid = sid
    const j = (await res.json()) as any
    if (j.error) throw new Error(j.error.message)
    return j.result
  }

  async init() {
    await this.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'running-tab-demo-agent', version: '1.0.0' } })
  }

  call(name: string, args: Record<string, unknown>, fault?: Fault) {
    return this.rpc('tools/call', { name, arguments: args }, fault ? { 'X-RT-Demo-Fault': fault } : {})
  }
}

/** Phase one: the thirty calls, then one more that answers TAB_DUE. Stops at the first TAB_DUE. */
export async function runCalls(client: McpClient, onStep?: (s: StepLog) => void | Promise<void>, from = 1): Promise<{ steps: StepLog[]; due?: { pay_url: string; amount: string } }> {
  await client.init()
  const steps: StepLog[] = []
  const plan: Step[] = [...SCRIPT, A]
  for (let i = from - 1; i < plan.length; i++) {
    const s = plan[i]
    const r = await client.call(s.tool, s.args, s.fault)
    const meta = r?._meta?.['running-tab/call']
    const log: StepLog = meta
      ? { n: meta.seq, tool: s.tool, status: meta.status, reason_code: meta.reason_code, total_cents: meta.tab_total_cents, tab_state: meta.tab_state }
      : { n: i + 1, tool: s.tool, text: r?.content?.[0]?.text }
    if (r?.structuredContent?.code === 'TAB_DUE') {
      log.due = { pay_url: r.structuredContent.pay_url, amount: r.structuredContent.amount }
      log.status = 'TAB_DUE'
      steps.push(log)
      await onStep?.(log)
      return { steps, due: log.due }
    }
    steps.push(log)
    await onStep?.(log)
  }
  return { steps }
}

/** Phase two, after the tab is paid: the claim on call 24, then explain_bill, then one call on the new tab. */
export async function runAfterPay(client: McpClient, question: string): Promise<{ claim: any; explain: any; next: any }> {
  await client.init()
  const claim = await client.call('report_bad_answer', { call_id: CLAIMED_CALL, reason: CLAIM_TEXT })
  const explain = await client.call('explain_bill', { question })
  const next = await client.call(A.tool, A.args)
  return { claim: claim.structuredContent ?? claim, explain: explain.structuredContent ?? explain, next: next?._meta?.['running-tab/call'] }
}
