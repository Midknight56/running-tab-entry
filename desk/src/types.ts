// The shape of GET /api/desk/data (src/desk-data.ts in the Worker).
export type TabState = 'OPEN' | 'DUE' | 'PAID'
export type CallStatus = 'PENDING_AUDIT' | 'BILLABLE' | 'STRUCK' | 'REFUNDED'

export interface Agent { id: string; name: string; created_at: number; budget_month_cents?: number | null; budget_call_cents?: number | null; spent_cents?: number }
export interface Tab {
  id: string; agent_id: string; state: TabState; total_cents: number; threshold_cents: number; order_id: string | null
  capture_id: string | null; captured_cents: number; refunded_cents: number; note: string | null
  created_at: number; due_at: number | null; paid_at: number | null
  plain_meter_cents?: number; kept_out_cents?: number; refund_pending_cents?: number; refunded_done_cents?: number
}
export interface Call {
  id: string; seq: number; agent_id: string; tab_id: string; tool: string; args: Record<string, unknown>; answer: string
  price_cents: number; status: CallStatus; reason_code: string | null; evidence: string | null; judged_by: string | null
  duration_ms: number; created_at: number
}
export interface Claim {
  id: string; call_id: string; call_seq: number; agent_id: string; reason_text: string; verdict: string | null
  reason_code: string | null; evidence: string | null; refund_id: string | null; refund_status: string | null; state: string; created_at: number; price_cents?: number
}
export interface TraceRow {
  id: number; kind: 'paypal' | 'model'; method_path: string | null; http: number | null; paypal_debug_id: string | null
  request_id: string | null; ids_json: string | null; model: string | null; neurons: number | null; cached: number | null
  verdict: string | null; at: number
}
export interface EventRow { id: string; event_type: string; verification: string; resource_id: string | null; outcome: string | null; received_at: number }
export interface Money {
  captured_cents: number; refunded_cents: number; struck_cents: number; pending_cents: number; net_cents: number
  plain_meter_cents: number; kept_cents: number; kept_out_cents: number; refund_pending_cents?: number
}

export interface DeskData {
  ws_id: string; agents: Agent[]; tabs: Tab[]; calls: Call[]; calls_total?: number; claims: Claim[]; events: EventRow[]; trace: TraceRow[]; money: Money
}

export const usd = (c: number) => `$${Math.floor(c / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`
