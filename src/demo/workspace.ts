import { createAgent, newId } from '../tab/ledger'

export const WORKSPACES_PER_IP_PER_DAY = 10
export const RUNS_PER_WORKSPACE = 5
export const WORKSPACE_HOURS = 24
export const KEY_HOURS = 2
export const CONNECT_KEYS_PER_WORKSPACE = 2
export const DEMO_THRESHOLD_CENTS = 500
export const DEMO_AGENTS = ['Scheduler bot', 'Travel desk agent'] as const

const encoder = new TextEncoder()

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(s))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function hmacB64url(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)))
  let binary = ''
  for (const byte of signature) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export async function ipDayHash(ip: string, secret: string, day: string): Promise<string> {
  return sha256Hex(`${secret}|${day}|${ip}`)
}

export async function agentKey(secret: string, agentId: string): Promise<string> {
  return 'rt_agent_' + await hmacB64url(secret, 'agent:' + agentId)
}

export async function signWs(secret: string, wsId: string): Promise<string> {
  return `${wsId}.${await hmacB64url(secret, 'ws:' + wsId)}`
}

export async function verifyWs(secret: string, cookieValue: string | null | undefined): Promise<string | null> {
  if (!cookieValue) return null
  const dot = cookieValue.lastIndexOf('.')
  if (dot <= 0) return null
  const wsId = cookieValue.slice(0, dot)
  const supplied = cookieValue.slice(dot + 1)
  const expected = await hmacB64url(secret, 'ws:' + wsId)
  let diff = supplied.length ^ expected.length
  const length = Math.max(supplied.length, expected.length)
  for (let i = 0; i < length; i++) diff |= (supplied.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0)
  return diff === 0 ? wsId : null
}

export function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('Cookie')
  if (!cookie) return null
  for (const part of cookie.split(';')) {
    const i = part.indexOf('=')
    if (i < 0 || part.slice(0, i).trim() !== name) continue
    const value = part.slice(i + 1).trim()
    try { return decodeURIComponent(value) } catch { return value }
  }
  return null
}

type WorkspaceResult = { ok: true; ws_id: string; agents: { id: string; name: string; key: string }[] } | { ok: false; reason: string }

export async function createWorkspace(db: D1Database, o: { ipHash: string; secret: string; now: number; owner?: boolean }): Promise<WorkspaceResult> {
  const count = await db.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE ip_day_hash = ?').bind(o.ipHash).first<{ n: number }>()
  if (!o.owner && (count?.n ?? 0) >= WORKSPACES_PER_IP_PER_DAY) return { ok: false, reason: 'Ten demo workspaces a day from one network. Try again tomorrow.' }

  const wsId = newId('ws')
  await db.prepare('INSERT INTO workspaces (id, created_at, ip_day_hash) VALUES (?, ?, ?)').bind(wsId, o.now, o.ipHash).run()
  const agents: { id: string; name: string; key: string }[] = []
  for (const name of DEMO_AGENTS) {
    const id = newId('agt')
    const key = await agentKey(o.secret, id)
    await createAgent(db, wsId, name, await sha256Hex(key), o.now, id)
    agents.push({ id, name, key })
  }

  const historyAgent = agents[1]
  const tabId = newId('tab')
  const tabCreated = o.now - 7 * 24 * 60 * 60 * 1000
  const calls: { tool: string; price: number; status: string; reason: string | null; evidence: string | null; judged: string; args: string; result: string; at: number }[] = []
  const struck: Record<number, { reason: string; evidence: string; judged: string }> = {
    4: { reason: 'EMPTY', evidence: '', judged: 'code' },
    11: { reason: 'OFF_REQUEST', evidence: 'London has mild weather this week', judged: 'model' },
    16: { reason: 'ERROR', evidence: 'Upstream timed out.', judged: 'code' },
  }
  let total = 0
  for (let seq = 1; seq <= 18; seq++) {
    const tool = seq % 2 ? 'convert_time' : 'business_days'
    const price = seq % 2 ? 25 : 5
    const strike = struck[seq]
    if (!strike) total += price
    const content = tool === 'convert_time' ? '09:00 in London is 01:00 in Los Angeles.' : 'There are 5 business days in that range.'
    calls.push({ tool, price, status: strike ? 'STRUCK' : 'BILLABLE', reason: strike?.reason ?? null,
      evidence: strike?.evidence ?? null, judged: strike?.judged ?? 'code',
      args: tool === 'convert_time' ? '{"time":"09:00","from":"London","to":"Los Angeles"}' : '{"start":"2026-10-01","end":"2026-10-07"}',
      result: JSON.stringify({ content: [{ type: 'text', text: content }] }), at: tabCreated + Math.floor((seq - 1) * 7 * 24 * 60 * 60 * 1000 / 18) })
  }
  await db.prepare("INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, order_id, capture_id, captured_cents, note, created_at) VALUES (?, ?, ?, 'PAID', ?, ?, NULL, NULL, 0, 'demo history', ?)")
    .bind(tabId, wsId, historyAgent.id, total, DEMO_THRESHOLD_CENTS, tabCreated).run()
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]
    await db.prepare(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status,
      reason_code, evidence, judged_by, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
      .bind(newId('call'), i + 1, wsId, historyAgent.id, tabId, c.tool, c.args, c.result, c.price, c.status, c.reason, c.evidence, c.judged, c.at).run()
  }
  return { ok: true, ws_id: wsId, agents }
}

export async function takeRun(db: D1Database, wsId: string): Promise<boolean> {
  const result = await db.prepare('UPDATE workspaces SET runs = runs + 1 WHERE id = ? AND runs < ?').bind(wsId, RUNS_PER_WORKSPACE).run()
  return result.meta.changes > 0
}

export async function bump(db: D1Database, key: string, cap?: number): Promise<boolean> {
  await db.prepare('INSERT OR IGNORE INTO counters (key, n) VALUES (?, 0)').bind(key).run()
  const statement = cap === undefined
    ? db.prepare('UPDATE counters SET n = n + 1 WHERE key = ?').bind(key)
    : db.prepare('UPDATE counters SET n = n + 1 WHERE key = ? AND n + 1 <= ?').bind(key, cap)
  const result = await statement.run()
  return result.meta.changes > 0
}

export async function deleteOldWorkspaces(db: D1Database, now: number): Promise<number> {
  const cutoff = now - WORKSPACE_HOURS * 60 * 60 * 1000
  const old = '(SELECT id FROM workspaces WHERE created_at < ?)'
  const oldAgents = `(SELECT id FROM agents WHERE ws_id IN ${old})`
  const statements = [
    db.prepare("DELETE FROM counters WHERE key LIKE 'all:%' AND substr(key, 5, 16) < ?")
      .bind(new Date(cutoff).toISOString().slice(0, 16)),
    db.prepare(`DELETE FROM chain_heads WHERE agent_id IN ${oldAgents}`).bind(cutoff),
    db.prepare(`DELETE FROM chain_events WHERE agent_id IN ${oldAgents}`).bind(cutoff),
    db.prepare(`DELETE FROM calls WHERE ws_id IN ${old}`).bind(cutoff),
    db.prepare(`DELETE FROM claims WHERE ws_id IN ${old}`).bind(cutoff),
    db.prepare(`DELETE FROM trace WHERE ws_id IN ${old}`).bind(cutoff),
    db.prepare(`DELETE FROM tabs WHERE ws_id IN ${old}`).bind(cutoff),
    db.prepare(`DELETE FROM agents WHERE ws_id IN ${old}`).bind(cutoff),
    db.prepare(`DELETE FROM workspaces WHERE created_at < ?`).bind(cutoff),
  ]
  const result = await db.batch(statements)
  return result[result.length - 1]?.meta?.changes ?? 0
}
