import { beforeEach, describe, expect, it } from 'vitest'
import { approveBySeller, fileClaim } from '../src/claims/claims'
import { AUTO_REFUND_SHARE_PERCENT } from '../src/claims/refund'
import { fakeD1, type FakeD1 } from './helpers/d1'
import type { ClaimVerdict } from '../src/audit/checks'
import { startPayment } from '../src/bill/settle'

let db: FakeD1
const agent = { id: 'agt_1', ws_id: 'ws1', name: 'Agent A' }
const approve: ClaimVerdict = { approve: true, reason_code: 'DUPLICATE', evidence: '"time":"09:00"', cited_seqs: [1, 2] }

function fakePayPal(lose = false) {
  const calls: { requestId?: string }[] = []
  const refunds = new Map<string, string>()
  return {
    calls,
    async request(_m: string, _path: string, opts: { requestId?: string } = {}) {
      calls.push({ requestId: opts.requestId })
      if (!refunds.has(opts.requestId!)) refunds.set(opts.requestId!, 'REF' + refunds.size)
      if (lose && calls.length === 1) throw new Error('connection lost after PayPal accepted')
      return { status: 201, body: { id: refunds.get(opts.requestId!), status: 'COMPLETED' } }
    },
  }
}

async function seed(state: string, orderId: string | null = null) {
  await db.prepare(`INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, order_id, capture_id, captured_cents, created_at)
    VALUES ('tab_1', 'ws1', 'agt_1', ?, 510, 500, ?, ?, ?, 1)`).bind(state, orderId, state === 'PAID' ? 'CAP1' : null, state === 'PAID' ? 510 : 0).run()
  for (const [id, seq] of [['call_1', 1], ['call_2', 2]] as const) {
    await db.prepare(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
      VALUES (?, ?, 'ws1', 'agt_1', 'tab_1', 'convert_time', '{"time":"09:00"}', '{}', 25, 'BILLABLE', ?)`).bind(id, seq, seq * 1000).run()
  }
}

const deps = (pp: ReturnType<typeof fakePayPal>) => ({ db, pp: pp as any, judge: async () => approve, now: () => 5000 })
const refunded = () => db.prepare('SELECT refunded_cents FROM tabs').first<number>('refunded_cents')

beforeEach(() => { db = fakeD1() })

describe('claims under races and lost answers', () => {
  it.each(['OPEN', 'DUE'])('keeps the bill frozen if checkout locks a %s snapshot before the strike batch', async state => {
    await seed(state)
    const batch = db.batch.bind(db)
    let intercepted = false
    db.batch = (async statements => {
      if (!intercepted) {
        intercepted = true
        await db.prepare("UPDATE tabs SET state = 'DUE', pay_method = 'wallet', pay_started_at = 5000").run()
      }
      return batch(statements)
    }) as typeof db.batch
    const pp = fakePayPal()
    const r = await fileClaim(deps(pp), agent, 2, 'billed twice')
    expect(r.claim.state).toBe('WAITING_SELLER')
    expect(await db.prepare("SELECT status FROM calls WHERE id = 'call_2'").first('status')).toBe('BILLABLE')
    expect(await db.prepare('SELECT total_cents FROM tabs').first('total_cents')).toBe(510)
    expect(pp.calls).toHaveLength(0)
  })

  it.each([
    "pay_method = 'card', pay_started_at = 5000",
    'pay_method = NULL, pay_started_at = 5000',
    "capture_id = 'CAP1'",
    'captured_cents = 510',
  ])('keeps the bill frozen after checkout starts: %s', async update => {
    await seed('DUE')
    await db.prepare(`UPDATE tabs SET ${update}`).run()
    const pp = fakePayPal()
    const r = await fileClaim(deps(pp), agent, 2, 'billed twice')
    expect(r.claim.state).toBe('WAITING_SELLER')
    expect(await db.prepare("SELECT status FROM calls WHERE id = 'call_2'").first('status')).toBe('BILLABLE')
    expect(await db.prepare('SELECT total_cents FROM tabs').first('total_cents')).toBe(510)
    expect(pp.calls).toHaveLength(0)
  })

  it('refuses checkout when a claim first lowers a due tab below its threshold', async () => {
    await seed('DUE')
    const pp = fakePayPal()
    await fileClaim(deps(pp), agent, 2, 'billed twice')
    expect(await startPayment({ db, pp: pp as never, origin: 'https://test.invalid' }, 'tab_1'))
      .toMatchObject({ kind: 'refused', reason: 'This tab is not due yet.' })
    expect(pp.calls).toHaveLength(0)
  })

  it.each(['SENT', 'FAILED', 'DONE'])('keeps the bill frozen with a saved %s card attempt', async state => {
    await seed('DUE')
    await db.prepare(`INSERT INTO pay_attempts (tab_id, ws_id, method, request_id, body_json, state, created_at, updated_at)
      VALUES ('tab_1', 'ws1', 'card', 'attempt', '{}', ?, 1, 1)`).bind(state).run()
    const pp = fakePayPal()
    const r = await fileClaim(deps(pp), agent, 2, 'billed twice')
    expect(r.claim.state).toBe('WAITING_SELLER')
    expect(await db.prepare('SELECT total_cents FROM tabs').first('total_cents')).toBe(510)
    expect(await db.prepare("SELECT status FROM calls WHERE id = 'call_2'").first('status')).toBe('BILLABLE')
    expect(pp.calls).toHaveLength(0)
  })

  it('keeps a due tab due when the adjusted total still meets the threshold', async () => {
    await seed('DUE')
    await db.prepare('UPDATE tabs SET total_cents = 550, due_at = 1000').run()
    const pp = fakePayPal()
    const r = await fileClaim(deps(pp), agent, 2, 'billed twice')
    expect(r.claim.refund_status).toBe('NOT_DUE')
    expect(await db.prepare('SELECT state, total_cents, due_at FROM tabs').first())
      .toEqual({ state: 'DUE', total_cents: 525, due_at: 1000 })
    expect(pp.calls).toHaveLength(0)
  })

  it('reserves at most 20 percent for two automatic claims judged at once', async () => {
    await seed('PAID')
    await db.prepare('UPDATE tabs SET captured_cents = 1000, total_cents = 1000').run()
    await db.prepare('UPDATE calls SET price_cents = 200').run()
    const reservations: number[] = []
    const pp = fakePayPal()
    const d = deps(pp)
    // These independent bad answers test the capture cap, not duplicate eligibility.
    d.judge = async () => ({ ...approve, reason_code: 'NONSENSE' })
    const send = pp.request.bind(pp)
    pp.request = async (...args) => {
      reservations.push((await refunded())!)
      return send(...args)
    }
    const results = await Promise.all([
      fileClaim(d, agent, 1, 'bad answer'), fileClaim(d, agent, 2, 'also bad'),
    ])
    expect.soft(results.filter(r => ['REFUNDING', 'REFUNDED'].includes(r.claim.state))).toHaveLength(1)
    const waiting = results.find(r => r.claim.state === 'WAITING_SELLER')
    expect.soft(waiting?.message).toContain('refund waits for the seller')
    expect.soft(waiting?.claim.refund_status ?? null).toBeNull()
    expect.soft(pp.calls).toHaveLength(1)
    expect.soft(await refunded()).toBe(200)
    expect.soft(reservations.every(n => n * 100 <= 1000 * AUTO_REFUND_SHARE_PERCENT)).toBe(true)
  })

  it('resumes a seller refund above the automatic share after a lost answer without reserving twice', async () => {
    await seed('PAID')
    await db.prepare('UPDATE calls SET price_cents = 200').run()
    const pp = fakePayPal(true)
    const d = deps(pp)
    const first = await fileClaim(d, agent, 1, 'bad answer')
    expect(first.claim.state).toBe('WAITING_SELLER')
    await expect(approveBySeller(d, 'ws1', first.claim.id)).rejects.toThrow(/connection lost/)
    expect(await db.prepare('SELECT refund_status FROM claims').first('refund_status')).toBe('RETRY_SELLER')
    expect(await refunded()).toBe(200)
    const again = await fileClaim(d, agent, 1, 'bad answer')
    expect(again.claim.state).toBe('REFUNDED')
    expect(pp.calls.map(c => c.requestId)).toEqual([pp.calls[0].requestId, pp.calls[0].requestId])
    expect(await refunded()).toBe(200)
  })

  it('two claims on one call at once make one claim and one refund', async () => {
    await seed('PAID')
    const pp = fakePayPal()
    const [a, b] = await Promise.all([fileClaim(deps(pp), agent, 2, 'billed twice'), fileClaim(deps(pp), agent, 2, 'billed twice too')])
    expect(a.claim.id).toBe(b.claim.id)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM claims').first<number>('n')).toBe(1)
    expect(new Set(pp.calls.map((c) => c.requestId)).size).toBe(1)
    expect(await refunded()).toBe(25)
  })

  it('a refund whose answer was lost is finished by the next attempt, once', async () => {
    await seed('PAID')
    const pp = fakePayPal(true)
    await expect(fileClaim(deps(pp), agent, 2, 'billed twice')).rejects.toThrow(/connection lost/)
    expect(await db.prepare('SELECT state FROM claims').first<string>('state')).toBe('REFUNDING')
    expect(await db.prepare('SELECT refund_status FROM claims').first('refund_status')).toBe('RETRY_AUTO')
    const again = await fileClaim(deps(pp), agent, 2, 'billed twice')
    expect(again.claim.state).toBe('REFUNDED')
    expect(pp.calls.map((c) => c.requestId)).toEqual([pp.calls[0].requestId, pp.calls[0].requestId])
    expect(await refunded()).toBe(25)
  })

  it('once a PayPal order exists for the tab, an upheld claim waits instead of changing the billed total', async () => {
    await seed('DUE', 'ORD1')
    const pp = fakePayPal()
    const r = await fileClaim(deps(pp), agent, 2, 'billed twice')
    expect(r.claim.state).toBe('WAITING_SELLER')
    expect(await db.prepare("SELECT status FROM calls WHERE id = 'call_2'").first<string>('status')).toBe('BILLABLE')
    expect(await db.prepare('SELECT total_cents FROM tabs').first<number>('total_cents')).toBe(510)
    expect(pp.calls).toHaveLength(0)
  })
})
