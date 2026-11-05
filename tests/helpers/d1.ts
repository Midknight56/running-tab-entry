// A D1 stand in for unit tests, on Node's built in SQLite, with the real migration applied.
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

type Value = string | number | null

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private params: Value[] = []) {}
  bind(...params: unknown[]): Stmt {
    return new Stmt(this.db, this.sql, params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : (p as Value))))
  }
  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined
    if (!row) return null
    return (col ? row[col] : { ...row }) as T
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: object }> {
    const rows = this.db.prepare(this.sql).all(...this.params) as Record<string, unknown>[]
    return { results: rows.map((r) => ({ ...r })) as T[], success: true, meta: {} }
  }
  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const r = this.db.prepare(this.sql).run(...this.params)
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }
  }
  runSync() {
    return this.db.prepare(this.sql).run(...this.params)
  }
}

export interface FakeD1 extends D1Database { raw: DatabaseSync }

export function fakeD1(): FakeD1 {
  const db = new DatabaseSync(':memory:')
  const dir = join(import.meta.dirname, '..', '..', 'migrations')
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'))
  const d1 = {
    raw: db,
    prepare: (sql: string) => new Stmt(db, sql),
    async batch(stmts: Stmt[]) {
      db.exec('BEGIN')
      try {
        const out = []
        for (const s of stmts) {
          const r = s.runSync()
          out.push({ success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } })
        }
        db.exec('COMMIT')
        return out
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
    async exec(sql: string) {
      db.exec(sql)
      return { count: 0, duration: 0 }
    },
  }
  return d1 as unknown as FakeD1
}

/** A KV stand in: get, put with expirationTtl recorded, delete. */
export function fakeKV() {
  const store = new Map<string, { value: string; ttl?: number }>()
  return {
    store,
    async get(key: string) { return store.get(key)?.value ?? null },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) { store.set(key, { value, ttl: opts?.expirationTtl }) },
    async delete(key: string) { store.delete(key) },
  } as unknown as KVNamespace & { store: Map<string, { value: string; ttl?: number }> }
}
