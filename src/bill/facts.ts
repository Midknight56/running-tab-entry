// The figures of a tab, computed by code. Reserved refunds are separate from completed refunds.
import type { Call, Tab } from '../tab/ledger'
import { lineItems } from './order-builder'

export interface TabFacts {
  tab_id: string
  state: Tab['state']
  billable_count: number
  struck_count: number
  pending_count: number
  billed_cents: number
  struck_cents: number
  captured_cents: number
  refunded_cents: number
  refund_pending_cents: number
  net_cents: number
  items: { name: string; quantity: number; unit_cents: number; subtotal_cents: number }[]
  struck: { seq: number; tool: string; reason_code: string | null; judged_by: string | null; evidence: string | null }[]
  refunded: { seq: number; price_cents: number }[]
  allowed_cents: number[]
  tab_seqs: number[]
  struck_seqs: number[]
}

export function tabFacts(tab: Tab, calls: Call[]): TabFacts {
  const billedCalls = calls.filter((c) => c.status === 'BILLABLE' || c.status === 'REFUNDED')
  const struck = calls.filter((c) => c.status === 'STRUCK')
  const refunded = calls.filter((c) => c.status === 'REFUNDED')
  const { items } = lineItems(billedCalls.map((c) => ({ ...c, status: 'BILLABLE' as const })))
  const billed = billedCalls.reduce((n, c) => n + c.price_cents, 0)
  const struckCents = struck.reduce((n, c) => n + c.price_cents, 0)
  const its = items.map((i) => {
    const unit = Math.round(Number(i.unit_amount.value) * 100)
    return { name: i.name, quantity: Number(i.quantity), unit_cents: unit, subtotal_cents: unit * Number(i.quantity) }
  })
  const done = refunded.reduce((n, c) => n + c.price_cents, 0)
  const pending = Math.max(0, tab.refunded_cents - done)
  const net = tab.captured_cents - done
  const allowed = new Set<number>([
    tab.total_cents, billed, struckCents, tab.captured_cents, done, pending, net, tab.threshold_cents,
    ...its.flatMap((i) => [i.unit_cents, i.subtotal_cents]), ...calls.map((c) => c.price_cents),
  ])
  return {
    tab_id: tab.id, state: tab.state, billable_count: billedCalls.length, struck_count: struck.length,
    pending_count: calls.filter((c) => c.status === 'PENDING_AUDIT').length, billed_cents: billed, struck_cents: struckCents,
    captured_cents: tab.captured_cents, refunded_cents: done, refund_pending_cents: pending, net_cents: net, items: its,
    struck: struck.map((c) => ({ seq: c.seq, tool: c.tool, reason_code: c.reason_code, judged_by: c.judged_by, evidence: c.evidence })),
    refunded: refunded.map((c) => ({ seq: c.seq, price_cents: c.price_cents })),
    allowed_cents: [...allowed].filter((n) => Number.isInteger(n) && n >= 0),
    tab_seqs: calls.map((c) => c.seq), struck_seqs: struck.map((c) => c.seq),
  }
}
