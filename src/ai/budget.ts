// Why a judge costs $0. Workers AI on the Workers Free plan gives 10,000 neurons a day for the whole account,
// and past that further operations will fail with an error; nothing is billed. The pricing page was read 6 Nov 2026.
// The hackathon apps run on their own free Cloudflare account, and every model call is counted into one shared
// ledger with a joint cap below the free day. Running Tab also keeps its own share.
// A full demo run costs its calculated worst case: six audits, one claim, one note and three explain rounds.
// Each call is charged before it runs using the input character cap, four characters per token, and output token cap.
// These prices were read 6 Nov 2026 from the pricing page: 5,500 neurons per million input tokens and 36,400 per
// million output tokens. The page lists $0.060 and $0.400 per million; at $0.011 per 1,000 neurons and 10,000 free
// neurons each day, no charge is due within the daily limits. Worst case per job is calculated from the caps in the
// budget test: audit 12.618; claim 16.824; note 13.710; explain_round 18.280; widget 9.585; studio_round 78.700 neurons.
// One uncached demo run costs 161.082 neurons: six audits, one claim, one note and three explain rounds. A desk widget
// uses one widget call. Repeat calls use the cache. A test computes these values so this comment cannot drift.
// After each call the difference between the worst case and Workers AI own count (`usage.neurons`) is given back to every counter, so the caps track what was really spent.

export const MODEL_ID = '@cf/zai-org/glm-4.7-flash'
const IN_PER_TOKEN = 5500 / 1_000_000
const OUT_PER_TOKEN = 36400 / 1_000_000

/** Running Tab's share of the day. */
export const RT_DAILY_NEURONS = 1500
/** One visitor's share of the day (by the daily hash of their IP, never the IP itself). */
export const VISITOR_DAILY_NEURONS = 300
// Daily cost is $0: the app's 1,500 neurons sits under the joint 9,000 under the free 10,000. At worst case, the daily
// share covers 9 full demo runs (1,500 divided by 161.082).
export const KEY_DAILY_NEURONS = 60
/** Every hackathon app together, in the shared ledger: 1,000 under the free 10,000, so a slow count cannot tip it. */
export const JOINT_DAILY_NEURONS = 9000
export const APP_NAME = 'running-tab'

export type Job = 'audit' | 'claim' | 'note' | 'explain_round' | 'studio_round' | 'widget'
export const INPUT_CAP: Record<Job, number> = { audit: 6000, claim: 8000, note: 6000, explain_round: 8000, studio_round: 44000, widget: 3000 }
export const OUTPUT_CAP: Record<Job, number> = { audit: 120, claim: 160, note: 150, explain_round: 200, studio_round: 500, widget: 150 }

export function worstCase(inputChars: number, outputTokens: number): number {
  return Math.ceil(inputChars / 4) * IN_PER_TOKEN + outputTokens * OUT_PER_TOKEN
}

export function measured(promptTokens: number, completionTokens: number): number {
  return promptTokens * IN_PER_TOKEN + completionTokens * OUT_PER_TOKEN
}

export const WORST: Record<Job, number> = Object.fromEntries(
  (Object.keys(INPUT_CAP) as Job[]).map((j) => [j, worstCase(INPUT_CAP[j], OUTPUT_CAP[j])]),
) as Record<Job, number>

/**
 * Takes `neurons` from the app, visitor, optional key and shared ledger, or takes nothing and answers false.
 * Each counter moves only when the new total stays under its cap, in one statement.
 */
export interface Ticket { ledgerRowId?: number }

export async function take(db: D1Database, o: { day: string; visitor: string; key?: string; neurons: number; ledger?: D1Database; now?: number; ticket?: Ticket }): Promise<boolean> {
  const counters: [string, number][] = [
    [`neurons:${o.day}`, RT_DAILY_NEURONS],
    [`visitor:${o.visitor}:${o.day}`, VISITOR_DAILY_NEURONS],
    ...(o.key ? [[`key:${o.key}:${o.day}`, KEY_DAILY_NEURONS] as [string, number]] : []),
  ]
  await db.batch(counters.map(([key]) => db.prepare('INSERT OR IGNORE INTO counters (key, n) VALUES (?, 0)').bind(key)))
  const taken: string[] = []
  const giveBack = async () => {
    if (taken.length) await db.batch(taken.map(key => db.prepare('UPDATE counters SET n = n - ? WHERE key = ?').bind(o.neurons, key)))
  }
  for (const [key, cap] of counters) {
    const result = await db.prepare('UPDATE counters SET n = n + ?1 WHERE key = ?2 AND n + ?1 <= ?3').bind(o.neurons, key, cap).run()
    if (!result.meta.changes) {
      await giveBack()
      return false
    }
    taken.push(key)
  }
  if (o.ledger) {
    try {
      const sum = (await o.ledger.prepare('SELECT COALESCE(SUM(neurons), 0) AS s FROM ai_calls WHERE day = ?').bind(o.day).first<number>('s')) ?? 0
      if (sum + o.neurons > JOINT_DAILY_NEURONS) {
        await giveBack()
        return false
      }
      // The shared table stamps `at` itself (datetime('now')).
      const row = await o.ledger.prepare('INSERT INTO ai_calls (app, day, neurons) VALUES (?, ?, ?)').bind(APP_NAME, o.day, o.neurons).run()
      if (o.ticket) o.ticket.ledgerRowId = row.meta.last_row_id
    } catch {
      // The shared ledger could not be read: refuse rather than guess.
      await giveBack()
      return false
    }
  }
  return true
}

export function utcDay(t = Date.now()): string {
  return new Date(t).toISOString().slice(0, 10)
}

/** After the call: gives back what was charged above the real cost, on every counter that was charged. */
export async function settle(db: D1Database, o: { day: string; visitor: string; key?: string; charged: number; actual: number; ledger?: D1Database; ticket?: Ticket }): Promise<void> {
  const back = o.charged - Math.max(0, o.actual)
  if (!(back > 0)) return
  await db.batch([
    db.prepare('UPDATE counters SET n = MAX(0, n - ?) WHERE key = ?').bind(back, `neurons:${o.day}`),
    db.prepare('UPDATE counters SET n = MAX(0, n - ?) WHERE key = ?').bind(back, `visitor:${o.visitor}:${o.day}`),
    ...(o.key ? [db.prepare('UPDATE counters SET n = MAX(0, n - ?) WHERE key = ?').bind(back, `key:${o.key}:${o.day}`)] : []),
  ])
  if (o.ledger && o.ticket?.ledgerRowId) {
    await o.ledger.prepare('UPDATE ai_calls SET neurons = ? WHERE id = ? AND app = ?').bind(Math.max(0, o.actual), o.ticket.ledgerRowId, APP_NAME).run().catch(() => undefined)
  }
}
