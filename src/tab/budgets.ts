import type { Agent } from './ledger'

export interface BudgetInput { monthly_cents?: number; max_call_cents?: number }

export function budgetError(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Budget must be an object.'
  for (const [key, max] of [['monthly_cents', 100000], ['max_call_cents', 10000]] as const) {
    const value = (input as Record<string, unknown>)[key]
    if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max)) {
      return `${key} must be whole cents from 0 to ${max}.`
    }
  }
  return null
}

export function monthStart(now: number): number {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}

// Refunds return the full call price. Struck and waiting calls never count as spend.
export const monthSpendSql = `SELECT COALESCE(SUM(price_cents - CASE WHEN status = 'REFUNDED' THEN price_cents ELSE 0 END), 0)
  FROM calls WHERE agent_id = ?4 AND created_at >= ?5 AND created_at < ?6 AND status IN ('BILLABLE', 'REFUNDED')`

// An unfinished reservation has no call row yet, but still holds its cents across workers.
export const reservedSpendSql = `SELECT COALESCE(SUM(MAX(0, total_cents -
  (SELECT COALESCE(SUM(price_cents), 0) FROM calls WHERE tab_id = tabs.id AND status = 'BILLABLE'))), 0)
  FROM tabs WHERE agent_id = ?4 AND state != 'PAID'`

export function nextMonth(now: number): number {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
}

export async function monthSpend(db: D1Database, agentId: string, now: number, reserved = false): Promise<number> {
  return (await db.prepare(`SELECT (${monthSpendSql}) ${reserved ? `+ (${reservedSpendSql})` : ''} AS spent`)
    .bind(null, null, null, agentId, monthStart(now), nextMonth(now)).first<number>('spent')) ?? 0
}

export async function budgetSummary(db: D1Database, agent: Agent, now: number) {
  const limits = await db.prepare('SELECT budget_month_cents, budget_call_cents FROM agents WHERE id = ?').bind(agent.id)
    .first<Pick<Agent, 'budget_month_cents' | 'budget_call_cents'>>()
  const monthly = limits?.budget_month_cents
  const perCall = limits?.budget_call_cents
  const spent_cents = await monthSpend(db, agent.id, now)
  return {
    ...(monthly != null ? { budget_month_cents: monthly, budget_left: Math.max(0, monthly - spent_cents) } : {}),
    ...(perCall != null ? { budget_call_cents: perCall } : {}),
    spent_cents,
  }
}
