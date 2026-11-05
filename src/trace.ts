// The panel's rows: every PayPal call and every model call, with no token, key or body. A row that holds anything
// that looks like a credential is refused, so a mistake upstream cannot reach the screen.

export interface TraceRow {
  kind: 'paypal' | 'model'
  ws_id?: string
  method_path?: string
  http?: number
  paypal_debug_id?: string
  request_id?: string
  ids?: Record<string, string | number>
  model?: string
  neurons?: number
  cached?: boolean
  verdict?: string
}

const FORBIDDEN = [/bearer\s/i, /basic\s/i, /secret/i, /access_token/i, /password/i]

/** True when no field of the row could carry a credential. `extra` holds values known to be secret (client id). */
export function isClean(row: TraceRow, extra: string[] = []): boolean {
  const text = JSON.stringify(row)
  if (FORBIDDEN.some((re) => re.test(text))) return false
  return !extra.some((s) => s && s.length >= 6 && text.includes(s))
}

export async function writeTrace(db: D1Database, row: TraceRow, secrets: string[] = [], now = Date.now()): Promise<boolean> {
  if (!isClean(row, secrets)) return false
  await db.prepare(
    `INSERT INTO trace (ws_id, kind, method_path, http, paypal_debug_id, request_id, ids_json, model, neurons, cached, verdict, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(row.ws_id ?? null, row.kind, row.method_path ?? null, row.http ?? null, row.paypal_debug_id ?? null,
    row.request_id ?? null, row.ids ? JSON.stringify(row.ids) : null, row.model ?? null, row.neurons ?? null,
    row.cached === undefined ? null : Number(row.cached), row.verdict ?? null, now).run()
  return true
}
