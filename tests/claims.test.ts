import { beforeEach, describe, expect, it } from 'vitest'
import { approveBySeller, fileClaim, type ClaimDeps } from '../src/claims/claims'
import { AUTO_REFUND_MAX_CENTS, refundCall } from '../src/claims/refund'
import { fakeD1, type FakeD1 } from './helpers/d1'
import type { ClaimVerdict } from '../src/audit/checks'
import { makeClaimJudge } from '../src/claims/judge'

let db: FakeD1
const agent = { id: 'agt_1', ws_id: 'ws1', name: 'Agent A' }

function fakePayPal(status = 201) {
  const calls: { path: string; requestId?: string; body: any }[] = []
  return {
    calls,
    async request(_m: string, path: string, opts: { body?: any; requestId?: string } = {}) {
      calls.push({ path, requestId: opts.requestId, body: opts.body })
      if (status !== 201) return { status, body: { name: 'UNPROCESSABLE_ENTITY' }, name: 'UNPROCESSABLE_ENTITY', debugId: 'd' }
      return { status: 201, body: { id: 'REF' + calls.length, status: 'COMPLETED' }, debugId: 'd' }
    },
  }
}

const approve: ClaimVerdict = { approve: true, reason_code: 'DUPLICATE', evidence: '"time":"09:00"', cited_seqs: [1, 2] }

async function seed(o: { state?: string; captured?: number; refunded?: number; price?: number } = {}) {
  await db.prepare(`INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, capture_id, captured_cents, refunded_cents, created_at)
    VALUES ('tab_1', 'ws1', 'agt_1', ?, ?, 500, ?, ?, ?, 1)`)
    .bind(o.state ?? 'PAID', o.captured ?? 510, (o.state ?? 'PAID') === 'PAID' ? 'CAP1' : null, o.captured ?? 510, o.refunded ?? 0).run()
  for (const [id, seq, agentId] of [['call_1', 1, 'agt_1'], ['call_2', 2, 'agt_1'], ['call_x', 3, 'agt_other']] as const) {
    await db.prepare(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
      VALUES (?, ?, 'ws1', ?, 'tab_1', 'convert_time', '{"time":"09:00"}', '{}', ?, 'BILLABLE', ?)`).bind(id, seq, agentId, o.price ?? 25, seq * 1000).run()
  }
}

function deps(pp = fakePayPal(), verdict: ClaimVerdict | null = approve): ClaimDeps & { pp: ReturnType<typeof fakePayPal> } {
  return { db, pp: pp as any, judge: async () => verdict, now: () => 5000 } as any
}

const tab = () => db.prepare('SELECT captured_cents, refunded_cents FROM tabs').first<any>()

beforeEach(() => { db = fakeD1() })

describe('claims and refunds', () => {
  it.each(['STRUCK', 'REFUNDED', 'FREE'])('rejects a duplicate supported only by a %s matching call', async status => {
    await seed()
    await db.prepare("UPDATE calls SET status = ?, price_cents = ? WHERE id = 'call_1'")
      .bind(status === 'FREE' ? 'BILLABLE' : status, status === 'FREE' ? 0 : 25).run()
    await db.prepare("UPDATE calls SET args_json = '{}' WHERE id = 'call_x'").run()
    await db.prepare("UPDATE calls SET price_cents = 125 WHERE id = 'call_x'").run()
    await db.prepare('UPDATE tabs SET total_cents = 150, captured_cents = 150').run()
    const d = deps()
    d.judge = makeClaimJudge({ ask: async () => ({ text: JSON.stringify({
      verdict: 'approve', claim_names: 'DUPLICATE', reason_code: 'DUPLICATE', evidence: '"time":"09:00"', cited_call_ids: [1, 2],
    }) }) } as never)
    const r = await fileClaim(d, agent, 2, 'billed twice')
    expect(d.pp.calls).toHaveLength(0)
    expect(r.claim.state).toBe('REJECTED')
    expect((await tab()).refunded_cents).toBe(0)
  })

  it('checks the automatic amount cap inside the reservation even with a stale approval', async () => {
    await seed({ captured: 5000, price: AUTO_REFUND_MAX_CENTS + 1 })
    await db.prepare(`INSERT INTO claims (id, ws_id, call_id, reason_text, state, created_at)
      VALUES ('clm_auto', 'ws1', 'call_2', 'bad answer', 'APPROVED', 1)`).run()
    const d = deps()
    const call = (await db.prepare("SELECT * FROM calls WHERE id = 'call_2'").first<any>())!
    const paid = (await db.prepare("SELECT * FROM tabs WHERE id = 'tab_1'").first<any>())!
    await refundCall(db, d.pp as any, 'clm_auto', call, paid, 'auto')
    expect(await db.prepare("SELECT state, refund_status FROM claims WHERE id = 'clm_auto'").first()).toEqual({ state: 'WAITING_SELLER', refund_status: null })
    expect(d.pp.calls).toHaveLength(0)
    expect((await tab()).refunded_cents).toBe(0)
  })

  it('rolls back the strike and total if marking the refund NOT_DUE fails', async () => {
    await seed({ state: 'OPEN' })
    await db.prepare('UPDATE tabs SET total_cents = 75, captured_cents = 0').run()
    db.raw.exec(`CREATE TRIGGER refuse_not_due BEFORE UPDATE OF refund_status ON claims
      WHEN NEW.refund_status = 'NOT_DUE' BEGIN SELECT RAISE(ABORT, 'cannot mark refund'); END`)
    await expect(fileClaim(deps(), agent, 2, 'billed twice')).rejects.toThrow('cannot mark refund')
    expect(await db.prepare("SELECT status FROM calls WHERE id = 'call_2'").first('status')).toBe('BILLABLE')
    expect(await db.prepare('SELECT total_cents FROM tabs').first('total_cents')).toBe(75)
  })

  it('an approved claim on a paid call refunds exactly its price', async () => {
    await seed()
    const d = deps()
    const r = await fileClaim(d, agent, 2, 'a retry of call 1, billed twice')
    expect(r.claim.state).toBe('REFUNDED')
    expect(d.pp.calls).toHaveLength(1)
    expect(d.pp.calls[0].path).toBe('/v2/payments/captures/CAP1/refund')
    expect(d.pp.calls[0].body.amount).toEqual({ currency_code: 'USD', value: '0.25' })
    expect(d.pp.calls[0].requestId).toBe(`rt-refund-${r.claim.id}`)
    expect(await tab()).toEqual({ captured_cents: 510, refunded_cents: 25 })
    expect(await db.prepare("SELECT status FROM calls WHERE id = 'call_2'").first<string>('status')).toBe('REFUNDED')
  })

  it('the same claim twice gives one PayPal call', async () => {
    await seed()
    const d = deps()
    const a = await fileClaim(d, agent, 2, 'billed twice')
    const b = await fileClaim(d, agent, 2, 'billed twice, again')
    expect(b.claim.id).toBe(a.claim.id)
    expect(d.pp.calls).toHaveLength(1)
  })

  it('a refund never passes captured minus refunded', async () => {
    await seed({ captured: 510, refunded: 500, price: 25 })
    const d = deps()
    const r = await fileClaim(d, agent, 2, 'billed twice')
    expect(r.claim.state).not.toBe('REFUNDED')
    expect(d.pp.calls).toHaveLength(0)
    expect((await tab()).refunded_cents).toBe(500)
  })

  it('above the auto refund limit the claim waits for the seller, who can approve it', async () => {
    await seed({ captured: 5000, price: AUTO_REFUND_MAX_CENTS + 1 })
    const d = deps()
    const r = await fileClaim(d, agent, 2, 'billed twice')
    expect(r.claim.state).toBe('WAITING_SELLER')
    expect(d.pp.calls).toHaveLength(0)
    const s = await approveBySeller(d, 'ws1', r.claim.id)
    expect(s.claim.state).toBe('REFUNDED')
    expect(d.pp.calls).toHaveLength(1)
  })

  it('above 20 percent of the capture the claim waits for the seller', async () => {
    await seed({ captured: 100, price: 25 })
    await db.prepare("UPDATE tabs SET refunded_cents = 0").run()
    const d = deps()
    const r = await fileClaim(d, agent, 2, 'billed twice')
    expect(r.claim.state).toBe('WAITING_SELLER')
    expect((await approveBySeller(d, 'ws1', r.claim.id)).ok).toBe(true)
    expect(d.pp.calls).toHaveLength(1)
    expect((await tab()).refunded_cents).toBe(25)
  })

  it('a claim on another agent\'s call, or an unknown call, is refused', async () => {
    await seed()
    const d = deps()
    await expect(fileClaim(d, agent, 3, 'not mine')).rejects.toThrow(/not one of your calls/)
    await expect(fileClaim(d, agent, 99, 'nothing')).rejects.toThrow(/not one of your calls/)
    await expect(fileClaim(d, { ...agent, ws_id: 'ws2' }, 2, 'other workspace')).rejects.toThrow(/not one of your calls/)
  })

  it('a rejected claim moves no money', async () => {
    await seed()
    const d = deps(fakePayPal(), { approve: false })
    expect((await fileClaim(d, agent, 2, 'meh')).claim.state).toBe('REJECTED')
    expect(d.pp.calls).toHaveLength(0)
  })

  it('when the judge gives no usable verdict the claim waits for the seller', async () => {
    await seed()
    const d = deps(fakePayPal(), null)
    expect((await fileClaim(d, agent, 2, 'billed twice')).claim.state).toBe('WAITING_SELLER')
    expect(d.pp.calls).toHaveLength(0)
  })

  it('an approved claim on a call not yet paid strikes it from the open tab, with no PayPal call', async () => {
    await seed({ state: 'OPEN' })
    await db.prepare("UPDATE tabs SET total_cents = 75, captured_cents = 0").run()
    const d = deps()
    const r = await fileClaim(d, agent, 2, 'billed twice')
    expect(r.claim.state).toBe('APPROVED')
    expect(r.claim.verdict).toBe('approve')
    expect(r.claim.refund_status).toBe('NOT_DUE')
    expect(d.pp.calls).toHaveLength(0)
    expect(await db.prepare('SELECT total_cents FROM tabs').first<number>('total_cents')).toBe(50)
    expect(await db.prepare("SELECT status, judged_by FROM calls WHERE id = 'call_2'").first<any>()).toEqual({ status: 'STRUCK', judged_by: 'claim' })
  })

  it('an approved claim on a due tab before checkout strikes the call and reopens the tab', async () => {
    await seed({ state: 'DUE' })
    await db.prepare("UPDATE tabs SET total_cents = 50, threshold_cents = 50, captured_cents = 0, due_at = 1000").run()
    const d = deps()
    const r = await fileClaim(d, agent, 2, 'billed twice')
    expect(r.claim.refund_status).toBe('NOT_DUE')
    expect(r.claim.state).toBe('APPROVED')
    expect(d.pp.calls).toHaveLength(0)
    expect(await db.prepare('SELECT state, total_cents, due_at FROM tabs').first()).toEqual({ state: 'OPEN', total_cents: 25, due_at: null })
    expect(await db.prepare("SELECT status, judged_by FROM calls WHERE id = 'call_2'").first<any>()).toEqual({ status: 'STRUCK', judged_by: 'claim' })
  })

  it.each(['APPROVED', 'WAITING_SELLER'])('refuses a NOT_DUE claim even if its state is %s', async state => {
    await seed()
    await db.prepare(`INSERT INTO claims (id, ws_id, call_id, reason_text, state, refund_status, created_at)
      VALUES ('clm_not_due', 'ws1', 'call_2', 'bad answer', ?, 'NOT_DUE', 1)`).bind(state).run()
    const d = deps()
    expect(await approveBySeller(d, 'ws1', 'clm_not_due')).toMatchObject({ ok: false, name: 'NOT_WAITING', claim: { state, refund_status: 'NOT_DUE' } })
    expect(d.pp.calls).toHaveLength(0)
    expect((await tab()).refunded_cents).toBe(0)
  })

  it('a refund PayPal refuses leaves the call billed and the claim marked failed', async () => {
    await seed()
    const d = deps(fakePayPal(422))
    const r = await fileClaim(d, agent, 2, 'billed twice')
    expect(r.claim.state).toBe('APPROVED')
    expect(r.claim.refund_status).toBe('FAILED UNPROCESSABLE_ENTITY')
    expect((await tab()).refunded_cents).toBe(0)
  })
})
