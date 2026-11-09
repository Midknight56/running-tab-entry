import { monthSpend } from './tab/budgets'
// GET /api/desk/data: everything the desk shows for one workspace. Every query names the workspace.
import { answerText } from './claims/judge'

export async function deskData(db: D1Database, wsId: string) {
  const q = <T = Record<string, unknown>>(sql: string, ...b: unknown[]) => db.prepare(sql).bind(...b).all<T>().then((r) => r.results)
  const [agents, tabs, calls, claims, events, trace, pricedByTab, callCount, lostPays] = await Promise.all([
    q('SELECT id, name, created_at, budget_month_cents, budget_call_cents FROM agents WHERE ws_id = ? ORDER BY created_at, name', wsId),
    q(`SELECT id, agent_id, state, total_cents, threshold_cents, order_id, capture_id, captured_cents, refunded_cents, note,
         created_at, due_at, paid_at FROM tabs WHERE ws_id = ? ORDER BY created_at`, wsId),
    q<any>(`SELECT id, seq, agent_id, tab_id, tool, args_json, result_json, price_cents, status, reason_code, evidence, judged_by,
         duration_ms, created_at FROM calls WHERE ws_id = ? ORDER BY created_at DESC, seq DESC LIMIT 2000`, wsId),
    q(`SELECT c.id, c.call_id, k.seq AS call_seq, k.agent_id, c.reason_text, c.verdict, c.reason_code, c.evidence, c.refund_id,
         c.refund_status, c.state, c.created_at, k.price_cents, k.tab_id FROM claims c JOIN calls k ON k.id = c.call_id WHERE c.ws_id = ? ORDER BY c.created_at`, wsId),
    q('SELECT id, event_type, verification, resource_id, outcome, received_at FROM events WHERE ws_id = ? ORDER BY received_at DESC LIMIT 50', wsId),
    q(`SELECT id, kind, method_path, http, paypal_debug_id, request_id, ids_json, model, neurons, cached, verdict, at
         FROM trace WHERE ws_id = ? ORDER BY id DESC LIMIT 150`, wsId),
    q<{ tab_id: string; plain_cents: number; billable_cents: number; struck_cents: number; pending_cents: number }>(
      `SELECT tab_id, SUM(price_cents) AS plain_cents,
         SUM(CASE WHEN status = 'BILLABLE' THEN price_cents ELSE 0 END) AS billable_cents,
         SUM(CASE WHEN status = 'STRUCK' THEN price_cents ELSE 0 END) AS struck_cents,
         SUM(CASE WHEN status = 'PENDING_AUDIT' THEN price_cents ELSE 0 END) AS pending_cents
       FROM calls WHERE ws_id = ? AND status IN ('BILLABLE', 'STRUCK', 'PENDING_AUDIT', 'REFUNDED') GROUP BY tab_id`, wsId),
    db.prepare('SELECT COUNT(*) AS n FROM calls WHERE ws_id = ?').bind(wsId).first<number>('n'),
    // A card attempt sent at least once, still SENT after 10 s: the answer was lost and the desk is checking with PayPal.
    q<{ tab_id: string }>("SELECT DISTINCT tab_id FROM pay_attempts WHERE ws_id = ? AND state = 'SENT' AND send_count >= 1 AND updated_at < ?", wsId, Date.now() - 10_000),
  ])
  const checking = new Set(lostPays.map((r) => r.tab_id))
  const shaped = calls.map((c) => ({
    id: c.id, seq: c.seq, agent_id: c.agent_id, tab_id: c.tab_id, tool: c.tool, args: safeJson(c.args_json),
    answer: answerText(c.result_json).slice(0, 400), price_cents: c.price_cents, status: c.status, reason_code: c.reason_code,
    evidence: c.evidence, judged_by: c.judged_by, duration_ms: c.duration_ms, created_at: c.created_at,
  }))
  // The money flow counts only this session's tabs: seeded "demo history" never touched PayPal.
  const history = new Set((tabs as any[]).filter((t) => t.note === 'demo history').map((t) => t.id))
  const real = (tabs as any[]).filter((t) => t.capture_id)
  const priced = new Map(pricedByTab.map((r) => [r.tab_id, r]))
  const refunds = (tabId: string, state: string) => claims.reduce((n, c) => n + (c.tab_id === tabId && c.state === state ? Number(c.price_cents) : 0), 0)
  const tabsWithMoney = (tabs as any[]).map((t) => {
    const row = priced.get(t.id)
    const plain = Number(row?.plain_cents ?? 0)
    const done = refunds(t.id, 'REFUNDED')
    const pending = refunds(t.id, 'REFUNDING')
    const kept = t.state === 'PAID' ? t.captured_cents - done : Number(row?.billable_cents ?? 0)
    return { ...t, payment_checking: t.state === 'DUE' && checking.has(t.id), refund_pending_cents: pending, refunded_done_cents: done, plain_meter_cents: plain, kept_out_cents: plain - kept }
  })
  const moneyTabs = tabsWithMoney.filter((t) => !history.has(t.id))
  const totalPlain = moneyTabs.reduce((n, t) => n + t.plain_meter_cents, 0)
  const totalKept = moneyTabs.reduce((n, t) => n + t.plain_meter_cents - t.kept_out_cents, 0)
  const money = {
    captured_cents: real.reduce((n, t) => n + t.captured_cents, 0),
    refunded_cents: real.reduce((n, t) => n + refunds(t.id, 'REFUNDED'), 0),
    refund_pending_cents: real.reduce((n, t) => n + refunds(t.id, 'REFUNDING'), 0),
    struck_cents: moneyTabs.reduce((n, t) => n + Number(priced.get(t.id)?.struck_cents ?? 0), 0),
    pending_cents: moneyTabs.reduce((n, t) => n + Number(priced.get(t.id)?.pending_cents ?? 0), 0),
    plain_meter_cents: totalPlain,
    kept_cents: totalKept,
    kept_out_cents: totalPlain - totalKept,
  }
  const agentsWithBudgets = await Promise.all(agents.map(async agent => ({ ...agent, spent_cents: await monthSpend(db, String(agent.id), Date.now()) })))
  // One selection rule, the same one the desk bill uses: the first agent's newest paid tab and its newest open tab.
  // Every paid tab's receipt is listed too, newest first, so another agent's payment never replaces this one.
  const names = new Map((agents as any[]).map((a) => [String(a.id), String(a.name)]))
  const firstAgent = (agents as any[])[0]?.id
  const byPaid = (a: any, b: any) => (b.paid_at ?? b.created_at) - (a.paid_at ?? a.created_at) || b.created_at - a.created_at
  const paidTabs = moneyTabs.filter((t) => t.state === 'PAID').sort(byPaid)
  const receiptOf = (t: any) => ({
    tab_id: t.id,
    agent_id: t.agent_id,
    agent_name: names.get(String(t.agent_id)) ?? '',
    order_id: t.order_id ?? null,
    capture_id: t.capture_id ?? null,
    metered_cents: Number(priced.get(t.id)?.plain_cents ?? 0),
    struck_cents: Number(priced.get(t.id)?.struck_cents ?? 0),
    captured_cents: Number(t.captured_cents ?? 0),
    refunded_cents: refunds(t.id, 'REFUNDED'),
    refund_pending_cents: refunds(t.id, 'REFUNDING'),
    net_cents: Number(t.captured_cents ?? 0) - refunds(t.id, 'REFUNDED'),
  })
  const receipts = paidTabs.map(receiptOf)
  const newestPaid = paidTabs.find((t) => t.agent_id === firstAgent) ?? null
  const receipt = newestPaid ? receiptOf(newestPaid) : null
  const openOrDueTabs = moneyTabs.filter((t) => (t.state === 'OPEN' || t.state === 'DUE') && t.agent_id === firstAgent)
  const newestOpen = openOrDueTabs.length > 0
    ? [...openOrDueTabs].sort((a, b) => b.created_at - a.created_at)[0]
    : null
  const open_tab = newestOpen ? {
    tab_id: newestOpen.id,
    agent_id: newestOpen.agent_id,
    state: newestOpen.state,
    total_cents: newestOpen.total_cents,
    calls: calls.filter((c: any) => c.tab_id === newestOpen.id).length,
  } : null
  const session = {
    metered_cents: totalPlain,
    kept_or_billable_cents: totalKept,
    struck_cents: money.struck_cents,
    refunded_cents: money.refunded_cents,
    pending_audit_cents: money.pending_cents,
  }
  return {
    ws_id: wsId,
    agents: agentsWithBudgets,
    tabs: tabsWithMoney,
    calls: shaped,
    calls_total: callCount ?? 0,
    claims,
    events,
    trace,
    money: { ...money, net_cents: money.captured_cents - money.refunded_cents, receipt, open_tab, session },
    receipt,
    receipts,
    open_tab,
    session,
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s) } catch { return {} }
}
