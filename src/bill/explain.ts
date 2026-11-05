// explain_bill: a short tool loop, three rounds at most. The model may call get_tab, list_calls and get_call, all
// limited to this one tab, and must answer {"answer", "cited_call_ids"}. An answer with no cited calls, a call outside
// the tab, or any money figure is replaced by the template. Code writes the amounts.
import { OUTPUT_CAP } from '../ai/budget'
import { sha256, type ChatMessage, type ModelGate } from '../ai/model'
import { checkExplain, parseModelJson } from '../audit/checks'
import { answerText } from '../claims/judge'
import { dollars } from '../tab/pricing'
import type { Call, Tab } from '../tab/ledger'
import { tabFacts, type TabFacts } from './facts'

export const MAX_ROUNDS = 3
const MAX_TOOL_RESULT = 1500

export const EXPLAIN_SYSTEM = [
  'You explain a bill to the AI agent that ran it up. Be short and exact.',
  'You may look things up first by replying with one JSON object: {"tool": "get_tab"} or {"tool": "list_calls", "args": {"status": "BILLABLE" | "STRUCK" | "REFUNDED"}} or {"tool": "get_call", "args": {"call_id": <number>}}.',
  'When you can answer, reply with one JSON object: {"answer": "<at most 3 sentences>", "cited_call_ids": [<the call numbers your answer relies on>]}.',
  'Write only which calls were billed, struck or refunded and why. Never write dollar amounts, cents amounts or other money figures. Code supplies every amount.',
].join('\n')

type Gate = Pick<ModelGate, 'ask'>

export function explainTemplate(f: TabFacts): string {
  const items = f.items.map((i) => `${i.quantity} ${i.name} at ${dollars(i.unit_cents)}`).join(' and ')
  const parts = [`This tab came to ${dollars(f.billed_cents)} for ${f.billable_count} calls: ${items || 'none'}.`]
  if (f.struck.length) parts.push(`Calls ${f.struck.map((s) => s.seq).join(', ')} were struck and not billed.`)
  if (f.refunded_cents) parts.push(`${dollars(f.refunded_cents)} was refunded, so the net paid is ${dollars(f.net_cents)}.`)
  if (f.refund_pending_cents) parts.push(`${dollars(f.refund_pending_cents)} is pending at PayPal.`)
  return parts.join(' ')
}

function amountSentence(f: TabFacts): string {
  const parts = [`This tab came to ${dollars(f.billed_cents)} for ${f.billable_count} calls`]
  if (f.refunded_cents) parts.push(`${dollars(f.refunded_cents)} was refunded, so the net paid is ${dollars(f.net_cents)}`)
  if (f.refund_pending_cents) parts.push(`${dollars(f.refund_pending_cents)} is pending at PayPal`)
  return parts.join('; ') + '.'
}

export async function explainBill(gate: Gate | null, tab: Tab, calls: Call[], question: string): Promise<{ answer: string; cited: number[]; used_template: boolean; rounds: number }> {
  const f = tabFacts(tab, calls)
  const template = explainTemplate(f)
  const summary = {
    tab_id: tab.id, state: tab.state, billed: dollars(f.billed_cents), items: f.items.map((i) => ({ name: i.name, quantity: i.quantity, each: dollars(i.unit_cents) })),
    struck_calls: f.struck.map((s) => ({ call_id: s.seq, reason: s.reason_code })), refunded: dollars(f.refunded_cents),
    paid: dollars(f.captured_cents), net: dollars(f.net_cents), pending_refund: dollars(f.refund_pending_cents),
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: EXPLAIN_SYSTEM },
    { role: 'user', content: JSON.stringify({ question: question.slice(0, 300), bill: summary }) },
  ]
  let rounds = 0
  if (gate) {
    for (; rounds < MAX_ROUNDS;) {
      const reply = await gate.ask('explain_round', messages, OUTPUT_CAP.explain_round, await sha256(JSON.stringify(messages)))
      rounds++
      if (!reply) break
      const obj = parseModelJson(reply.text)
      if (!obj) break
      if (typeof obj.answer === 'string') {
        const r = checkExplain(template, { ...f, answer: obj.answer, cited: obj.cited_call_ids })
        if (!r.used_template && contradicts(r.answer, f)) return { answer: template, cited: [], used_template: true, rounds }
        return { ...r, answer: r.used_template ? r.answer : `${amountSentence(f)} ${r.answer}`, rounds }
      }
      if (typeof obj.tool !== 'string') break
      messages.push({ role: 'assistant', content: JSON.stringify(obj) })
      messages.push({ role: 'user', content: JSON.stringify({ tool_result: runTool(obj.tool, obj.args, f, calls) }).slice(0, MAX_TOOL_RESULT) })
    }
  }
  return { answer: template, cited: [], used_template: true, rounds }
}

function runTool(name: string, args: unknown, f: TabFacts, calls: Call[]): unknown {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const brief = (c: Call) => ({ seq: c.seq, tool: c.tool, price: dollars(c.price_cents), status: c.status, reason: c.reason_code })
  if (name === 'get_tab') return { billed: dollars(f.billed_cents), billable_calls: f.billable_count, struck_calls: f.struck_count, refunded: dollars(f.refunded_cents) }
  if (name === 'list_calls') {
    const status = typeof a.status === 'string' ? a.status : undefined
    return calls.filter((c) => !status || c.status === status).slice(0, 40).map(brief)
  }
  if (name === 'get_call') {
    const c = calls.find((x) => x.seq === Number(a.call_id))
    if (!c) return { error: `Call ${String(a.call_id)} is not in this tab.` }
    return { ...brief(c), request: c.args_json.slice(0, 300), answer: answerText(c.result_json).slice(0, 300), evidence: c.evidence }
  }
  return { error: 'Unknown tool.' }
}

/** Words that deny what the ledger holds: no refund when there was one, or a refund when there was none. */
export function contradicts(answer: string, f: TabFacts): boolean {
  const deniesRefund = /\b(no|zero|without)\s+refunds?\b|\bnot\s+(been\s+)?refunded\b|\bnothing\s+(was\s+)?refunded\b/i.test(answer)
  const statesRefund = /\brefunded \$\d|\$\d+\.\d{2} (was |came )?(refunded|back)\b/i.test(answer)
  return (f.refunded_cents > 0 && deniesRefund) || (f.refunded_cents === 0 && statesRefund)
}

