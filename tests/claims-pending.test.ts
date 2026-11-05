import { beforeEach, describe, expect, it } from 'vitest'
import { approveBySeller, fileClaim, getClaim } from '../src/claims/claims'
import { reconcileRefund, reconcileWorkspaceRefunds, refundCall } from '../src/claims/refund'
import { deskData } from '../src/desk-data'
import { tabFacts } from '../src/bill/facts'
import { callsOfTab, getTab } from '../src/tab/ledger'
import { fakeD1, type FakeD1 } from './helpers/d1'

let db: FakeD1
const agent = { id: 'agt_1', ws_id: 'ws1', name: 'Agent' }

function fakePayPal() {
  const calls: { method: string; path: string }[] = []
  let status = 'PENDING'
  return {
    calls, setStatus: (value: string) => { status = value },
    async request(method: string, path: string) {
      calls.push({ method, path })
      return { status: method === 'GET' ? 200 : 201, body: { id: 'REF1', status } }
    },
  }
}

beforeEach(async () => {
  db = fakeD1()
  await db.prepare(`INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, capture_id, captured_cents, created_at)
    VALUES ('tab_1', 'ws1', 'agt_1', 'PAID', 515, 500, 'CAP1', 515, 1)`).run()
  for (const seq of [1, 2]) await db.prepare(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
    VALUES (?, ?, 'ws1', 'agt_1', 'tab_1', 'convert_time', '{}', '{}', 25, 'BILLABLE', 1)`).bind(`call_${seq}`, seq).run()
})

const deps = (pp: ReturnType<typeof fakePayPal>) => ({ db, pp: pp as any, judge: async () => ({ approve: true as const, reason_code: 'NONSENSE', evidence: 'text', cited_seqs: [1] }) })

describe('pending refunds', () => {
  it.each(['auto', 'seller'] as const)('keeps an uncertain %s refund reserved and returns UNCERTAIN when a retry hits DEMO_REFUND_LIMIT', async mode => {
    await db.prepare("INSERT INTO claims (id, ws_id, call_id, reason_text, state, created_at) VALUES ('clm_1', 'ws1', 'call_1', 'bad answer', 'APPROVED', 1)").run()
    const requests: string[] = []
    const pp = { async request(_method: string, _path: string, opts: { requestId?: string }) {
      requests.push(opts.requestId!)
      return requests.length === 1
        ? { status: 503, body: {}, bodyRead: false }
        : { status: 429, body: { name: 'DEMO_REFUND_LIMIT' }, name: 'DEMO_REFUND_LIMIT', bodyRead: true }
    } }
    const call = (await callsOfTab(db, 'tab_1'))[0]
    expect(await refundCall(db, pp as any, 'clm_1', call, (await getTab(db, 'tab_1'))!, mode)).toMatchObject({ status: 'UNCERTAIN' })
    const retryStatus = mode === 'auto' ? 'RETRY_AUTO' : 'RETRY_SELLER'
    expect(await getClaim(db, 'clm_1')).toMatchObject({ state: 'REFUNDING', refund_status: retryStatus })
    expect((await getTab(db, 'tab_1'))!.refunded_cents).toBe(25)
    const result = await refundCall(db, pp as any, 'clm_1', call, (await getTab(db, 'tab_1'))!, mode)
    expect.soft((await getTab(db, 'tab_1'))!.refunded_cents).toBe(25)
    expect.soft(await getClaim(db, 'clm_1')).toMatchObject({ state: 'REFUNDING', refund_status: retryStatus })
    expect.soft(requests).toEqual(['rt-refund-clm_1', 'rt-refund-clm_1'])
    expect(result).toMatchObject({ ok: false, status: 'UNCERTAIN', http: 429, name: 'REFUND_UNCERTAIN' })
  })

  it.each(['auto', 'seller'] as const)('releases a first %s refund reservation when DEMO_REFUND_LIMIT sends nothing', async mode => {
    await db.prepare("INSERT INTO claims (id, ws_id, call_id, reason_text, state, created_at) VALUES ('clm_1', 'ws1', 'call_1', 'bad answer', 'WAITING_SELLER', 1)").run()
    const pp = { request: async () => ({ status: 429, body: { name: 'DEMO_REFUND_LIMIT' }, name: 'DEMO_REFUND_LIMIT', bodyRead: true }) }
    const call = (await callsOfTab(db, 'tab_1'))[0]
    expect(await refundCall(db, pp as any, 'clm_1', call, (await getTab(db, 'tab_1'))!, mode)).toMatchObject({ ok: false, name: 'DEMO_REFUND_LIMIT' })
    expect((await getTab(db, 'tab_1'))!.refunded_cents).toBe(0)
    expect(await getClaim(db, 'clm_1')).toMatchObject({ state: 'WAITING_SELLER', refund_status: null })
  })

  it.each(['unreadable 201', 'server error', 'lost answer', 'unknown refusal', 'unreadable refusal'])('keeps an uncertain %s refund reserved and reconciles with the same request id', async answer => {
    await db.prepare('UPDATE tabs SET total_cents = 1000, captured_cents = 1000').run()
    await db.prepare('UPDATE calls SET price_cents = 200').run()
    const requests: string[] = []
    let first = true
    const pp = { async request(_method: string, _path: string, opts: { requestId?: string }) {
      requests.push(opts.requestId!)
      if (first) {
        first = false
        if (answer === 'lost answer') throw new Error('lost answer after send')
        if (answer === 'unknown refusal') return { status: 422, body: {}, name: 'DECLINED' }
        if (answer === 'unreadable refusal') return { status: 422, body: {}, name: 'UNPROCESSABLE_ENTITY', bodyRead: false }
        return { status: answer === 'server error' ? 503 : 201, body: {}, bodyRead: false }
      }
      return { status: 201, body: { id: 'REF1', status: 'COMPLETED' } }
    } }
    const d = deps(pp as any)
    await fileClaim(d, agent, 1, 'bad answer').catch(() => undefined)
    expect((await getTab(db, 'tab_1'))!.refunded_cents).toBe(200)
    const claim = await db.prepare("SELECT * FROM claims WHERE call_id = 'call_1'").first<any>()
    expect(claim).toMatchObject({ state: 'REFUNDING', refund_status: 'RETRY_AUTO' })
    const second = await fileClaim(d, agent, 2, 'also bad')
    expect(second.claim.state).toBe('WAITING_SELLER')
    expect(requests).toHaveLength(1)
    await reconcileWorkspaceRefunds(db, pp as any, 'ws1', 100000)
    expect(requests).toEqual([`rt-refund-${claim.id}`, `rt-refund-${claim.id}`])
    expect(await getClaim(db, claim.id)).toMatchObject({ state: 'REFUNDED', refund_status: 'COMPLETED', refund_id: 'REF1' })
    expect((await getTab(db, 'tab_1'))!.refunded_cents).toBe(200)
  })

  it('reserves a pending refund without claiming that money has come back', async () => {
    const pp = fakePayPal()
    const d = deps(pp)
    const r = await fileClaim(d, agent, 1, 'bad answer')
    expect(r.claim).toMatchObject({ state: 'REFUNDING', refund_status: 'PENDING', refund_id: 'REF1' })
    await fileClaim(d, agent, 1, 'again')
    expect(pp.calls).toHaveLength(1)
    expect((await callsOfTab(db, 'tab_1'))[0].status).toBe('BILLABLE')
    const data = await deskData(db, 'ws1')
    expect(data.money).toMatchObject({ captured_cents: 515, refunded_cents: 0, refund_pending_cents: 25, net_cents: 515 })
    expect(data.tabs[0]).toMatchObject({ refunded_cents: 25, refund_pending_cents: 25, refunded_done_cents: 0 })
    expect(tabFacts((await getTab(db, 'tab_1'))!, await callsOfTab(db, 'tab_1'))).toMatchObject({ refunded_cents: 0, refund_pending_cents: 25, net_cents: 515 })
  })

  it('finishes a completed refund and records the chain event once', async () => {
    const pp = fakePayPal()
    const r = await fileClaim(deps(pp), agent, 1, 'bad answer')
    pp.setStatus('COMPLETED')
    await reconcileRefund(db, pp as any, r.claim.id)
    await reconcileRefund(db, pp as any, r.claim.id)
    expect(await getClaim(db, r.claim.id)).toMatchObject({ state: 'REFUNDED', refund_status: 'COMPLETED' })
    expect((await callsOfTab(db, 'tab_1'))[0].status).toBe('REFUNDED')
    expect(pp.calls.filter(c => c.method === 'GET')).toEqual([{ method: 'GET', path: '/v2/payments/refunds/REF1' }])
    expect(await db.prepare("SELECT COUNT(*) AS n FROM chain_events WHERE kind = 'REFUND'").first('n')).toBe(1)
    expect((await deskData(db, 'ws1')).money).toMatchObject({ refunded_cents: 25, refund_pending_cents: 0, net_cents: 490 })
  })

  it.each(['FAILED', 'CANCELLED'])('releases a %s reservation once and keeps limits on seller retry', async status => {
    const pp = fakePayPal()
    const d = deps(pp)
    const r = await fileClaim(d, agent, 1, 'bad answer')
    pp.setStatus(status)
    await Promise.all([reconcileRefund(db, pp as any, r.claim.id), reconcileRefund(db, pp as any, r.claim.id)])
    await reconcileRefund(db, pp as any, r.claim.id)
    expect((await getTab(db, 'tab_1'))!.refunded_cents).toBe(0)
    expect(await getClaim(db, r.claim.id)).toMatchObject({ state: 'APPROVED', refund_status: `FAILED ${status}` })
    await db.prepare('UPDATE tabs SET refunded_cents = 500').run()
    expect(await approveBySeller(d, 'ws1', r.claim.id)).toMatchObject({ ok: false, name: 'OVER_CAPTURE' })
    expect(pp.calls.filter(c => c.method === 'POST')).toHaveLength(1)
    await db.prepare('UPDATE tabs SET refunded_cents = 0').run()
    pp.setStatus('PENDING')
    expect(await approveBySeller(d, 'ws1', r.claim.id)).toMatchObject({ ok: true, claim: { state: 'REFUNDING' } })
    expect((await getTab(db, 'tab_1'))!.refunded_cents).toBe(25)
  })

  it('holds the reservation while pending and blocks another seller refund past the capture', async () => {
    const pp = fakePayPal()
    const d = deps(pp)
    await fileClaim(d, agent, 1, 'bad answer')
    await db.prepare('UPDATE tabs SET captured_cents = 40').run()
    const second = await fileClaim(d, agent, 2, 'also bad')
    expect(await approveBySeller(d, 'ws1', second.claim.id)).toMatchObject({ ok: false, name: 'OVER_CAPTURE' })
    expect(pp.calls.filter(c => c.method === 'POST')).toHaveLength(1)
  })

  it('reconciles only this workspace and claims a 30 second poll slot atomically', async () => {
    const pp = fakePayPal()
    await fileClaim(deps(pp), agent, 1, 'bad answer')
    await reconcileWorkspaceRefunds(db, pp as any, 'other', 100000)
    await Promise.all([reconcileWorkspaceRefunds(db, pp as any, 'ws1', 100000), reconcileWorkspaceRefunds(db, pp as any, 'ws1', 100000)])
    await reconcileWorkspaceRefunds(db, pp as any, 'ws1', 129999)
    expect(pp.calls.filter(c => c.method === 'GET')).toHaveLength(1)
    await reconcileWorkspaceRefunds(db, pp as any, 'ws1', 130000)
    expect(pp.calls.filter(c => c.method === 'GET')).toHaveLength(2)
  })
})
