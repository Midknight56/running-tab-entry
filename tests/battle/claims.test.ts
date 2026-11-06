import { beforeEach, describe, expect, it } from 'vitest'
import { approveBySeller, fileClaim, type ClaimDeps } from '../../src/claims/claims'
import { makeClaimJudge } from '../../src/claims/judge'
import type { ClaimVerdict } from '../../src/audit/checks'
import { fakeD1, type FakeD1 } from '../helpers/d1'

let db: FakeD1
const agent = { id: 'agt_1', ws_id: 'ws1', name: 'Agent A' }
// These requests have different inputs. Keep cap and idempotency tests independent of duplicate eligibility.
const approve: ClaimVerdict = { approve: true, reason_code: 'NONSENSE', evidence: '09:00', cited_seqs: [1, 2] }

function paypal(lost = false) {
  const calls: { requestId?: string; body?: any }[] = []
  const results = new Map<string, string>()
  return {
    calls,
    async request(_method: string, _path: string, opts: { requestId?: string; body?: any } = {}) {
      calls.push(opts)
      const key = opts.requestId!
      if (!results.has(key)) results.set(key, `REF${results.size + 1}`)
      if (lost && calls.length === 1) throw new Error('timeout after PayPal accepted')
      return { status: 201, body: { id: results.get(key), status: 'COMPLETED' } }
    },
  }
}

async function seed(opts: { state?: string; captured?: number; refunded?: number; prices?: number[]; statuses?: string[] } = {}) {
  const state = opts.state ?? 'PAID'
  const captured = opts.captured ?? (state === 'PAID' ? 1000 : 0)
  await db.prepare(`INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, capture_id, captured_cents, refunded_cents, created_at)
    VALUES ('tab_1', 'ws1', 'agt_1', ?, 1000, 500, ?, ?, ?, 1)`)
    .bind(state, state === 'PAID' ? 'CAP1' : null, captured, opts.refunded ?? 0).run()
  for (let i = 0; i < (opts.prices ?? [25, 25]).length; i++) {
    const seq = i + 1
    await db.prepare(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
      VALUES (?, ?, 'ws1', 'agt_1', 'tab_1', 'convert_time', ?, ?, ?, ?, ?)`)
      .bind(`call_${seq}`, seq, JSON.stringify({ time: '09:00', input: seq }), JSON.stringify({ content: [{ text: `answer ${seq}` }] }), (opts.prices ?? [25, 25])[i], (opts.statuses ?? [])[i] ?? 'BILLABLE', seq * 1000).run()
  }
  await db.prepare(`INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, created_at)
    VALUES ('tab_other', 'ws2', 'agt_other', 'OPEN', 25, 500, 1)`).run()
  await db.prepare(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
    VALUES ('call_other', 1, 'ws2', 'agt_other', 'tab_other', 'convert_time', '{}', '{}', 25, 'BILLABLE', 1)`).run()
}

function deps(pp = paypal(), judge: ClaimVerdict | null = approve): ClaimDeps & { pp: ReturnType<typeof paypal> } {
  return { db, pp: pp as any, judge: async () => judge, now: () => 5000 } as any
}

beforeEach(() => { db = fakeD1() })

describe('claim attack cases', () => {
  it('one call filed twice in sequence and at once produces at most one refund with one request id', async () => {
    await seed()
    const d = deps()
    const [first, raced] = await Promise.all([fileClaim(d, agent, 2, 'duplicate'), fileClaim(d, agent, 2, 'duplicate race')])
    expect(raced.claim.id).toBe(first.claim.id)
    const second = await fileClaim(d, agent, 2, 'duplicate again')
    const [third, fourth] = await Promise.all([fileClaim(d, agent, 2, 'racing a'), fileClaim(d, agent, 2, 'racing b')])
    expect([first, second, third, fourth].map((x) => x.claim.id).every((id) => id === first.claim.id)).toBe(true)
    expect(d.pp.calls).toHaveLength(1)
    expect(new Set(d.pp.calls.map((x) => x.requestId))).toEqual(new Set([`rt-refund-${first.claim.id}`]))
  })

  it('claims on separate calls cannot race refunds past captured minus refunded cents', async () => {
    await seed({ captured: 40, refunded: 10, prices: [25, 25] })
    const d = deps()
    const [a, b] = await Promise.all([fileClaim(d, agent, 1, 'duplicate'), fileClaim(d, agent, 2, 'duplicate')])
    expect(a.claim.state).toBe('WAITING_SELLER')
    expect(b.claim.state).toBe('WAITING_SELLER')
    await Promise.all([approveBySeller(d, 'ws1', a.claim.id), approveBySeller(d, 'ws1', b.claim.id)])
    const refunded = await db.prepare('SELECT refunded_cents FROM tabs WHERE id = ?').bind('tab_1').first<number>('refunded_cents')
    expect(refunded).toBeLessThanOrEqual(40)
    expect(d.pp.calls.reduce((n, x) => n + Number(x.body?.amount?.value?.replace('.', '') ?? 0), 0)).toBeLessThanOrEqual(30)
  })

  it('refuses unpaid, struck, missing, invalid sequence, and other workspace calls without refund', async () => {
    await seed({ state: 'OPEN', statuses: ['STRUCK', 'BILLABLE'] })
    const d = deps()
    const unpaid = await fileClaim(d, agent, 2, 'claim')
    expect(unpaid.message).toMatch(/no refund is due.*struck before billing/i)
    await expect(fileClaim(d, agent, 1, 'claim')).rejects.toThrow(/not billed/)
    for (const seq of [0, -1, 999999999]) await expect(fileClaim(d, agent, seq, 'claim')).rejects.toThrow(/not one of your calls/)
    await expect(fileClaim(d, { ...agent, ws_id: 'ws2' }, 2, 'claim')).rejects.toThrow(/not one of your calls/)
    expect(d.pp.calls).toHaveLength(0)
  })

  it('seller approval of high value claims at once refunds once per claim at most', async () => {
    await seed({ captured: 1000, prices: [250, 250] })
    const d = deps()
    const [a, b] = await Promise.all([fileClaim(d, agent, 1, 'duplicate'), fileClaim(d, agent, 2, 'duplicate')])
    expect([a.claim.state, b.claim.state]).toEqual(['WAITING_SELLER', 'WAITING_SELLER'])
    await Promise.all([
      approveBySeller(d, 'ws1', a.claim.id), approveBySeller(d, 'ws1', a.claim.id),
      approveBySeller(d, 'ws1', b.claim.id), approveBySeller(d, 'ws1', b.claim.id),
    ])
    expect(d.pp.calls).toHaveLength(2)
    expect(new Set(d.pp.calls.map((x) => x.requestId)).size).toBe(2)
  })

  it('claims above the automatic amount or share wait for seller approval', async () => {
    await seed({ captured: 5000, prices: [201, 25] })
    const d = deps()
    const amount = await fileClaim(d, agent, 1, 'duplicate')
    expect(amount.claim.state).toBe('WAITING_SELLER')
    await db.prepare('UPDATE tabs SET captured_cents = 100 WHERE id = ?').bind('tab_1').run()
    const share = await fileClaim(d, agent, 2, 'duplicate')
    expect(share.claim.state).toBe('WAITING_SELLER')
    expect(d.pp.calls).toHaveLength(0)
  })

  it('drops verdicts citing outside calls, invented evidence, or a named amount', async () => {
    await seed()
    const claimed = await db.prepare('SELECT * FROM calls WHERE id = ?').bind('call_2').first<any>()
    const tabCalls = (await db.prepare('SELECT * FROM calls WHERE tab_id = ?').bind('tab_1').all<any>()).results
    const verdicts = [
      { verdict: 'approve', claim_names: 'DUPLICATE', reason_code: 'DUPLICATE', evidence: '09:00', cited_call_ids: [88] },
      { verdict: 'approve', claim_names: 'OFF_REQUEST', reason_code: 'OFF_REQUEST', evidence: 'invented evidence', cited_call_ids: [2] },
      { verdict: 'approve', claim_names: 'OFF_REQUEST', reason_code: 'OFF_REQUEST', evidence: '09:00', cited_call_ids: [2], amount: 25 },
    ]
    for (const [index, verdict] of verdicts.entries()) {
      const judge = makeClaimJudge({ ask: async () => ({ text: JSON.stringify(verdict) }) } as any)
      expect(await judge('bad call', claimed, tabCalls)).toEqual(index === 0 ? { approve: false, reason_code: 'DUPLICATE' } : null)
    }
  })

  it('retries a timed out refund with the same request id and records one refund', async () => {
    await seed()
    const pp = paypal(true)
    const d = deps(pp)
    await expect(fileClaim(d, agent, 2, 'duplicate')).rejects.toThrow(/timeout/)
    const retried = await fileClaim(d, agent, 2, 'duplicate')
    expect(retried.claim.state).toBe('REFUNDED')
    expect(pp.calls).toHaveLength(2)
    expect(pp.calls[0].requestId).toBe(pp.calls[1].requestId)
    expect(await db.prepare('SELECT refunded_cents FROM tabs WHERE id = ?').bind('tab_1').first<number>('refunded_cents')).toBe(25)
  })
})
