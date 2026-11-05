import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { approveBySeller } from '../src/claims/claims'
import { fakeD1 } from './helpers/d1'

it('routes only stranded unsent independent claims on retained charges to the seller', async () => {
  const db = fakeD1()
  try {
    await db.prepare(`INSERT INTO tabs
      (id, ws_id, agent_id, state, total_cents, threshold_cents, capture_id, captured_cents, refunded_cents, created_at)
      VALUES ('tab_1', 'ws1', 'agt_1', 'PAID', 500, 500, 'CAP1', 500, 25, 1)`).run()
    const cases = [
      { id: 'stranded' },
      { id: 'duplicate', reason: 'DUPLICATE' },
      { id: 'pending', state: 'REFUNDING', refund: 'PENDING', refundId: 'REF_PENDING' },
      { id: 'uncertain', state: 'REFUNDING', refund: 'RETRY_AUTO' },
      { id: 'unknown', verdict: null, reason: null },
      { id: 'rejected', state: 'REJECTED', verdict: 'reject' },
      { id: 'struck', callStatus: 'STRUCK', refund: 'NOT_DUE' },
      { id: 'completed', state: 'REFUNDED', callStatus: 'REFUNDED', refund: 'COMPLETED', refundId: 'REF_DONE' },
      { id: 'has_refund', refundId: 'REF_CHECK' },
      { id: 'unrelated', retained: false },
    ]
    for (const [seq, row] of cases.entries()) {
      await db.prepare(`INSERT INTO calls
        (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
        VALUES (?, ?, 'ws1', 'agt_1', 'tab_1', 'convert_time', '{}', '{}', 25, ?, 1)`)
        .bind(row.id, seq + 1, row.callStatus ?? 'BILLABLE').run()
      await db.prepare(`INSERT INTO claims
        (id, ws_id, call_id, reason_text, state, verdict, reason_code, refund_id, refund_status, created_at)
        VALUES (?, 'ws1', ?, 'bad answer', ?, ?, ?, ?, ?, 1)`)
        .bind(row.id, row.id, row.state ?? 'APPROVED', row.verdict === undefined ? 'approve' : row.verdict,
          row.reason === undefined ? 'NONSENSE' : row.reason, row.refundId ?? null, row.refund ?? null).run()
      if (row.retained !== false) await db.prepare(`INSERT INTO duplicate_reservations (claim_id, call_id, retained_call_id)
        VALUES (?, ?, ?)`).bind(`duplicate_${row.id}`, `copy_${row.id}`, row.id).run()
    }
    const before = (await db.prepare('SELECT * FROM claims ORDER BY id').all()).results
    const dir = join(import.meta.dirname, '..', 'migrations')
    for (const file of readdirSync(dir).filter(f => f.startsWith('0012_'))) db.raw.exec(readFileSync(join(dir, file), 'utf8'))
    expect((await db.prepare('SELECT * FROM claims ORDER BY id').all()).results)
      .toEqual(before.map(row => row.id === 'stranded' ? { ...row, state: 'WAITING_SELLER' } : row))
    expect(await db.prepare('SELECT refunded_cents FROM tabs').first('refunded_cents')).toBe(25)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM duplicate_reservations').first('n')).toBe(9)
    let sends = 0
    const pp = { request: async () => { sends++; return { status: 201, body: { id: 'REF_FIXED', status: 'COMPLETED' } } } }
    expect(await approveBySeller({ db, pp: pp as any, judge: async () => null }, 'ws1', 'stranded'))
      .toMatchObject({ ok: true, claim: { state: 'REFUNDED', refund_status: 'COMPLETED' } })
    expect(sends).toBe(1)
    expect(await db.prepare('SELECT refunded_cents FROM tabs').first('refunded_cents')).toBe(50)
  } finally { db.raw.close() }
})
