import { describe, expect, it } from 'vitest'
import { explainBill, MAX_ROUNDS } from '../src/bill/explain'
import type { Call, Tab } from '../src/tab/ledger'

const tab: Tab = {
  id: 'tab_1', ws_id: 'ws1', agent_id: 'agt_1', state: 'PAID', total_cents: 55, threshold_cents: 50, order_id: 'O', capture_id: 'C',
  captured_cents: 55, refunded_cents: 25, note: null, created_at: 1, due_at: 2, paid_at: 3,
}
const call = (seq: number, tool: string, price: number, status: Call['status'], reason: string | null = null): Call => ({
  id: 'c' + seq, seq, ws_id: 'ws1', agent_id: 'agt_1', tab_id: 'tab_1', tool, args_json: '{}', result_json: '{}', price_cents: price,
  status, reason_code: reason, evidence: null, judged_by: reason ? 'code' : null, duration_ms: 0, created_at: seq,
})
const calls = [call(1, 'convert_time', 25, 'BILLABLE'), call(2, 'business_days', 5, 'BILLABLE'), call(3, 'business_days', 5, 'STRUCK', 'EMPTY'), call(4, 'convert_time', 25, 'REFUNDED')]

function gate(replies: string[]) {
  const asked: unknown[] = []
  return { asked, async ask(_j: string, messages: unknown) { asked.push(JSON.parse(JSON.stringify(messages))); const t = replies.shift(); return t === undefined ? null : { text: t, source: 'live', neurons: 1 } } }
}

describe('explain_bill', () => {
  it('answers with cited calls when the model cites calls of this tab', async () => {
    const g = gate(['{"answer": "Calls 1, 2 and 4 were billed. Call 3 was struck.", "cited_call_ids": [1, 2, 3, 4]}'])
    const r = await explainBill(g as any, tab, calls, 'Why 0.55?')
    expect(r.used_template).toBe(false)
    expect(r.cited).toEqual([1, 2, 3, 4])
    expect(r.answer).toBe('This tab came to $0.55 for 3 calls; $0.25 was refunded, so the net paid is $0.30. Calls 1, 2 and 4 were billed. Call 3 was struck.')
  })

  it('gives the template when the model cites no calls', async () => {
    const r = await explainBill(gate(['{"answer": "Because.", "cited_call_ids": []}']) as any, tab, calls, 'Why?')
    expect(r.used_template).toBe(true)
    expect(r.answer).toContain('$0.55')
  })

  it('gives the template when the answer holds a figure the ledger does not hold', async () => {
    const r = await explainBill(gate(['{"answer": "You owe $9.99 for call 1.", "cited_call_ids": [1]}']) as any, tab, calls, 'Why?')
    expect(r.used_template).toBe(true)
  })

  it('runs the tools the model asks for, and stops after three rounds', async () => {
    const ask = '{"tool": "list_calls", "args": {"status": "STRUCK"}}'
    const g = gate([ask, ask, ask, ask, ask])
    const r = await explainBill(g as any, tab, calls, 'Why?')
    expect(MAX_ROUNDS).toBe(3)
    expect(g.asked).toHaveLength(3)
    expect(r.used_template).toBe(true)
    expect((g.asked[1] as any[]).at(-1).content).toContain('"seq":3')
  })

  it('never shows a call outside this tab through get_call', async () => {
    const g = gate(['{"tool": "get_call", "args": {"call_id": 99}}', '{"answer": "Call 1 was billed.", "cited_call_ids": [1]}'])
    const r = await explainBill(g as any, tab, calls, 'What about 99?')
    expect(JSON.stringify(g.asked[1])).toContain('not in this tab')
    expect(r.used_template).toBe(false)
  })

  it('gives the template when there is no model answer at all', async () => {
    expect((await explainBill(null, tab, calls, 'Why?')).used_template).toBe(true)
  })
})

it('uses the correct net when a reason swaps captured and net amounts', async () => {
  const paid = { ...tab, total_cents: 515, captured_cents: 515 }
  const rows = [call(1, 'convert_time', 490, 'BILLABLE'), call(4, 'convert_time', 25, 'REFUNDED')]
  const r = await explainBill(gate([JSON.stringify({ answer: 'After the $0.25 refund, your final amount paid is $5.15.', cited_call_ids: [4] })]) as any, paid, rows, 'What did I pay?')
  expect(r.used_template).toBe(true)
  expect(r.answer).toContain('net paid is $4.90')
  expect(r.answer).not.toContain('amount paid is $5.15')
})

it('keeps the existing template when there is no model answer', async () => {
  const r = await explainBill(null, tab, calls, 'Why?')
  expect(r.answer).toBe('This tab came to $0.55 for 3 calls: 2 convert_time calls at $0.25 and 1 business_days calls at $0.05. Calls 3 were struck and not billed. $0.25 was refunded, so the net paid is $0.30.')
})

it('describes reserved refunds as pending without lowering the net paid', async () => {
  const rows = calls.map(c => c.status === 'REFUNDED' ? { ...c, status: 'BILLABLE' as const } : c)
  const r = await explainBill(gate(['{"answer":"Call 3 was struck.","cited_call_ids":[3]}']) as any, tab, rows, 'Why?')
  expect(r.answer).toContain('$0.25 is pending at PayPal')
  expect(r.answer).not.toContain('was refunded')
})

describe('explain_bill words that contradict the ledger', () => {
  it('gives the template when the answer denies a refund the ledger holds', async () => {
    const g = { async ask() { return { text: '{"answer": "Calls 1 and 2 were billed. No refunds were applied.", "cited_call_ids": [1, 2]}', source: 'live', neurons: 1 } } }
    const r = await explainBill(g as any, tab, calls, 'Why?')
    expect(r.used_template).toBe(true)
    expect(r.answer).toContain('$0.25 was refunded')
  })
})
