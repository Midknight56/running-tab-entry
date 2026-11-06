import { expect, it } from 'vitest'
import { approveBySeller, fileClaim } from '../src/claims/claims'
import { makeClaimJudge } from '../src/claims/judge'
import { fakeD1 } from './helpers/d1'

const independentJudge = async () => ({ approve: true as const, reason_code: 'NONSENSE', evidence: '09:00', cited_seqs: [1] })

async function fixture(state = 'PAID', count = 2) {
  const db = fakeD1()
  const agent = { id: 'agt_1', ws_id: 'ws1', name: 'Agent' }
  await db.prepare(`INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, capture_id, captured_cents, created_at)
    VALUES ('tab_1', 'ws1', 'agt_1', ?, 500, 500, ?, ?, 1)`)
    .bind(state, state === 'PAID' ? 'CAP1' : null, state === 'PAID' ? 500 : 0).run()
  for (let seq = 1; seq <= count; seq++) await db.prepare(`INSERT INTO calls
    (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
    VALUES (?, ?, 'ws1', 'agt_1', 'tab_1', 'convert_time', '{"time":"09:00"}', '{}', 25, 'BILLABLE', ?)`)
    .bind(`call_${seq}`, seq, seq * 1000).run()
  const judge = makeClaimJudge({ ask: async () => ({ text: JSON.stringify({
    verdict: 'approve', claim_names: 'DUPLICATE', reason_code: 'DUPLICATE', evidence: '09:00', cited_call_ids: Array.from({ length: count }, (_, n) => n + 1),
  }) }) } as never)
  const requests: string[] = []
  const pp = { request: async (_m: string, _p: string, opts: { requestId?: string }) => {
    requests.push(opts.requestId!)
    return { status: 201, body: { id: `REF${requests.length}`, status: 'COMPLETED' } }
  } }
  return { db, agent, requests, d: { db, pp: pp as any, judge } }
}

it.each(['COMPLETED', 'PENDING', 'UNCERTAIN'])('reserves one duplicate charge across concurrent claims with a %s refund', async status => {
  const db = fakeD1()
  const agent = { id: 'agt_1', ws_id: 'ws1', name: 'Agent' }
  await db.prepare(`INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, capture_id, captured_cents, created_at)
    VALUES ('tab_1', 'ws1', 'agt_1', 'PAID', 500, 500, 'CAP1', 500, 1)`).run()
  for (const seq of [1, 2, 3]) await db.prepare(`INSERT INTO calls
    (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
    VALUES (?, ?, 'ws1', 'agt_1', 'tab_1', 'convert_time', ?, '{}', ?, 'BILLABLE', ?)`)
    .bind(`call_${seq}`, seq, seq === 3 ? '{"time":"12:00"}' : '{"time":"09:00"}', seq === 3 ? 450 : 25, seq * 1000).run()
  let release!: () => void
  const bothRead = new Promise<void>(resolve => { release = resolve })
  let reads = 0
  const judge = makeClaimJudge({ ask: async () => {
    if (++reads === 2) release()
    await bothRead
    return { text: JSON.stringify({ verdict: 'approve', claim_names: 'DUPLICATE', reason_code: 'DUPLICATE', evidence: '09:00', cited_call_ids: [1, 2] }) }
  } } as never)
  const requests: { id?: string; body?: any }[] = []
  const pp = { async request(_method: string, _path: string, opts: { requestId?: string; body?: unknown } = {}) {
    requests.push({ id: opts.requestId, body: opts.body })
    return status === 'UNCERTAIN'
      ? { status: 503, body: {}, bodyRead: false }
      : { status: 201, body: { id: `REF${requests.length}`, status } }
  } }
  const d = { db, pp: pp as any, judge }
  const results = await Promise.all([fileClaim(d, agent, 1, 'billed twice'), fileClaim(d, agent, 2, 'billed twice')])
  expect(requests).toHaveLength(1)
  expect(requests[0].body.amount).toEqual({ currency_code: 'USD', value: '0.25' })
  expect(await db.prepare('SELECT refunded_cents FROM tabs').first('refunded_cents')).toBe(25)
  expect(await db.prepare("SELECT COUNT(*) AS n FROM calls WHERE seq IN (1, 2) AND status = 'BILLABLE'").first<number>('n')).toBe(status === 'COMPLETED' ? 1 : 2)
  const blocked = results.find(r => r.claim.state === 'REJECTED')!
  expect(blocked).toBeDefined()
  expect(await approveBySeller(d, 'ws1', blocked.claim.id)).toMatchObject({ ok: false })
  expect(requests).toHaveLength(1)
  if (status === 'UNCERTAIN') {
    const winner = results.find(r => r.claim.state === 'REFUNDING')!
    await fileClaim({ ...d, pp: { request: async (_m: string, _p: string, opts: { requestId?: string }) => {
      expect(opts.requestId).toBe(requests[0].id)
      return { status: 201, body: { id: 'RECOVERED', status: 'COMPLETED' } }
    } } as any }, agent, winner.claim.call_id === 'call_1' ? 1 : 2, 'retry')
    expect(await db.prepare("SELECT COUNT(*) AS n FROM calls WHERE seq IN (1, 2) AND status = 'REFUNDED'").first<number>('n')).toBe(1)
    expect(await db.prepare('SELECT refunded_cents FROM tabs').first('refunded_cents')).toBe(25)
  }
})

it('allows two duplicate refunds among three copies and retains one charge', async () => {
  const { db, agent, requests, d } = await fixture('PAID', 3)
  await Promise.all([1, 2, 3].map(seq => fileClaim({ ...d }, agent, seq, 'billed twice')))
  expect(requests).toHaveLength(2)
  expect(await db.prepare("SELECT COUNT(*) AS n FROM calls WHERE status = 'BILLABLE'").first('n')).toBe(1)
  expect(await db.prepare('SELECT COUNT(*) AS n FROM duplicate_reservations').first('n')).toBe(2)
})

it.each(['OPEN', 'DUE'])('retains one charge when concurrent duplicate claims strike an unpaid %s tab', async state => {
  const { db, agent, requests, d } = await fixture(state)
  await Promise.all([1, 2].map(seq => fileClaim({ ...d }, agent, seq, 'billed twice')))
  expect(requests).toHaveLength(0)
  expect(await db.prepare("SELECT COUNT(*) AS n FROM calls WHERE status = 'BILLABLE'").first('n')).toBe(1)
  expect(await db.prepare('SELECT total_cents FROM tabs').first('total_cents')).toBe(475)
})

it('refunds a retained original for an independent claim within automatic limits', async () => {
  const { db, agent, requests, d } = await fixture()
  await fileClaim(d, agent, 2, 'billed twice')
  const original = await fileClaim({ ...d, judge: independentJudge }, agent, 1, 'bad answer')
  expect(original.claim).toMatchObject({ state: 'REFUNDED', reason_code: 'NONSENSE', refund_status: 'COMPLETED' })
  expect(requests).toHaveLength(2)
  expect(new Set(requests).size).toBe(2)
  expect(await db.prepare("SELECT status FROM calls WHERE id = 'call_1'").first('status')).toBe('REFUNDED')
  expect(await db.prepare('SELECT refunded_cents FROM tabs').first('refunded_cents')).toBe(50)
  expect(await db.prepare('SELECT COUNT(*) AS n FROM duplicate_reservations').first('n')).toBe(1)
  expect(await approveBySeller(d, 'ws1', original.claim.id)).toMatchObject({ ok: false, name: 'NOT_WAITING' })
  expect(requests).toHaveLength(2)
})

it('lets the seller refund a retained original when its independent claim exceeds the automatic share', async () => {
  const { db, agent, requests, d } = await fixture()
  await db.prepare('UPDATE tabs SET captured_cents = 200, total_cents = 200').run()
  await fileClaim(d, agent, 2, 'billed twice')
  const original = await fileClaim({ ...d, judge: independentJudge }, agent, 1, 'bad answer')
  expect(original.claim).toMatchObject({ state: 'WAITING_SELLER', refund_status: null })
  expect(original.message).toContain('refund waits for the seller')
  expect(requests).toHaveLength(1)
  expect(await db.prepare('SELECT refunded_cents FROM tabs').first('refunded_cents')).toBe(25)
  expect(await approveBySeller(d, 'ws1', original.claim.id)).toMatchObject({ ok: true, claim: { state: 'REFUNDED' } })
  expect(requests).toHaveLength(2)
  expect(await db.prepare('SELECT refunded_cents FROM tabs').first('refunded_cents')).toBe(50)
})

it.each(['OPEN', 'DUE'])('strikes a retained original for an independent claim before payment on an %s tab', async state => {
  const { db, agent, requests, d } = await fixture(state)
  await fileClaim(d, agent, 2, 'billed twice')
  const original = await fileClaim({ ...d, judge: independentJudge }, agent, 1, 'bad answer')
  expect(original.claim).toMatchObject({ state: 'APPROVED', refund_status: 'NOT_DUE' })
  expect(await db.prepare("SELECT COUNT(*) AS n FROM calls WHERE status = 'STRUCK'").first('n')).toBe(2)
  expect(await db.prepare('SELECT total_cents FROM tabs').first('total_cents')).toBe(450)
  expect(await approveBySeller(d, 'ws1', original.claim.id)).toMatchObject({ ok: false, name: 'NOT_WAITING' })
  expect(requests).toHaveLength(0)
})

it('keeps an uncertain independent refund on a retained original reserved until the same request is confirmed', async () => {
  const { db, agent, d } = await fixture()
  await fileClaim(d, agent, 2, 'billed twice')
  const requests: string[] = []
  const pp = { request: async (_method: string, _path: string, opts: { requestId?: string }) => {
    requests.push(opts.requestId!)
    if (requests.length === 1) return { status: 503, body: {}, bodyRead: false }
    if (requests.length === 2) return { status: 422, body: { name: 'UNPROCESSABLE_ENTITY' }, name: 'UNPROCESSABLE_ENTITY', bodyRead: true }
    return { status: 201, body: { id: 'REF_ORIGINAL', status: 'COMPLETED' } }
  } }
  const deps = { ...d, pp: pp as any, judge: independentJudge }
  for (let attempt = 1; attempt <= 2; attempt++) {
    const original = await fileClaim(deps, agent, 1, 'bad answer')
    expect(original.claim).toMatchObject({ state: 'REFUNDING', refund_status: 'RETRY_AUTO' })
    expect(await db.prepare('SELECT refunded_cents FROM tabs').first('refunded_cents')).toBe(50)
    expect(await db.prepare("SELECT status FROM calls WHERE id = 'call_1'").first('status')).toBe('BILLABLE')
  }
  const confirmed = await fileClaim(deps, agent, 1, 'bad answer')
  expect(confirmed.claim).toMatchObject({ state: 'REFUNDED', refund_status: 'COMPLETED' })
  expect(requests).toHaveLength(3)
  expect(new Set(requests).size).toBe(1)
  expect(await db.prepare('SELECT refunded_cents FROM tabs').first('refunded_cents')).toBe(50)
})

it.each(['PENDING', 'UNCERTAIN'])('allows an independent refund of the original while its duplicate refund is %s', async status => {
  const { db, agent, requests, d } = await fixture()
  const duplicate = await fileClaim({ ...d, pp: { request: async () => status === 'PENDING'
    ? { status: 201, body: { id: 'REF_DUPLICATE', status: 'PENDING' } }
    : { status: 503, body: {}, bodyRead: false } } as any }, agent, 2, 'billed twice')
  const original = await fileClaim({ ...d, judge: independentJudge }, agent, 1, 'bad answer')
  expect(original.claim).toMatchObject({ state: 'REFUNDED', refund_status: 'COMPLETED' })
  expect(await db.prepare('SELECT state, refund_status FROM claims WHERE id = ?').bind(duplicate.claim.id).first())
    .toEqual({ state: 'REFUNDING', refund_status: status === 'PENDING' ? 'PENDING' : 'RETRY_AUTO' })
  expect(requests).toHaveLength(1)
  expect(await db.prepare('SELECT refunded_cents FROM tabs').first('refunded_cents')).toBe(50)
})

it('does not retain a twin whose nonduplicate refund is already pending', async () => {
  const { db, agent, requests, d } = await fixture()
  await fileClaim({ ...d, pp: { request: async () => ({ status: 201, body: { id: 'PENDING', status: 'PENDING' } }) } as any,
    judge: async () => ({ approve: true as const, reason_code: 'NONSENSE', evidence: '09:00', cited_seqs: [1] }) }, agent, 1, 'bad answer')
  const second = await fileClaim(d, agent, 2, 'billed twice')
  expect(second.claim.state).toBe('REJECTED')
  expect(await approveBySeller({ ...d }, 'ws1', second.claim.id)).toMatchObject({ ok: false })
  expect(requests).toHaveLength(0)
  expect(await db.prepare('SELECT refunded_cents FROM tabs').first('refunded_cents')).toBe(25)
})
