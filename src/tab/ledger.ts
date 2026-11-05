// D1 reads and writes for agents, tabs and calls. Every query names the workspace or the agent, so one workspace never
// reads another's rows.
import { monthSpendSql, reservedSpendSql, monthStart, nextMonth } from './budgets'

export interface Agent { id: string; ws_id: string; name: string; kind?: string; expires_at?: number | null; budget_month_cents?: number | null; budget_call_cents?: number | null }

export type TabState = 'OPEN' | 'DUE' | 'PAID'
export interface Tab {
  id: string; ws_id: string; agent_id: string; state: TabState; total_cents: number; threshold_cents: number
  order_id: string | null; capture_id: string | null; captured_cents: number; refunded_cents: number
  note: string | null; created_at: number; due_at: number | null; paid_at: number | null
  wallet_attempt?: number
}

export type CallStatus = 'PENDING_AUDIT' | 'BILLABLE' | 'STRUCK' | 'REFUNDED'
export interface Call {
  id: string; seq: number; ws_id: string; agent_id: string; tab_id: string; tool: string; args_json: string
  result_json: string; price_cents: number; status: CallStatus; reason_code: string | null; evidence: string | null
  judged_by: string | null; duration_ms: number; created_at: number; chain_hash?: string | null
}

/** Logged answers contain at most 4,096 serialized characters. */
export const MAX_RESULT_CHARS = 4096

// Budget the JSON values before joining them, including keys, escaping and closing brackets.
// Oversized containers retain the fields/items that fit; the root marks any loss explicitly.
function boundedJson(value: unknown, budget: number, depth = 0): string | null {
  if (typeof value === 'string') {
    if (budget < 2) return null
    let lo = 0, hi = Math.min(value.length, budget - 2)
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (JSON.stringify(value.slice(0, mid)).length <= budget) lo = mid
      else hi = mid - 1
    }
    return JSON.stringify(value.slice(0, lo))
  }
  if (value === null || typeof value !== 'object' || depth >= 64) {
    const json = depth >= 64 ? 'null' : JSON.stringify(value)
    return json && json.length <= budget ? json : null
  }
  if (budget < 2) return null
  const array = Array.isArray(value)
  const parts: string[] = []
  let used = 2
  const entries = array ? value.entries() : Object.entries(value)
  for (const [key, item] of entries) {
    const prefix = array ? '' : `${JSON.stringify(key)}:`
    const overhead = prefix.length + (parts.length ? 1 : 0)
    if (used + overhead + 2 > budget) break
    const json = boundedJson(item, budget - used - overhead, depth + 1)
    if (json === null) break
    parts.push(prefix + json)
    used += overhead + json.length
  }
  return (array ? '[' : '{') + parts.join(',') + (array ? ']' : '}')
}

function storedResult(result: unknown): string {
  const json = JSON.stringify(result ?? null)
  if (json.length <= MAX_RESULT_CHARS) return json
  const value = JSON.parse(json)
  const marked = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.assign({ truncated: true }, value, { truncated: true })
    : { truncated: true, value }
  return boundedJson(marked, MAX_RESULT_CHARS)!
}

export function newId(prefix: string): string {
  const b = crypto.getRandomValues(new Uint8Array(9))
  return prefix + '_' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

export async function createAgent(db: D1Database, wsId: string, name: string, keyHash: string, now = Date.now(), id = newId('agt')): Promise<Agent> {
  await db.prepare('INSERT INTO agents (id, ws_id, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, wsId, name, keyHash, now).run()
  return { id, ws_id: wsId, name }
}

export async function agentByKeyHash(db: D1Database, keyHash: string): Promise<Agent | null> {
  return db.prepare('SELECT id, ws_id, name, kind, expires_at, budget_month_cents, budget_call_cents FROM agents WHERE key_hash = ?').bind(keyHash).first<Agent>()
}

export async function unpaidTab(db: D1Database, agent: Agent): Promise<Tab | null> {
  return db.prepare("SELECT * FROM tabs WHERE agent_id = ? AND ws_id = ? AND state != 'PAID' ORDER BY created_at DESC LIMIT 1")
    .bind(agent.id, agent.ws_id).first<Tab>()
}

/** The agent's tab that is not paid yet, made when there is none. */
export async function currentTab(db: D1Database, agent: Agent, thresholdCents: number, now: number): Promise<Tab> {
  const open = await unpaidTab(db, agent)
  if (open) return open
  const id = newId('tab')
  await db.prepare(`INSERT INTO tabs (id, ws_id, agent_id, threshold_cents, created_at)
    SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM tabs WHERE agent_id = ? AND ws_id = ? AND state != 'PAID'
    )`).bind(id, agent.ws_id, agent.id, thresholdCents, now, agent.id, agent.ws_id).run()
  const current = await db.prepare(
    "SELECT * FROM tabs WHERE agent_id = ? AND ws_id = ? AND state != 'PAID' ORDER BY created_at DESC LIMIT 1",
  ).bind(agent.id, agent.ws_id).first<Tab>()
  return current!
}

export async function getTab(db: D1Database, id: string): Promise<Tab | null> {
  return db.prepare('SELECT * FROM tabs WHERE id = ?').bind(id).first<Tab>()
}

export async function getCall(db: D1Database, id: string): Promise<Call | null> {
  return db.prepare('SELECT * FROM calls WHERE id = ?').bind(id).first<Call>()
}

/** A call by its number for one agent (the number agents and people see: "call 24"). */
export async function callBySeq(db: D1Database, agentId: string, seq: number): Promise<Call | null> {
  return db.prepare('SELECT * FROM calls WHERE agent_id = ? AND seq = ?').bind(agentId, seq).first<Call>()
}

export async function callsOfTab(db: D1Database, tabId: string): Promise<Call[]> {
  return (await db.prepare('SELECT * FROM calls WHERE tab_id = ? ORDER BY seq').bind(tabId).all<Call>()).results
}

export interface NewCall {
  agent: Agent; tab: Tab; tool: string; args: unknown; result: unknown; price_cents: number
  status: CallStatus; reason_code?: string; evidence?: string; judged_by?: string; duration_ms: number; now: number; reserved?: boolean
  signingKey?: string
}

export async function reserveCall(db: D1Database, tabId: string, price: number, now: number, agent?: Agent): Promise<boolean> {
  const r = await db.prepare(
    `UPDATE tabs SET total_cents = total_cents + ?1,
       state = CASE WHEN total_cents + ?1 >= threshold_cents THEN 'DUE' ELSE state END,
       due_at = CASE WHEN total_cents + ?1 >= threshold_cents THEN ?2 ELSE due_at END
     WHERE id = ?3 AND state = 'OPEN'
       AND (?1 = 0 OR ?7 IS NULL OR (${monthSpendSql}) + (${reservedSpendSql}) + ?1 <= ?7)`,
  ).bind(price, now, tabId, agent?.id ?? null, monthStart(now), nextMonth(now), agent?.budget_month_cents ?? null).run()
  return r.meta.changes > 0
}

/**
 * Logs the call and, when it is billable, adds its price to the tab. The tab turns DUE in the same statement when the
 * total reaches the threshold. Both writes are one batch.
 */
export async function recordCall(db: D1Database, c: NewCall): Promise<{ call: Call; tab: Tab }> {
  const id = newId('call')
  const resultJson = storedResult(c.result)
  const insert = db.prepare(
    `INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, first_status, reason_code,
       evidence, judged_by, duration_ms, created_at)
     VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM calls WHERE agent_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, c.agent.id, c.agent.ws_id, c.agent.id, c.tab.id, c.tool, JSON.stringify(c.args ?? {}), resultJson,
    c.price_cents, c.status, c.status, c.reason_code ?? null, c.evidence ?? null, c.judged_by ?? null, c.duration_ms, c.now)
  const stmts = [insert]
  if (c.reserved) {
    if (c.status !== 'BILLABLE') stmts.push(removeReservation(db, c.tab.id, c.price_cents))
  } else if (c.status === 'BILLABLE') stmts.push(addToTab(db, c.tab.id, c.price_cents, c.now))
  try {
    await db.batch(stmts)
  } catch {
    // Two calls from one agent at once can race for the same number; the second tries once more.
    await db.batch(stmts)
  }
  try {
    await sealAgent(db, c.agent.id, c.signingKey, c.now)
  } catch (error) {
    console.error('Ledger sealing failed; it will be retried later.', error)
  }
  try {
    return { call: (await getCall(db, id))!, tab: (await getTab(db, c.tab.id))! }
  } catch (error) {
    const committed = error instanceof Error ? error : new Error(String(error))
    ;(committed as Error & { callWritten?: boolean }).callWritten = true
    throw committed
  }
}

export interface LedgerVerification { ok: boolean; entries: number; head: string | null; signature_ok: boolean; first_bad_seq: number | null; call_hashes: Record<string, string> }

const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
const digest = async (value: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))

async function signHash(hash: string, key?: string): Promise<string | null> {
  if (!key) return null
  const cryptoKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(hash)))
}

export async function sealAgent(db: D1Database, agentId: string, signingKey?: string, now = Date.now()): Promise<void> {
  // Seals every waiting call in order. A lost race for a position is retried; five losses in a row stop this pass.
  for (let step = 0, lost = 0; step < 1000 && lost < 5; step++) {
    const call = await db.prepare('SELECT * FROM calls WHERE agent_id = ? AND chain_hash IS NULL ORDER BY seq LIMIT 1').bind(agentId).first<Call & { first_status: string | null }>()
    if (!call) return
    const previous = await db.prepare('SELECT hash FROM chain_heads WHERE agent_id = ? ORDER BY seq DESC LIMIT 1').bind(agentId).first<string>('hash')
      ?? (call.seq === 1 ? `genesis:${agentId}` : await db.prepare('SELECT chain_hash FROM calls WHERE agent_id = ? AND seq = ?').bind(agentId, call.seq - 1).first<string>('chain_hash'))
    if (!previous) return
    const hash = await digest(`${previous}|${call.seq}|${call.tool}|${call.args_json}|${await digest(call.result_json)}|${call.price_cents}|${call.first_status ?? call.status}|${call.created_at}`)
    const position = await nextChainPosition(db, agentId)
    const secured = await db.prepare(`INSERT OR IGNORE INTO chain_heads (agent_id, seq, hash, signature, signed_at, entry_kind, call_seq)
      SELECT ?, ?, ?, ?, ?, 'CALL', ? WHERE (SELECT COALESCE(MAX(seq), 0) FROM chain_heads WHERE agent_id = ?) = ?
      AND NOT EXISTS (SELECT 1 FROM chain_heads WHERE agent_id = ? AND entry_kind = 'CALL' AND call_seq = ?)`)
      .bind(agentId, position, hash, await signHash(hash, signingKey), now, call.seq, agentId, position - 1, agentId, call.seq).run()
    if (secured.meta.changes) {
      await db.prepare('UPDATE calls SET chain_hash = ? WHERE id = ? AND chain_hash IS NULL').bind(hash, call.id).run()
      lost = 0
    } else {
      // The call's head may already exist (another sealer, or a stop between the two writes): take its hash.
      const healed = await db.prepare(`UPDATE calls SET chain_hash = (SELECT hash FROM chain_heads WHERE agent_id = ? AND entry_kind = 'CALL' AND call_seq = ?)
        WHERE id = ? AND chain_hash IS NULL AND EXISTS (SELECT 1 FROM chain_heads WHERE agent_id = ? AND entry_kind = 'CALL' AND call_seq = ?)`)
        .bind(agentId, call.seq, call.id, agentId, call.seq).run()
      lost = healed.meta.changes ? 0 : lost + 1
    }
  }
}

async function nextChainPosition(db: D1Database, agentId: string): Promise<number> {
  const n = await db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM chain_heads WHERE agent_id = ?').bind(agentId).first<number>('n')
  return (n ?? 0) + 1
}

export async function recordChainEvent(db: D1Database, agentId: string, callSeq: number, kind: string, reference: string, createdAt = Date.now(), signingKey?: string): Promise<void> {
  const id = newId('evt')
  await db.prepare(`INSERT OR IGNORE INTO chain_events (id, agent_id, call_seq, kind, reference, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).bind(id, agentId, callSeq, kind, reference, createdAt).run()
  const event = await db.prepare('SELECT * FROM chain_events WHERE agent_id = ? AND call_seq = ? AND kind = ? AND reference = ? ORDER BY created_at LIMIT 1')
    .bind(agentId, callSeq, kind, reference).first<any>()
  if (!event || event.chain_hash) return
  for (let attempt = 0; attempt < 5; attempt++) {
    const previous = await db.prepare('SELECT hash FROM chain_heads WHERE agent_id = ? ORDER BY seq DESC LIMIT 1').bind(agentId).first<string>('hash')
    if (!previous) return
    const hash = await digest(`${previous}|event|${event.call_seq}|${event.kind}|${event.reference}|${event.created_at}`)
    const position = await nextChainPosition(db, agentId)
    const secured = await db.prepare(`INSERT OR IGNORE INTO chain_heads (agent_id, seq, hash, signature, signed_at, entry_kind, call_seq)
      SELECT ?, ?, ?, ?, ?, 'EVENT', ? WHERE (SELECT COALESCE(MAX(seq), 0) FROM chain_heads WHERE agent_id = ?) = ?
      AND NOT EXISTS (SELECT 1 FROM chain_heads WHERE agent_id = ? AND entry_kind = 'EVENT' AND call_seq = ?)`)
      .bind(agentId, position, hash, await signHash(hash, signingKey), createdAt, callSeq, agentId, position - 1, agentId, callSeq).run()
    if (secured.meta.changes) {
      await db.prepare('UPDATE chain_events SET chain_hash = ?, chain_seq = ? WHERE id = ? AND chain_hash IS NULL')
        .bind(hash, position, event.id).run()
      return
    }
  }
}

export async function verifyLedger(db: D1Database, agentId: string, signingKey?: string): Promise<LedgerVerification> {
  const heads = (await db.prepare('SELECT * FROM chain_heads WHERE agent_id = ? ORDER BY seq').bind(agentId).all<any>()).results
  const calls = (await db.prepare('SELECT * FROM calls WHERE agent_id = ? ORDER BY seq').bind(agentId).all<any>()).results
  const events = (await db.prepare('SELECT * FROM chain_events WHERE agent_id = ? ORDER BY chain_seq').bind(agentId).all<any>()).results
  const callsBySeq = new Map(calls.map((c) => [c.seq, c]))
  const eventsByPos = new Map(events.map((e) => [e.chain_seq, e]))
  let previous = `genesis:${agentId}`
  let firstBad: number | null = null
  const callHashes: Record<string, string> = {}
  for (const row of heads) {
    let computed: string
    if (row.entry_kind === 'CALL') {
      const c = callsBySeq.get(row.call_seq)
      if (!c) { firstBad ??= row.call_seq; break }
      computed = await digest(`${previous}|${c.seq}|${c.tool}|${c.args_json}|${await digest(c.result_json)}|${c.price_cents}|${c.first_status ?? c.status}|${c.created_at}`)
      callHashes[c.id] = computed
      if (c.chain_hash !== computed) firstBad ??= c.seq
    } else {
      const e = eventsByPos.get(row.seq)
      if (!e) { firstBad ??= row.call_seq; break }
      computed = await digest(`${previous}|event|${e.call_seq}|${e.kind}|${e.reference}|${e.created_at}`)
      if (e.chain_hash !== computed) firstBad ??= e.call_seq
    }
    if (computed !== row.hash) firstBad ??= row.call_seq
    previous = computed
  }
  if (firstBad === null) {
    const sealed = new Set(heads.filter((h: any) => h.entry_kind === 'CALL').map((h: any) => h.call_seq))
    firstBad = calls.find((c) => !sealed.has(c.seq))?.seq ?? heads.find((h: any) => h.entry_kind === 'CALL' && !callsBySeq.has(h.call_seq))?.call_seq ?? null
  }
  if (firstBad === null) {
    const eventHeads = new Map(heads.filter((h: any) => h.entry_kind === 'EVENT').map((h: any) => [h.seq, h]))
    for (const event of events) {
      if (event.chain_seq === null) continue
      const head = eventHeads.get(event.chain_seq)
      if (!head || head.call_seq !== event.call_seq) { firstBad = event.call_seq; break }
    }
  }
  const last = heads.at(-1)
  const expected = last ? await signHash(last.hash, signingKey) : null
  const signatureOk = last ? Boolean(signingKey) && expected === last.signature : Boolean(signingKey)
  return { ok: firstBad === null && signatureOk, entries: heads.length, head: last?.hash ?? null, signature_ok: signatureOk, first_bad_seq: firstBad, call_hashes: callHashes }
}

export async function releaseCall(db: D1Database, tabId: string, price: number): Promise<void> {
  await removeReservation(db, tabId, price).run()
}

function removeReservation(db: D1Database, tabId: string, price: number) {
  return db.prepare(
    `UPDATE tabs SET total_cents = total_cents - ?1,
       state = CASE WHEN state = 'DUE' AND total_cents - ?1 < threshold_cents THEN 'OPEN' ELSE state END,
       due_at = CASE WHEN state = 'DUE' AND total_cents - ?1 < threshold_cents THEN NULL ELSE due_at END
     WHERE id = ?2 AND state != 'PAID'`,
  ).bind(price, tabId)
}

function addToTab(db: D1Database, tabId: string, price: number, now: number) {
  return db.prepare(
    `UPDATE tabs SET total_cents = total_cents + ?1,
       state = CASE WHEN state = 'OPEN' AND total_cents + ?1 >= threshold_cents THEN 'DUE' ELSE state END,
       due_at = CASE WHEN state = 'OPEN' AND total_cents + ?1 >= threshold_cents THEN ?2 ELSE due_at END
     WHERE id = ?3 AND state != 'PAID'`,
  ).bind(price, now, tabId)
}
