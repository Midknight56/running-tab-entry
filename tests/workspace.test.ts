import { afterEach, describe, expect, it } from 'vitest'
import { fakeD1, type FakeD1 } from './helpers/d1'
import { agentKey, bump, createWorkspace, deleteOldWorkspaces, RUNS_PER_WORKSPACE, sha256Hex, signWs, takeRun, verifyWs } from '../src/demo/workspace'

describe('demo workspaces', () => {
  let db: FakeD1 | undefined
  afterEach(() => { db?.raw.close(); db = undefined })

  it('limits creation by IP hash per day', async () => {
    db = fakeD1()
    for (let i = 0; i < 10; i++) expect((await createWorkspace(db, { ipHash: 'same', secret: 'secret', now: 1000 })).ok).toBe(true)
    expect(await createWorkspace(db, { ipHash: 'same', secret: 'secret', now: 1000 })).toEqual({ ok: false, reason: 'Ten demo workspaces a day from one network. Try again tomorrow.' })
    expect((await createWorkspace(db, { ipHash: 'different', secret: 'secret', now: 1000 })).ok).toBe(true)
  })

  it('creates two derived-key agents and stable workspace signatures', async () => {
    db = fakeD1()
    const result = await createWorkspace(db, { ipHash: 'network', secret: 'secret', now: 1000 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.agents).toHaveLength(2)
    expect(result.agents[0].key).not.toBe(result.agents[1].key)
    for (const agent of result.agents) {
      const row = await db.prepare('SELECT key_hash FROM agents WHERE id = ?').bind(agent.id).first<{ key_hash: string }>()
      expect(await sha256Hex(agent.key)).toBe(row?.key_hash)
    }
    expect(await agentKey('secret', result.agents[0].id)).toBe(result.agents[0].key)
    const signed = await signWs('secret', result.ws_id)
    expect(await verifyWs('secret', signed)).toBe(result.ws_id)
    expect(await verifyWs('secret', signed.replace(result.ws_id, 'other'))).toBeNull()
    expect(await verifyWs('secret', signed.slice(0, -1) + (signed.endsWith('a') ? 'b' : 'a'))).toBeNull()
  })

  it('seeds the second agent history and isolates calls by workspace', async () => {
    db = fakeD1()
    const a = await createWorkspace(db, { ipHash: 'a', secret: 's', now: 8 * 86400000 })
    const b = await createWorkspace(db, { ipHash: 'b', secret: 's', now: 8 * 86400000 })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    const callsA = await db.prepare('SELECT * FROM calls WHERE ws_id = ?').bind(a.ws_id).all<{ status: string; price_cents: number }>()
    const callsB = await db.prepare('SELECT * FROM calls WHERE ws_id = ?').bind(b.ws_id).all()
    expect(callsA.results).toHaveLength(18)
    expect(callsA.results.filter(c => c.status === 'STRUCK')).toHaveLength(3)
    const tab = await db.prepare('SELECT total_cents FROM tabs WHERE ws_id = ?').bind(a.ws_id).first<{ total_cents: number }>()
    expect(tab?.total_cents).toBe(callsA.results.filter(c => c.status === 'BILLABLE').reduce((sum, c) => sum + c.price_cents, 0))
    const firstCalls = await db.prepare('SELECT COUNT(*) AS n FROM calls WHERE ws_id = ? AND agent_id = ?').bind(a.ws_id, a.agents[0].id).first<{ n: number }>()
    expect(firstCalls?.n).toBe(0)
    expect(callsB.results).toHaveLength(18)
  })

  it('caps runs and counters', async () => {
    db = fakeD1()
    const ws = await createWorkspace(db, { ipHash: 'x', secret: 's', now: 1 })
    expect(ws.ok).toBe(true)
    if (!ws.ok) return
    for (let i = 0; i < RUNS_PER_WORKSPACE; i++) expect(await takeRun(db, ws.ws_id)).toBe(true)
    expect(await takeRun(db, ws.ws_id)).toBe(false)
    for (let i = 0; i < 2; i++) expect(await bump(db, 'limited', 2)).toBe(true)
    expect(await bump(db, 'limited', 2)).toBe(false)
  })

  it('deletes expired workspaces and all related rows', async () => {
    db = fakeD1()
    const old = await createWorkspace(db, { ipHash: 'old', secret: 's', now: 0 })
    const recent = await createWorkspace(db, { ipHash: 'recent', secret: 's', now: 24 * 3600000 - 3600000 })
    expect(old.ok && recent.ok).toBe(true)
    if (!old.ok || !recent.ok) return
    await db.prepare('INSERT INTO claims (id, ws_id, call_id, reason_text, state, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind('claim', old.ws_id, 'c', 'reason', 'OPEN', 0).run()
    await db.prepare('INSERT INTO trace (ws_id, kind, at) VALUES (?, ?, ?)').bind(old.ws_id, 'model', 0).run()
    const oldAgent = (await db.prepare('SELECT id FROM agents WHERE ws_id = ? LIMIT 1').bind(old.ws_id).first<{ id: string }>())!.id
    await db.prepare("INSERT INTO chain_heads (agent_id, seq, hash, signed_at, entry_kind, call_seq) VALUES (?, 1, 'h', 0, 'CALL', 1)").bind(oldAgent).run()
    await db.prepare("INSERT INTO chain_events (id, agent_id, call_seq, kind, reference, created_at) VALUES ('e', ?, 1, 'REFUND', 'R', 0)").bind(oldAgent).run()
    expect(await deleteOldWorkspaces(db, 24 * 3600000 + 3600000)).toBe(1)
    for (const table of ['chain_heads', 'chain_events']) {
      const gone = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE agent_id = ?`).bind(oldAgent).first<{ n: number }>()
      expect(gone?.n).toBe(0)
    }
    for (const table of ['workspaces', 'agents', 'tabs', 'calls', 'claims', 'trace']) {
      const column = table === 'workspaces' ? 'id' : 'ws_id'
      const gone = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).bind(old.ws_id).first<{ n: number }>()
      expect(gone?.n).toBe(0)
    }
    const kept = await db.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE id = ?').bind(recent.ws_id).first<{ n: number }>()
    expect(kept?.n).toBe(1)
  })
})
