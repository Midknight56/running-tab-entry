// WHY A JUDGE COSTS $0. Workers AI on the Workers Free plan gives 10,000 neurons a day for the whole account, and past
// that "further operations will fail with an error"; nothing is billed (developers.cloudflare.com/workers-ai/platform/
// pricing, read 22 Oct 2026). The hackathon apps run on their own free Cloudflare account, and every model call is
// counted into one shared ledger with a joint cap below the free day. Running Tab also keeps its own share.
//
// Model @cf/qwen/qwen3-30b-a3b-fp8: 4,625 neurons per million input tokens, 30,475 per million output tokens (same
// page). Four characters per token. Each call is charged its WORST case BEFORE it runs, from its input cap in
// characters and its output cap in tokens:
//   audit:         6,000 chars in (1,500 tokens) = 6.94;  120 tokens out = 3.66;  total 10.59 neurons
//   claim:         8,000 chars in (2,000 tokens) = 9.25;  160 tokens out = 4.88;  total 14.13 neurons
//   note:          6,000 chars in = 6.94;                 150 tokens out = 4.57;  total 11.51 neurons
//   explain_round: 8,000 chars in = 9.25;                 200 tokens out = 6.10;  total 15.35 neurons (3 rounds at most)
//   widget:        3,000 chars in (750 tokens) = 3.47;   150 tokens out = 4.57;  total 8.04 neurons (Ask the desk)
//   studio_round: 44,000 chars in = 50.88;                500 tokens out = 15.24; total 66.11 neurons (AG Studio's
//                 orchestrator prompt is 15,212 characters, its Data agent's 24,385, its Planning agent's 24,729 and
//                 its Page agent's 39,351, measured 23 Oct; real rounds cost 15.9 to 34.7 neurons by Workers AI's count)
// One uncached demo run: 6 model audits (63.54) + 1 claim (14.13) + 1 note (11.51) + 3 explain rounds (46.05) =
// 135.23 neurons (measured 23 Oct: 28.06). Repeat runs hit the cache: about 0. A desk assistant widget build is about
// 300 measured. Share, set 23 Oct: the five hackathon apps have the second account's free 10,000 a day
// to themselves; Running Tab takes 1,500 (5 x 1,500 = 7,500, under the 9,000 joint cap and the 10,000 free day). A
// visitor gets 300: ten full demo runs at 28.06 each, or one desk assistant build. 1,500 / 300 = 5 heavy visitors a
// day before the model rests and code answers alone.
// After each call the difference between the worst case and Workers AI's own count (`usage.neurons`) is given back to
// every counter, so the caps track what was really spent. Measured 23 Oct: 7 audits cost 15.36 neurons in all, against
// 74.13 charged first. See README, Receipts.

export const MODEL_ID = '@cf/qwen/qwen3-30b-a3b-fp8'
const IN_PER_TOKEN = 4625 / 1_000_000
const OUT_PER_TOKEN = 30475 / 1_000_000

/** Running Tab's share of the day. */
export const RT_DAILY_NEURONS = 1500
/** One visitor's share of the day (by the daily hash of their IP, never the IP itself). */
export const VISITOR_DAILY_NEURONS = 300
// A key shares out the free day: 60 neurons is about 5 worst case audits (10.59 each), or 2 measured demo runs
// (28.06 each). Cost stays $0: the app's 1,500 sits under the joint 9,000 under the free 10,000.
// The same pricing page says further operations will fail with an error (developers.cloudflare.com/workers-ai/platform/
// pricing, read 22 Oct 2026).
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
