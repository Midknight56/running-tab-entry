import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('migrates saved uncertain card sends and skips both legacy wallet creation keys', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const dir = join(import.meta.dirname, '..', 'migrations')
    const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
    for (const f of files.filter(f => f < '0009')) db.exec(readFileSync(join(dir, f), 'utf8'))
    for (const order of ['ORDER1', 'ORDER2']) db.prepare(`INSERT INTO tabs
      (id, ws_id, agent_id, state, total_cents, threshold_cents, order_id, created_at)
      VALUES (?, 'ws1', 'agt_1', 'DUE', 500, 500, ?, 1)`).run(`tab_${order}`, order)
    db.exec(`INSERT INTO pay_attempts (tab_id, ws_id, method, request_id, body_json, state, created_at, updated_at)
      VALUES ('tab_card', 'ws1', 'card', 'rt-order-tab_card-card', '{"original":"body"}', 'SENT', 1, 1)`)
    for (const f of files.filter(f => f >= '0009')) db.exec(readFileSync(join(dir, f), 'utf8'))
    expect(db.prepare('SELECT wallet_attempt FROM tabs').all().map(row => row.wallet_attempt)).toEqual([2, 2])
    expect(db.prepare('SELECT request_id, body_json, state, send_count FROM pay_attempts').get()).toMatchObject({
      request_id: 'rt-order-tab_card-card', body_json: '{"original":"body"}', state: 'SENT', send_count: 1,
    })
    db.exec(`INSERT INTO tabs (id, ws_id, agent_id, threshold_cents, created_at) VALUES ('fresh', 'ws1', 'agt_1', 500, 1)`)
    expect(db.prepare("SELECT wallet_attempt FROM tabs WHERE id = 'fresh'").get()!.wallet_attempt).toBe(0)
  } finally { db.close() }
})
