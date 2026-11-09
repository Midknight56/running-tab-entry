// Loads the desk's data from the Worker, and the actions the desk can take.
import type { DeskData } from './types'
import type { AgReportState } from 'ag-studio'

export interface Session { ws_id: string; agents: { id: string; name: string; key: string }[] }

export const CONNECTION_ERROR = 'Could not reach the desk. Check your connection and try again.'

async function post<T>(path: string, body: unknown = {}): Promise<{ ok: boolean; status: number; body: T }> {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' })
    return { ok: r.ok, status: r.status, body: (await r.json().catch(() => ({}))) as T }
  } catch { return { ok: false, status: 0, body: { error: CONNECTION_ERROR } as T } }
}

export interface ConnectKey { agent_id: string; name: string; key: string; expires_at: number; mcp_url: string }
export const connectAgent = (budget: { monthly_cents?: number; max_call_cents?: number } = {}) => post<ConnectKey & { error?: string }>('/api/connect', budget)
export const startSession = () => post<Session & { error?: string }>('/api/session')
export const runCalls = () => post<{ steps?: unknown[]; due?: { pay_url: string; amount: string }; error?: string }>('/api/demo/run', {})
export const runAfterPay = () => post<{ claim?: unknown; explain?: { answer: string; cited_call_ids: number[] }; error?: string }>('/api/demo/run', { phase: 'after_pay' })
export const payWithCard = (tabId: string) => post<{ kind?: string; reason?: string; error?: string }>(`/api/sandbox/card-pay/${encodeURIComponent(tabId)}`)
export const askDesk = (question: string) => post<{ ok: boolean; spec?: import('./studio/add-widget').WidgetSpec; reason?: string; error?: string }>('/api/desk/ask', { question })
export const approveClaim = (id: string) => post<{ ok: boolean; reason?: string; error?: string }>(`/api/claims/${encodeURIComponent(id)}/approve`)
export const tryClaim = (call_id: string, reason: string) => post<TryClaimResult>('/api/claims/try', { call_id, reason })

export interface TryClaimResult {
  state?: string; message?: string; refund_id?: string; evidence?: string; reason_code?: string
  verdict?: string; tries_left?: number; error?: string
}

export async function loadTryStatus(): Promise<number> {
  try {
    const r = await fetch('/api/claims/try', { credentials: 'same-origin' })
    if (!r.ok) return 5
    return Number((await r.json() as { tries_left?: number }).tries_left ?? 5)
  } catch { return 5 }
}

export async function verifyLedger(agentId: string): Promise<{ ok: boolean; entries: number; first_bad_seq: number | null; order?: { id: string; matches: boolean | null } } | null> {
  try {
    const r = await fetch(`/api/ledger/verify/${encodeURIComponent(agentId)}`, { credentials: 'same-origin' })
    if (!r.ok) return null
    return await r.json() as { ok: boolean; entries: number; first_bad_seq: number | null; order?: { id: string; matches: boolean | null } }
  } catch { return null }
}

export async function loadDesk(): Promise<DeskData | null> {
  try {
    const r = await fetch('/api/desk/data', { credentials: 'same-origin' })
    if (!r.ok) return null
    return (await r.json()) as DeskData
  } catch { return null }
}

export async function loadReport(): Promise<AgReportState | null> {
  const r = await fetch('/api/desk/report', { credentials: 'same-origin' })
  if (r.status === 204) return null
  if (!r.ok) throw new Error('Could not load the layout. Reload the page to try again.')
  return await r.json() as AgReportState
}

export async function saveReport(state: AgReportState): Promise<void> {
  const r = await fetch('/api/desk/report', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state), credentials: 'same-origin' })
  if (!r.ok) throw new Error('Could not save the layout. Make another edit to try again.')
}

const text = (id: string, name: string) => ({ id, name, format: 'textFormat' })
const int = (id: string, name: string) => ({ id, name, format: 'integerFormat' })
const money = (id: string, name: string) => ({ id, name, format: 'currencyFormat' })

/** Rows for Studio's data engine: one source per table, money in dollars for charts. Fields are declared, so an empty
 *  workspace still has a schema. */
export function studioSources(d: DeskData, opts: { includeHistory?: boolean } = {}) {
  const name = (id: string) => d.agents.find((a) => a.id === id)?.name ?? ''
  // Seeded rows belong to the seeded tab: charts leave them out unless the seller turns them on.
  const sampleTabs = new Set(d.tabs.filter((t) => t.note === 'demo history').map((t) => t.id))
  const keep = (tabId?: string | null) => opts.includeHistory || !sampleTabs.has(tabId ?? '')
  const shownCalls = d.calls.filter((c) => keep(c.tab_id))
  const callTab = new Map(d.calls.map((c) => [c.id, c.tab_id]))
  const calls = {
    id: 'calls', name: 'Calls',
    fields: [int('call', 'Call'), text('agent', 'Agent'), text('tool', 'Tool'), text('status', 'Status'), text('reason', 'Reason'),
      text('judged_by', 'Judged by'), money('price', 'Price'), { id: 'seconds', name: 'Seconds', format: 'decimalFormat' }, text('day', 'Day'), text('history', 'Session')],
    data: shownCalls.map((c) => ({
      call: c.seq, agent: name(c.agent_id), tool: c.tool, status: c.status, reason: c.reason_code ?? '', judged_by: c.judged_by ?? '',
      price: c.price_cents / 100, seconds: Math.round(c.duration_ms / 100) / 10, day: new Date(c.created_at).toISOString().slice(0, 10),
      history: sampleTabs.has(c.tab_id) ? 'Seeded tab' : 'This session',
    })),
  }
  const tabs = {
    id: 'tabs', name: 'Tabs',
    fields: [text('tab', 'Tab'), text('agent', 'Agent'), text('state', 'State'), money('total', 'Total'), money('captured', 'Captured'), money('refunded', 'Refunded'), text('order', 'PayPal order'), text('capture', 'PayPal capture')],
    data: d.tabs.filter((t) => keep(t.id)).map((t) => ({ tab: t.id, agent: name(t.agent_id), state: t.state, total: t.total_cents / 100, captured: t.captured_cents / 100, refunded: (t.refunded_done_cents ?? 0) / 100, order: t.order_id ?? '', capture: t.capture_id ?? '' })),
  }
  const claims = {
    id: 'claims', name: 'Claims',
    fields: [int('call', 'Call'), text('agent', 'Agent'), text('reason', 'Reason'), text('state', 'State'), money('amount', 'Amount'), text('refund', 'PayPal refund'), text('claim', 'Claim')],
    data: d.claims.filter((k) => keep(callTab.get(k.call_id))).map((k) => ({ call: k.call_seq, agent: name(k.agent_id), reason: k.reason_code ?? '', state: k.state, amount: (k.price_cents ?? 0) / 100, refund: k.refund_id ?? '', claim: k.reason_text })),
  }
  return [
    calls, tabs, { ...claims, id: 'refunds', name: 'Refunds', data: claims.data.filter(k => k.state === 'REFUNDED') },
    { ...calls, id: 'struck', name: 'Struck calls', data: calls.data.filter(c => c.status === 'STRUCK') },
    { ...calls, id: 'billed', name: 'Billed calls, refunded included', data: calls.data.filter(c => c.status === 'BILLABLE' || c.status === 'REFUNDED') },
    { ...calls, id: 'billable', name: 'Billable calls', data: calls.data.filter(c => c.status === 'BILLABLE') },
    { ...calls, id: 'refunded_calls', name: 'Refunded calls', data: calls.data.filter(c => c.status === 'REFUNDED') },
    claims,
  ]
}
