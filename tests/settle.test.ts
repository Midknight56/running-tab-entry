import { beforeEach, describe, expect, it } from 'vitest'
import { completeReturn, payWithTestCard, SANDBOX_TEST_CARD, startPayment } from '../src/bill/settle'
import { fakeD1, type FakeD1 } from './helpers/d1'
import { reserveCall } from '../src/tab/ledger'

let db: FakeD1

/** A PayPal stand in that records each call and answers from a script. */
function fakePayPal(script: Record<string, (body: unknown) => { status: number; body: any; name?: string; bodyRead?: boolean } | Promise<{ status: number; body: any; name?: string; bodyRead?: boolean }>>) {
  const calls: { method: string; path: string; requestId?: string; body?: any }[] = []
  return {
    calls,
    async request(method: string, path: string, opts: { body?: unknown; requestId?: string } = {}) {
      calls.push({ method, path, requestId: opts.requestId, body: opts.body })
      const key = `${method} ${path.replace(/\/v2\/checkout\/orders\/[^/]+/, '/v2/checkout/orders/:id')}`
      const h = script[key]
      if (!h) throw new Error('unexpected ' + key)
      const r = await h(opts.body)
      return { status: r.status, body: r.body, bodyRead: r.bodyRead, name: r.name ?? r.body?.name, debugId: 'dbg' }
    },
  }
}

const ORDER_CREATED = {
  status: 201,
  body: { id: 'ORD1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'self', href: 'x' }, { rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORD1' }] },
}
const CAPTURED = {
  status: 201,
  body: { id: 'ORD1', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '0.75' } }] } }] },
}

async function seed(state: string) {
  await db.prepare(`INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, created_at)
    VALUES ('tab_1', 'ws1', 'agt_1', ?, 75, 50, 1)`).bind(state).run()
  const rows = [['c1', 1, 'convert_time', 25, 'BILLABLE'], ['c2', 2, 'convert_time', 25, 'BILLABLE'], ['c3', 3, 'business_days', 5, 'STRUCK'], ['c4', 4, 'convert_time', 25, 'BILLABLE']]
  for (const [id, seq, tool, price, status] of rows) {
    await db.prepare(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
      VALUES (?, ?, 'ws1', 'agt_1', 'tab_1', ?, '{}', '{}', ?, ?, 1)`).bind(id, seq, tool, price, status).run()
  }
}

const tab = () => db.prepare('SELECT state, order_id, capture_id, captured_cents FROM tabs').first<any>()

beforeEach(() => { db = fakeD1() })

describe('wallet refusal recovery', () => {
  it.each([400, 401, 403, 404, 422])('retires a readable first-send %s and allocates request id -2 on the next press', async status => {
    await seed('DUE')
    let sends = 0
    const pp = fakePayPal({ 'POST /v2/checkout/orders': () => ++sends === 1
      ? { status, body: { name: 'UNPROCESSABLE_ENTITY' }, bodyRead: true }
      : ORDER_CREATED })
    const d = { db, pp, origin: 'x' }
    expect(await startPayment(d, 'tab_1')).toMatchObject({ kind: 'refused', http: status })
    expect(await db.prepare("SELECT state, send_count FROM pay_attempts WHERE method = 'wallet'").first())
      .toEqual({ state: 'FAILED', send_count: 1 })
    expect(await startPayment(d, 'tab_1')).toMatchObject({ kind: 'redirect' })
    expect(pp.calls.map(c => c.requestId)).toEqual(['rt-order-tab_1', 'rt-order-tab_1-2'])
    expect((await db.prepare('SELECT attempt_no, state, send_count FROM pay_attempts ORDER BY attempt_no').all()).results)
      .toEqual([{ attempt_no: 1, state: 'FAILED', send_count: 1 }, { attempt_no: 2, state: 'DONE', send_count: 1 }])
  })

  it.each([
    { status: 408 }, { status: 409 }, { status: 429 }, { status: 500 }, { status: 503 },
    { status: 422, bodyRead: false }, { status: 422, uncertainSend: true },
    { status: 402 },
  ])('keeps an unresolved first response $status (bodyRead=$bodyRead, uncertainSend=$uncertainSend) for replay', async answer => {
    await seed('DUE')
    const requests: { requestId?: string; body?: unknown }[] = []
    const pp = { async request(_method: string, _path: string, opts: { requestId?: string; body?: unknown } = {}) {
      requests.push(opts)
      // The counter must be durable before PayPal receives the request.
      expect(await db.prepare('SELECT send_count FROM pay_attempts').first('send_count')).toBe(requests.length)
      return { ...answer, body: { name: 'REFUSED' } }
    } }
    const d = { db, pp: pp as any, origin: 'x' }
    for (let press = 1; press <= 2; press++) {
      expect(await startPayment(d, 'tab_1')).toMatchObject({ kind: 'refused', http: answer.status })
      expect(await db.prepare('SELECT state, send_count FROM pay_attempts').first()).toEqual({ state: 'SENT', send_count: press })
    }
    expect(requests.map(r => r.requestId)).toEqual(['rt-order-tab_1', 'rt-order-tab_1'])
    expect(requests[1].body).toEqual(requests[0].body)
    expect(await db.prepare('SELECT wallet_attempt FROM tabs').first('wallet_attempt')).toBe(1)
  })

  it('keeps a late first-send refusal unresolved when a replay has already started', async () => {
    await seed('DUE')
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    let sends = 0
    const pp = fakePayPal({ 'POST /v2/checkout/orders': async () => {
      if (++sends === 1) {
        entered()
        await held
        return { status: 422, body: { name: 'UNPROCESSABLE_ENTITY' }, bodyRead: true }
      }
      return { status: 429, body: { name: 'RATE_LIMIT_REACHED' }, bodyRead: true }
    } })
    const d = { db, pp, origin: 'x' }
    const late = startPayment(d, 'tab_1')
    await started
    try {
      expect(await startPayment(d, 'tab_1')).toMatchObject({ kind: 'refused', http: 429 })
    } finally { release() }
    expect(await late).toMatchObject({ kind: 'refused', http: 422 })
    expect(await db.prepare('SELECT state, send_count FROM pay_attempts').first()).toEqual({ state: 'SENT', send_count: 2 })
    expect(pp.calls.map(c => c.requestId)).toEqual(['rt-order-tab_1', 'rt-order-tab_1'])
  })

  it('keeps a lost first response unresolved after a readable 422 replay', async () => {
    await seed('DUE')
    let sends = 0
    const pp = fakePayPal({ 'POST /v2/checkout/orders': () => {
      if (++sends === 1) throw new Error('lost wallet response')
      return { status: 422, body: { name: 'UNPROCESSABLE_ENTITY' }, bodyRead: true }
    } })
    const d = { db, pp, origin: 'x' }
    await expect(startPayment(d, 'tab_1')).rejects.toThrow('lost wallet response')
    expect(await db.prepare('SELECT state, send_count FROM pay_attempts').first()).toEqual({ state: 'SENT', send_count: 1 })
    expect(await startPayment(d, 'tab_1')).toMatchObject({ kind: 'refused', http: 422 })
    expect(await db.prepare('SELECT state, send_count FROM pay_attempts').first()).toEqual({ state: 'SENT', send_count: 2 })
    expect(pp.calls.map(c => c.requestId)).toEqual(['rt-order-tab_1', 'rt-order-tab_1'])
    expect(pp.calls[1].body).toEqual(pp.calls[0].body)
  })
})

describe('card attempt recovery', () => {
  it('keeps an outstanding card replay unresolved after an earlier refusal and blocks wallet checkout', async () => {
    await seed('DUE')
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    let enteredFirst!: () => void
    let enteredSecond!: () => void
    const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve })
    const secondHeld = new Promise<void>(resolve => { releaseSecond = resolve })
    const firstStarted = new Promise<void>(resolve => { enteredFirst = resolve })
    const secondStarted = new Promise<void>(resolve => { enteredSecond = resolve })
    let sends = 0
    const pp = fakePayPal({ 'POST /v2/checkout/orders': async (body: any) => {
      if (!body.payment_source.card) return ORDER_CREATED
      const send = ++sends
      if (send === 1) { enteredFirst(); await firstHeld }
      if (send === 2) { enteredSecond(); await secondHeld }
      return send === 1
        ? { status: 422, body: { name: 'UNPROCESSABLE_ENTITY' }, bodyRead: true }
        : { status: 429, body: { name: 'RATE_LIMIT_REACHED' }, bodyRead: true }
    } })
    let now = 1000
    const d = { db, pp, origin: 'x', now: () => now }
    const first = payWithTestCard(d, 'tab_1', 'https://api-m.sandbox.paypal.com')
    await firstStarted
    const second = payWithTestCard(d, 'tab_1', 'https://api-m.sandbox.paypal.com')
    await secondStarted
    try {
      releaseFirst()
      expect(await first).toMatchObject({ kind: 'refused', reason: 'A card payment for this tab is being checked. Try again in a minute.', http: 409 })
      expect.soft(await db.prepare("SELECT state, send_count FROM pay_attempts WHERE method = 'card'").first())
        .toEqual({ state: 'SENT', send_count: 2 })
      now = 121001
      expect.soft(await startPayment(d, 'tab_1')).toMatchObject({ kind: 'refused', http: 429 })
      expect.soft(pp.calls.every(c => c.requestId === 'rt-order-tab_1-card' && c.body.payment_source.card)).toBe(true)
    } finally {
      releaseSecond()
      await Promise.all([first, second])
    }
    expect(await db.prepare("SELECT state FROM pay_attempts WHERE method = 'card'").first('state')).toBe('SENT')
  })

  it('keeps the ordinary readable first-send refusal message when no replay exists', async () => {
    await seed('DUE')
    const pp = fakePayPal({ 'POST /v2/checkout/orders': body => (body as any).payment_source.card
      ? { status: 422, body: { name: 'UNPROCESSABLE_ENTITY' }, bodyRead: true }
      : ORDER_CREATED })
    const result = await payWithTestCard({ db, pp, origin: 'x' }, 'tab_1', 'https://api-m.sandbox.paypal.com')
    expect(result).toMatchObject({ kind: 'refused', reason: 'Payment did not go through. The tab is still open.', http: 422 })
    expect(await db.prepare("SELECT state, send_count FROM pay_attempts WHERE method = 'card'").first())
      .toEqual({ state: 'FAILED', send_count: 1 })
  })

  it.each([429, 409, 422])('keeps a lost card response unresolved after a readable %s replay', async status => {
    await seed('DUE')
    let posts = 0
    const pp = fakePayPal({ 'POST /v2/checkout/orders': body => {
      if (!(body as any).payment_source.card) return ORDER_CREATED
      if (++posts === 1) throw new Error('lost answer after capture')
      if (posts === 2) return { status, body: { name: status === 429 ? 'RATE_LIMIT_REACHED' : 'UNPROCESSABLE_ENTITY' } }
      return CAPTURED
    } })
    const d = { db, pp: pp as any, origin: 'x' }
    await payWithTestCard(d, 'tab_1', 'https://api-m.sandbox.paypal.com')
    await startPayment(d, 'tab_1')
    expect(await db.prepare('SELECT state FROM pay_attempts WHERE method = \'card\'').first('state')).toBe('SENT')
    expect(pp.calls).toHaveLength(2)
    expect(pp.calls.every(c => c.requestId === 'rt-order-tab_1-card' && c.body.payment_source.card)).toBe(true)
    expect(pp.calls[1].body).toEqual(pp.calls[0].body)
    expect(await startPayment(d, 'tab_1')).toEqual({ kind: 'paid', tab_id: 'tab_1' })
  })

  it('replays the exact request body even if a later seal changes the bill metadata', async () => {
    await seed('DUE')
    let posts = 0
    const pp = fakePayPal({ 'POST /v2/checkout/orders': () => {
      if (++posts === 1) throw new Error('lost answer after capture')
      return CAPTURED
    } })
    const d = { db, pp: pp as any, origin: 'x' }
    await payWithTestCard(d, 'tab_1', 'https://api-m.sandbox.paypal.com').catch(() => undefined)
    await db.prepare("UPDATE calls SET chain_hash = 'later_seal' WHERE id = 'c4'").run()
    expect(await startPayment(d, 'tab_1')).toMatchObject({ kind: 'paid' })
    expect(pp.calls[1].body).toEqual(pp.calls[0].body)
  })

  it('recovers a captured card answer before a wallet start without creating another order', async () => {
    await seed('DUE')
    let cardPosts = 0
    let noteCalls = 0
    const pp = fakePayPal({ 'POST /v2/checkout/orders': body => {
      if (!(body as any).payment_source.card) return ORDER_CREATED
      cardPosts++
      if (cardPosts === 1) throw new Error('lost answer after capture')
      return CAPTURED
    } })
    const d = { db, pp: pp as any, origin: 'x', note: async () => `Statement ${++noteCalls}` }
    await payWithTestCard(d, 'tab_1', 'https://api-m.sandbox.paypal.com').catch(() => undefined)
    expect(await startPayment(d, 'tab_1')).toEqual({ kind: 'paid', tab_id: 'tab_1' })
    expect(pp.calls).toHaveLength(2)
    expect(pp.calls.map(c => c.requestId)).toEqual(['rt-order-tab_1-card', 'rt-order-tab_1-card'])
    expect(pp.calls[1].body).toEqual(pp.calls[0].body)
    expect(noteCalls).toBe(1)
    expect(await tab()).toEqual({ state: 'PAID', order_id: 'ORD1', capture_id: 'CAP1', captured_cents: 75 })
    expect(await db.prepare('SELECT method, capture_id, status FROM payments').all()).toMatchObject({ results: [{ method: 'card', capture_id: 'CAP1', status: 'COMPLETED' }] })
    expect(await db.prepare('SELECT state, order_id FROM pay_attempts').first()).toEqual({ state: 'DONE', order_id: 'ORD1' })
  })

  it('keeps a second lost answer pending and blocks wallet takeover after 120 seconds', async () => {
    await seed('DUE')
    const pp = fakePayPal({ 'POST /v2/checkout/orders': body => {
      if (!(body as any).payment_source.card) return ORDER_CREATED
      throw new Error('lost answer after capture')
    } })
    const d = { db, pp: pp as any, origin: 'x', now: () => 1 }
    await payWithTestCard(d, 'tab_1', 'https://api-m.sandbox.paypal.com').catch(() => undefined)
    expect(await startPayment({ ...d, now: () => 120002 }, 'tab_1')).toEqual({
      kind: 'refused', http: 409, reason: 'A card payment for this tab is being checked. Try again in a minute.',
    })
    expect(pp.calls).toHaveLength(2)
    expect(pp.calls.every(c => c.requestId === 'rt-order-tab_1-card' && c.body.payment_source.card)).toBe(true)
    expect(pp.calls[1].body).toEqual(pp.calls[0].body)
    expect(await db.prepare('SELECT state, order_id FROM pay_attempts').first()).toEqual({ state: 'SENT', order_id: null })
    expect(await db.prepare('SELECT COUNT(*) AS n FROM payments').first('n')).toBe(0)
    expect((await tab()).order_id).toBeNull()
  })

  it('lets the wallet go on after PayPal refuses the card with 422', async () => {
    await seed('DUE')
    const pp = fakePayPal({ 'POST /v2/checkout/orders': body => (body as any).payment_source.card
      ? { status: 422, body: { name: 'UNPROCESSABLE_ENTITY' } }
      : ORDER_CREATED })
    const d = { db, pp: pp as any, origin: 'x' }
    expect(await payWithTestCard(d, 'tab_1', 'https://api-m.sandbox.paypal.com')).toMatchObject({ kind: 'refused', http: 422 })
    expect(await startPayment(d, 'tab_1')).toMatchObject({ kind: 'redirect' })
    expect(pp.calls.map(c => c.requestId)).toEqual(['rt-order-tab_1-card', 'rt-order-tab_1'])
    expect(await db.prepare('SELECT state FROM pay_attempts').first('state')).toBe('FAILED')
  })

  it.each(['return', 'card'])('recovers the card before the %s route can pay again', async route => {
    await seed('DUE')
    let posts = 0
    const pp = fakePayPal({ 'POST /v2/checkout/orders': () => {
      if (++posts === 1) throw new Error('lost answer after capture')
      return CAPTURED
    } })
    const d = { db, pp: pp as any, origin: 'x' }
    await payWithTestCard(d, 'tab_1', 'https://api-m.sandbox.paypal.com').catch(() => undefined)
    if (route === 'return') await db.prepare("UPDATE tabs SET order_id = 'WALLET1'").run()
    const result = route === 'return' ? await completeReturn(d, 'WALLET1') : await payWithTestCard(d, 'tab_1', 'https://api-m.sandbox.paypal.com')
    expect(result).toMatchObject({ kind: 'paid', tab_id: 'tab_1' })
    expect(pp.calls.map(c => c.requestId)).toEqual(['rt-order-tab_1-card', 'rt-order-tab_1-card'])
    expect(pp.calls[1].body).toEqual(pp.calls[0].body)
    expect(await db.prepare('SELECT state FROM pay_attempts').first('state')).toBe('DONE')
    expect(await db.prepare('SELECT COUNT(*) AS n FROM payments').first('n')).toBe(1)
  })

  it.each(['return', 'card'])('blocks the %s route after another lost answer', async route => {
    await seed('DUE')
    const pp = fakePayPal({ 'POST /v2/checkout/orders': () => { throw new Error('lost answer') } })
    const d = { db, pp: pp as any, origin: 'x' }
    await payWithTestCard(d, 'tab_1', 'https://api-m.sandbox.paypal.com').catch(() => undefined)
    if (route === 'return') await db.prepare("UPDATE tabs SET order_id = 'WALLET1'").run()
    const result = route === 'return' ? await completeReturn(d, 'WALLET1') : await payWithTestCard(d, 'tab_1', 'https://api-m.sandbox.paypal.com')
    expect(result).toMatchObject({ kind: route === 'return' ? 'failed' : 'refused', http: 409, reason: 'A card payment for this tab is being checked. Try again in a minute.' })
    expect(pp.calls.map(c => c.requestId)).toEqual(['rt-order-tab_1-card', 'rt-order-tab_1-card'])
    expect(await db.prepare('SELECT state FROM pay_attempts').first('state')).toBe('SENT')
  })

  it('continues the wallet route when recovery returns a terminal declined capture', async () => {
    await seed('DUE')
    let posts = 0
    const pp = fakePayPal({ 'POST /v2/checkout/orders': body => {
      if (!(body as any).payment_source.card) return ORDER_CREATED
      if (++posts === 1) throw new Error('lost refusal')
      return { status: 201, body: { ...CAPTURED.body, purchase_units: [{ payments: { captures: [{ ...CAPTURED.body.purchase_units[0].payments.captures[0], status: 'DECLINED' }] } }] } }
    } })
    const d = { db, pp: pp as any, origin: 'x' }
    await payWithTestCard(d, 'tab_1', 'https://api-m.sandbox.paypal.com').catch(() => undefined)
    expect(await startPayment(d, 'tab_1')).toMatchObject({ kind: 'redirect' })
    expect(pp.calls.map(c => c.requestId)).toEqual(['rt-order-tab_1-card', 'rt-order-tab_1-card', 'rt-order-tab_1'])
    expect(await db.prepare('SELECT state FROM pay_attempts').first('state')).toBe('FAILED')
  })

  it.each([
    ['unreadable answer', { status: 201, body: {} }],
    ['unreadable refusal', { status: 422, body: {}, bodyRead: false }],
    ['server error', { status: 503, body: { name: 'INTERNAL_SERVER_ERROR' } }],
  ])('keeps the attempt SENT after an %s', async (_label, answer) => {
    await seed('DUE')
    const pp = fakePayPal({ 'POST /v2/checkout/orders': body => (body as any).payment_source.card ? answer : ORDER_CREATED })
    const d = { db, pp: pp as any, origin: 'x' }
    expect(await payWithTestCard(d, 'tab_1', 'https://api-m.sandbox.paypal.com')).toMatchObject({ kind: 'refused', http: 409 })
    expect(await startPayment(d, 'tab_1')).toMatchObject({ kind: 'refused', http: 409 })
    expect(pp.calls.every(c => c.requestId === 'rt-order-tab_1-card')).toBe(true)
    expect(await db.prepare('SELECT state FROM pay_attempts').first('state')).toBe('SENT')
  })

  it('keeps a PENDING card capture unresolved and blocks wallet checkout', async () => {
    await seed('DUE')
    const pending = { ...CAPTURED.body, purchase_units: [{ payments: { captures: [{ ...CAPTURED.body.purchase_units[0].payments.captures[0], status: 'PENDING' }] } }] }
    const pp = fakePayPal({
      'POST /v2/checkout/orders': body => (body as any).payment_source.card ? { status: 201, body: pending } : ORDER_CREATED,
      'GET /v2/checkout/orders/:id': () => ({ status: 200, body: pending }),
    })
    const d = { db, pp: pp as any, origin: 'x' }
    expect(await payWithTestCard(d, 'tab_1', 'https://api-m.sandbox.paypal.com')).toMatchObject({ kind: 'refused', http: 409 })
    expect(await db.prepare('SELECT state, order_id FROM pay_attempts').first()).toEqual({ state: 'SENT', order_id: 'ORD1' })
    expect(await tab()).toMatchObject({ state: 'DUE', order_id: 'ORD1', capture_id: 'CAP1', captured_cents: 0 })
    expect(await startPayment({ ...d, now: () => 999999 }, 'tab_1')).toMatchObject({ kind: 'refused', http: 409 })
    expect(pp.calls.filter(c => c.method === 'POST')).toHaveLength(1)
    expect(await db.prepare('SELECT state FROM pay_attempts').first('state')).toBe('SENT')
  })

  it.each(['COMPLETED', 'DECLINED', 'FAILED'])('resolves a PENDING card capture when a later read shows %s', async status => {
    await seed('DUE')
    const order = (state: string) => ({ ...CAPTURED.body, purchase_units: [{ payments: { captures: [{ ...CAPTURED.body.purchase_units[0].payments.captures[0], status: state }] } }] })
    const pp = fakePayPal({
      'POST /v2/checkout/orders': body => (body as any).payment_source.card ? { status: 201, body: order('PENDING') } : ORDER_CREATED,
      'GET /v2/checkout/orders/:id': () => ({ status: 200, body: order(status) }),
    })
    const d = { db, pp: pp as any, origin: 'x' }
    await payWithTestCard(d, 'tab_1', 'https://api-m.sandbox.paypal.com')
    expect(await startPayment(d, 'tab_1')).toMatchObject({ kind: status === 'COMPLETED' ? 'paid' : 'redirect' })
    expect(await db.prepare('SELECT state FROM pay_attempts').first('state')).toBe(status === 'COMPLETED' ? 'DONE' : 'FAILED')
    expect(pp.calls.filter(c => c.method === 'POST' && c.body?.payment_source.card)).toHaveLength(1)
    expect(pp.calls.filter(c => c.method === 'GET')).toHaveLength(1)
  })

  it.each(['DECLINED', 'FAILED'])('marks a clear %s capture FAILED and lets the wallet go on', async status => {
    await seed('DUE')
    const pp = fakePayPal({ 'POST /v2/checkout/orders': body => (body as any).payment_source.card
      ? { status: 201, body: { ...CAPTURED.body, purchase_units: [{ payments: { captures: [{ ...CAPTURED.body.purchase_units[0].payments.captures[0], status }] } }] } }
      : ORDER_CREATED })
    const d = { db, pp: pp as any, origin: 'x' }
    expect(await payWithTestCard(d, 'tab_1', 'https://api-m.sandbox.paypal.com')).toMatchObject({ kind: 'refused', name: status })
    expect(await startPayment(d, 'tab_1')).toMatchObject({ kind: 'redirect' })
    expect(await db.prepare('SELECT state, order_id FROM pay_attempts').first()).toEqual({ state: 'FAILED', order_id: 'ORD1' })
  })
})

describe('settlement ownership', () => {
  it('refuses the card while a wallet capture is paused', async () => {
    await seed('DUE')
    await db.prepare("UPDATE tabs SET order_id = 'ORD1'").run()
    let release!: () => void
    let entered!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const pp = fakePayPal({
      'POST /v2/checkout/orders/:id/capture': async () => { entered(); await paused; return CAPTURED },
      'POST /v2/checkout/orders': () => CAPTURED,
      'GET /v2/checkout/orders/:id': () => ({ status: 200, body: { status: 'CREATED' } }),
    })
    const d = { db, pp: pp as any, origin: 'https://rt.example', now: () => 200000 }
    const wallet = completeReturn(d, 'ORD1')
    await started
    let card
    try { card = await payWithTestCard(d, 'tab_1', 'https://api-m.sandbox.paypal.com') }
    finally { release() }
    await wallet
    expect(card).toMatchObject({ kind: 'refused', http: 409, reason: 'A payment for this tab is already in progress. Try again in a minute.' })
    expect(pp.calls.filter(c => c.method === 'POST')).toHaveLength(1)
    expect(await db.prepare('SELECT method, capture_id, amount_cents, status FROM payments').first()).toEqual({ method: 'wallet', capture_id: 'CAP1', amount_cents: 75, status: 'COMPLETED' })
    expect(await db.prepare('SELECT pay_method FROM tabs').first('pay_method')).toBeNull()
  })

  it('lets the card take a wallet lock older than 120 seconds', async () => {
    await seed('DUE')
    await db.prepare("UPDATE tabs SET pay_method = 'wallet', pay_started_at = 1").run()
    const pp = fakePayPal({ 'POST /v2/checkout/orders': () => CAPTURED })
    expect(await payWithTestCard({ db, pp: pp as any, origin: 'x', now: () => 120002 }, 'tab_1', 'https://api-m.sandbox.paypal.com')).toMatchObject({ kind: 'paid' })
    expect(await db.prepare('SELECT method FROM payments').first('method')).toBe('card')
  })

  it.each(['APPROVED', 'COMPLETED'])('uses a wallet order that is %s before creating any card order', async status => {
    await seed('DUE')
    await db.prepare("UPDATE tabs SET order_id = 'ORD1'").run()
    const pp = fakePayPal({
      'GET /v2/checkout/orders/:id': () => ({ status: 200, body: status === 'COMPLETED' ? CAPTURED.body : { status } }),
      'POST /v2/checkout/orders/:id/capture': () => CAPTURED,
      'POST /v2/checkout/orders': () => CAPTURED,
    })
    expect(await payWithTestCard({ db, pp: pp as any, origin: 'x' }, 'tab_1', 'https://api-m.sandbox.paypal.com')).toMatchObject({ kind: 'paid' })
    expect(pp.calls[0].method).toBe('GET')
    expect(pp.calls.filter(c => c.path === '/v2/checkout/orders')).toHaveLength(0)
    expect(pp.calls.filter(c => c.path.endsWith('/capture'))).toHaveLength(status === 'COMPLETED' ? 0 : 1)
  })

  it('releases its lock when capture throws', async () => {
    await seed('DUE')
    await db.prepare("UPDATE tabs SET order_id = 'ORD1'").run()
    const pp = fakePayPal({ 'POST /v2/checkout/orders/:id/capture': () => { throw new Error('lost answer') } })
    await expect(completeReturn({ db, pp: pp as any, origin: 'x' }, 'ORD1')).rejects.toThrow('lost answer')
    expect(await db.prepare('SELECT pay_method FROM tabs').first('pay_method')).toBeNull()
  })

  it('does not release a newer lock held by the other method', async () => {
    await seed('DUE')
    await db.prepare("UPDATE tabs SET order_id = 'ORD1'").run()
    let release!: () => void
    let entered!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const pp = fakePayPal({ 'POST /v2/checkout/orders/:id/capture': async () => { entered(); await paused; return CAPTURED } })
    const wallet = completeReturn({ db, pp: pp as any, origin: 'x', now: () => 1 }, 'ORD1')
    await started
    await db.prepare("UPDATE tabs SET pay_method = 'card', pay_started_at = 120002").run()
    release()
    await wallet
    expect(await db.prepare('SELECT pay_method FROM tabs').first('pay_method')).toBe('card')
  })

  it('refuses a wallet return while a fresh card lock is held', async () => {
    await seed('DUE')
    await db.prepare("UPDATE tabs SET order_id = 'ORD1', pay_method = 'card', pay_started_at = 1000").run()
    const pp = fakePayPal({})
    expect(await completeReturn({ db, pp: pp as any, origin: 'x', now: () => 121000 }, 'ORD1')).toMatchObject({ kind: 'failed', http: 409, reason: 'A payment for this tab is already in progress. Try again in a minute.' })
    expect(pp.calls).toHaveLength(0)
  })
})

describe('settling a tab', () => {
  it.each(['lost answer', 'unreadable answer'])('recovers a wallet %s with its saved body and request id through a rate limit', async failure => {
    await seed('DUE')
    let sends = 0
    let notes = 0
    const pp = fakePayPal({ 'POST /v2/checkout/orders': () => {
      if (++sends === 1) {
        if (failure === 'lost answer') throw new Error('lost answer')
        return { ...ORDER_CREATED, bodyRead: false }
      }
      return sends === 2 ? { status: 429, body: { name: 'RATE_LIMIT_REACHED' } } : ORDER_CREATED
    } })
    const d = { db, pp: pp as any, origin: 'x', note: async () => `Note ${++notes}` }
    await startPayment(d, 'tab_1').catch(() => undefined)
    await db.prepare("UPDATE calls SET chain_hash = 'changed' WHERE id = 'c4'").run()
    expect(await startPayment({ ...d }, 'tab_1')).toMatchObject({ kind: 'refused', http: 429 })
    expect(await db.prepare("SELECT state, attempt_no FROM pay_attempts WHERE method = 'wallet'").first()).toEqual({ state: 'SENT', attempt_no: 1 })
    expect(await payWithTestCard({ ...d }, 'tab_1', 'https://api-m.sandbox.paypal.com')).toMatchObject({ kind: 'redirect', order_id: 'ORD1' })
    expect(pp.calls.map(c => c.requestId)).toEqual(Array(3).fill('rt-order-tab_1'))
    expect(pp.calls.every(c => JSON.stringify(c.body) === JSON.stringify(pp.calls[0].body))).toBe(true)
    expect(notes).toBe(1)
    expect(await db.prepare('SELECT wallet_attempt FROM tabs').first('wallet_attempt')).toBe(1)
  })

  it('recovers an uncertain replacement before reading its old voided order or allocating another id', async () => {
    await seed('DUE')
    await db.prepare("UPDATE tabs SET order_id = 'OLD'").run()
    let sends = 0
    let counted = 0
    const pp = fakePayPal({
      'GET /v2/checkout/orders/:id': () => ({ status: 200, body: { id: 'OLD', status: 'VOIDED' } }),
      'POST /v2/checkout/orders': () => {
        if (++sends === 1) throw new Error('lost replacement')
        return ORDER_CREATED
      },
    })
    const d = { db, pp: pp as any, origin: 'x', beforeOrder: async () => { counted++; return null } }
    await expect(startPayment(d, 'tab_1')).rejects.toThrow('lost replacement')
    expect(await startPayment({ ...d }, 'tab_1')).toMatchObject({ kind: 'redirect', order_id: 'ORD1' })
    expect(pp.calls.filter(c => c.method === 'GET')).toHaveLength(1)
    const posts = pp.calls.filter(c => c.method === 'POST')
    expect(posts.map(c => c.requestId)).toEqual(['rt-order-tab_1-2', 'rt-order-tab_1-2'])
    expect(posts[1].body).toEqual(posts[0].body)
    expect(counted).toBe(1)
    expect(await db.prepare('SELECT wallet_attempt FROM tabs').first('wallet_attempt')).toBe(2)
  })

  it('concurrent wallet starts share one durable number and body', async () => {
    await seed('DUE')
    let notes = 0
    let release!: () => void
    const both = new Promise<void>(resolve => { release = resolve })
    const pp = fakePayPal({ 'POST /v2/checkout/orders': () => ORDER_CREATED })
    const d = { db, pp: pp as any, origin: 'x', note: async () => {
      const n = ++notes
      if (n === 2) release()
      await both
      return `Note ${n}`
    } }
    const results = await Promise.all([startPayment({ ...d }, 'tab_1'), startPayment({ ...d }, 'tab_1')])
    expect(results.every(r => r.kind === 'redirect')).toBe(true)
    expect(pp.calls.map(c => c.requestId)).toEqual(['rt-order-tab_1', 'rt-order-tab_1'])
    expect(pp.calls[1].body).toEqual(pp.calls[0].body)
    expect(await db.prepare('SELECT COUNT(*) AS n FROM pay_attempts').first('n')).toBe(1)
    expect(await db.prepare('SELECT wallet_attempt FROM tabs').first('wallet_attempt')).toBe(1)
  })

  it('does not let a late wallet replay overwrite a newer replacement order', async () => {
    await seed('DUE')
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    let sends = 0
    const pp = fakePayPal({
      'POST /v2/checkout/orders': async () => {
        if (++sends === 1) { entered(); await held; return ORDER_CREATED }
        if (sends === 2) return ORDER_CREATED
        return { status: 201, body: { id: 'ORD2', status: 'CREATED', links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORD2' }] } }
      },
      'GET /v2/checkout/orders/:id': () => ({ status: 200, body: { id: 'ORD1', status: 'VOIDED' } }),
    })
    const d = { db, pp: pp as any, origin: 'x' }
    const late = startPayment(d, 'tab_1')
    await started
    try {
      expect(await startPayment({ ...d }, 'tab_1')).toMatchObject({ kind: 'redirect', order_id: 'ORD1' })
      expect(await startPayment({ ...d }, 'tab_1')).toMatchObject({ kind: 'redirect', order_id: 'ORD2' })
    } finally { release() }
    await late
    expect((await tab()).order_id).toBe('ORD2')
  })

  it('gives three wallet orders distinct durable request ids after two verified voids', async () => {
    await seed('DUE')
    const keys: string[] = []
    const orders = new Map<string, { id: string; status: string }>()
    const pp = { async request(method: string, path: string, opts: { requestId?: string } = {}) {
      let order
      if (method === 'POST') {
        keys.push(opts.requestId!)
        if (!orders.has(opts.requestId!)) orders.set(opts.requestId!, { id: `ORD${orders.size + 1}`, status: 'CREATED' })
        order = orders.get(opts.requestId!)!
      } else order = [...orders.values()].find(o => path.endsWith(`/${o.id}`))!
      return { status: method === 'POST' ? 201 : 200, body: { ...order,
        links: order.status === 'CREATED' ? [{ rel: 'approve', href: `https://www.sandbox.paypal.com/checkoutnow?token=${order.id}` }] : [],
      } }
    } }
    const d = { db, pp: pp as any, origin: 'x' }
    expect(await startPayment(d, 'tab_1')).toMatchObject({ kind: 'redirect', order_id: 'ORD1' })
    orders.get('rt-order-tab_1')!.status = 'VOIDED'
    expect(await startPayment({ ...d }, 'tab_1')).toMatchObject({ kind: 'redirect', order_id: 'ORD2' })
    orders.get('rt-order-tab_1-2')!.status = 'VOIDED'
    const third = await startPayment({ ...d }, 'tab_1')
    expect(keys).toEqual(['rt-order-tab_1', 'rt-order-tab_1-2', 'rt-order-tab_1-3'])
    expect(third).toMatchObject({ kind: 'redirect', order_id: 'ORD3' })
    expect((await tab()).order_id).toBe('ORD3')
  })

  it('replaces a gone wallet order after a readable 404 RESOURCE_NOT_FOUND', async () => {
    await seed('DUE')
    await db.prepare("UPDATE tabs SET order_id = 'EXISTING'").run()
    const pp = fakePayPal({
      'GET /v2/checkout/orders/:id': () => ({ status: 404, body: { name: 'RESOURCE_NOT_FOUND' }, bodyRead: true }),
      'POST /v2/checkout/orders': () => ORDER_CREATED,
    })
    expect(await startPayment({ db, pp: pp as any, origin: 'x' }, 'tab_1')).toMatchObject({ kind: 'redirect', order_id: 'ORD1', url: ORDER_CREATED.body.links[1].href })
    expect(pp.calls.map(c => c.method)).toEqual(['GET', 'POST'])
    expect(pp.calls[1].requestId).toBe('rt-order-tab_1-2')
    expect((await tab()).order_id).toBe('ORD1')
  })

  it.each(['DECLINED', 'FAILED'])('replaces a COMPLETED wallet order with a %s capture', async status => {
    await seed('DUE')
    await db.prepare("UPDATE tabs SET order_id = 'EXISTING'").run()
    const pp = fakePayPal({
      'GET /v2/checkout/orders/:id': () => ({ status: 200, bodyRead: true, body: { ...CAPTURED.body, purchase_units: [{ payments: { captures: [{ ...CAPTURED.body.purchase_units[0].payments.captures[0], status }] } }] } }),
      'POST /v2/checkout/orders': () => ORDER_CREATED,
    })
    expect(await startPayment({ db, pp: pp as any, origin: 'x' }, 'tab_1')).toMatchObject({ kind: 'redirect', order_id: 'ORD1' })
    expect(pp.calls.map(c => c.method)).toEqual(['GET', 'POST'])
    expect((await tab()).order_id).toBe('ORD1')
    expect((await tab()).state).toBe('DUE')
  })

  it.each([
    ['unreadable gone order', { status: 404, body: { name: 'RESOURCE_NOT_FOUND' }, bodyRead: false }],
    ['different 404', { status: 404, body: { name: 'OTHER_ERROR' }, bodyRead: true }],
    ['rate limit', { status: 429, body: { status: 'VOIDED' }, bodyRead: true }],
    ['unreadable void', { status: 200, body: { status: 'VOIDED' }, bodyRead: false }],
    ['pending capture', { status: 200, body: { ...CAPTURED.body, purchase_units: [{ payments: { captures: [{ ...CAPTURED.body.purchase_units[0].payments.captures[0], status: 'PENDING' }] } }] } }],
  ])('keeps the stored wallet order after %s', async (_label, answer) => {
    await seed('DUE')
    await db.prepare("UPDATE tabs SET order_id = 'EXISTING'").run()
    const pp = fakePayPal({
      'GET /v2/checkout/orders/:id': () => answer,
      'POST /v2/checkout/orders': () => ORDER_CREATED,
    })
    expect(await startPayment({ db, pp: pp as any, origin: 'x' }, 'tab_1')).toMatchObject({ kind: 'refused' })
    expect(pp.calls.map(c => c.method)).toEqual(['GET'])
    expect((await tab()).order_id).toBe('EXISTING')
  })

  it('keeps the stored wallet order after a network error', async () => {
    await seed('DUE')
    await db.prepare("UPDATE tabs SET order_id = 'EXISTING'").run()
    const pp = fakePayPal({ 'GET /v2/checkout/orders/:id': () => { throw new Error('network error') } })
    expect(await startPayment({ db, pp: pp as any, origin: 'x' }, 'tab_1')).toMatchObject({ kind: 'refused' })
    expect(pp.calls.map(c => c.method)).toEqual(['GET'])
    expect((await tab()).order_id).toBe('EXISTING')
  })

  it.each(['CREATED', 'COMPLETED', 'UNKNOWN'])('keeps a stored wallet order when its %s state cannot yield checkout', async status => {
    await seed('DUE')
    await db.prepare("UPDATE tabs SET order_id = 'EXISTING'").run()
    const pp = fakePayPal({
      'GET /v2/checkout/orders/:id': () => ({ status: 200, body: { status } }),
      'POST /v2/checkout/orders': () => ORDER_CREATED,
    })
    expect(await startPayment({ db, pp: pp as any, origin: 'x' }, 'tab_1')).toMatchObject({ kind: 'refused', http: 409 })
    expect(pp.calls.filter(c => c.method === 'POST')).toHaveLength(0)
    expect((await tab()).order_id).toBe('EXISTING')
  })

  it('replaces a wallet order only after a successful read confirms VOIDED', async () => {
    await seed('DUE')
    await db.prepare("UPDATE tabs SET order_id = 'EXISTING'").run()
    const pp = fakePayPal({
      'GET /v2/checkout/orders/:id': () => ({ status: 200, body: { status: 'VOIDED' } }),
      'POST /v2/checkout/orders': () => ORDER_CREATED,
    })
    expect(await startPayment({ db, pp: pp as any, origin: 'x' }, 'tab_1')).toMatchObject({ kind: 'redirect' })
    expect(pp.calls[1].requestId).toBe('rt-order-tab_1-2')
    expect((await tab()).order_id).toBe('ORD1')
  })

  it('keeps EXISTING and refuses checkout when PayPal cannot read the wallet order', async () => {
    await seed('DUE')
    await db.prepare("UPDATE tabs SET order_id = 'EXISTING'").run()
    const pp = fakePayPal({
      'GET /v2/checkout/orders/:id': () => ({ status: 503, body: {} }),
      'POST /v2/checkout/orders': () => ORDER_CREATED,
    })
    const result = await startPayment({ db, pp: pp as any, origin: 'x' }, 'tab_1')
    expect(pp.calls.filter(c => c.method === 'POST')).toHaveLength(0)
    expect((await tab()).order_id).toBe('EXISTING')
    expect(result).toMatchObject({ kind: 'refused', reason: 'PayPal could not be reached. Try again.' })
  })

  it('makes one order for a DUE tab, with the tab id in the request id, and redirects to the payer action link', async () => {
    await seed('DUE')
    const pp = fakePayPal({ 'POST /v2/checkout/orders': () => ORDER_CREATED })
    const r = await startPayment({ db, pp: pp as any, origin: 'https://rt.example' }, 'tab_1')
    expect(r).toEqual({ kind: 'redirect', url: 'https://www.sandbox.paypal.com/checkoutnow?token=ORD1', order_id: 'ORD1' })
    expect(pp.calls[0].requestId).toBe('rt-order-tab_1')
    expect(pp.calls[0].body.purchase_units[0].amount.value).toBe('0.75')
    expect(pp.calls[0].body.purchase_units[0].items).toHaveLength(1)
    expect((await tab()).order_id).toBe('ORD1')
  })

  it('refuses to bill a tab that is not due', async () => {
    await seed('OPEN')
    const pp = fakePayPal({})
    expect((await startPayment({ db, pp: pp as any, origin: 'https://rt.example' }, 'tab_1')).kind).toBe('refused')
    expect(pp.calls).toHaveLength(0)
  })

  it('refuses payment while a threshold crossing call is still reserved', async () => {
    await seed('OPEN')
    await db.prepare('UPDATE tabs SET total_cents = 45, threshold_cents = 50 WHERE id = ?').bind('tab_1').run()
    await reserveCall(db, 'tab_1', 10, 2)
    const pp = fakePayPal({})
    await expect(startPayment({ db, pp: pp as any, origin: 'https://rt.example' }, 'tab_1'))
      .resolves.toMatchObject({ kind: 'refused', reason: 'A call is still running. Try again in a moment.', http: 409 })
    await expect(payWithTestCard({ db, pp: pp as any, origin: 'https://rt.example' }, 'tab_1', 'https://api-m.sandbox.paypal.com'))
      .resolves.toMatchObject({ kind: 'refused', reason: 'A call is still running. Try again in a moment.', http: 409 })
    expect(pp.calls).toHaveLength(0)
  })

  it('a COMPLETED capture on return sets PAID and records the capture', async () => {
    await seed('DUE')
    await db.prepare("UPDATE tabs SET order_id = 'ORD1'").run()
    const pp = fakePayPal({ 'POST /v2/checkout/orders/:id/capture': () => CAPTURED })
    const r = await completeReturn({ db, pp: pp as any, origin: 'https://rt.example' }, 'ORD1')
    expect(r).toMatchObject({ kind: 'paid', capture_id: 'CAP1' })
    expect(pp.calls[0].requestId).toBe('rt-capture-ORD1')
    expect(await tab()).toEqual({ state: 'PAID', order_id: 'ORD1', capture_id: 'CAP1', captured_cents: 75 })
  })

  it('a failed capture keeps the tab DUE', async () => {
    await seed('DUE')
    await db.prepare("UPDATE tabs SET order_id = 'ORD1'").run()
    const pp = fakePayPal({
      'POST /v2/checkout/orders/:id/capture': () => ({ status: 500, body: { name: 'INTERNAL_SERVER_ERROR', debug_id: 'd1' } }),
    })
    const r = await completeReturn({ db, pp: pp as any, origin: 'https://rt.example' }, 'ORD1')
    expect(r).toMatchObject({ kind: 'failed', http: 500 })
    expect((await tab()).state).toBe('DUE')
  })

  it('an unknown order on return does nothing', async () => {
    await seed('DUE')
    const pp = fakePayPal({})
    expect(await completeReturn({ db, pp: pp as any, origin: 'https://rt.example' }, 'NOT_OURS')).toEqual({ kind: 'unknown' })
    expect(pp.calls).toHaveLength(0)
  })

  it('an order already captured is read back and the tab is paid', async () => {
    await seed('DUE')
    await db.prepare("UPDATE tabs SET order_id = 'ORD1'").run()
    const pp = fakePayPal({
      'POST /v2/checkout/orders/:id/capture': () => ({ status: 422, body: { name: 'UNPROCESSABLE_ENTITY' } }),
      'GET /v2/checkout/orders/:id': () => ({ status: 200, body: CAPTURED.body }),
    })
    expect((await completeReturn({ db, pp: pp as any, origin: 'https://rt.example' }, 'ORD1')).kind).toBe('paid')
    expect((await tab()).state).toBe('PAID')
  })
})

describe('the sandbox test card shortcut', () => {
  it('pays a DUE tab with the published sandbox test card and marks it paid from the capture', async () => {
    await seed('DUE')
    const pp = fakePayPal({ 'POST /v2/checkout/orders': (body: any) => {
      expect(body.payment_source.card.number).toBe(SANDBOX_TEST_CARD.number)
      expect(body.payment_source.paypal).toBeUndefined()
      return { status: 201, body: { ...CAPTURED.body, id: 'ORDCARD' } }
    } })
    const r = await payWithTestCard({ db, pp: pp as any, origin: 'https://rt.example' }, 'tab_1', 'https://api-m.sandbox.paypal.com')
    expect(r).toMatchObject({ kind: 'paid', tab_id: 'tab_1' })
    expect(pp.calls[0].requestId).toBe('rt-order-tab_1-card')
    expect(await tab()).toEqual({ state: 'PAID', order_id: 'ORDCARD', capture_id: 'CAP1', captured_cents: 75 })
  })

  it('refuses outside the sandbox, and on a tab that is not due', async () => {
    await seed('OPEN')
    const pp = fakePayPal({})
    expect((await payWithTestCard({ db, pp: pp as any, origin: 'x' }, 'tab_1', 'https://api-m.sandbox.paypal.com')).kind).toBe('refused')
    await db.prepare("UPDATE tabs SET state = 'DUE'").run()
    expect((await payWithTestCard({ db, pp: pp as any, origin: 'x' }, 'tab_1', 'https://api-m.paypal.com')).kind).toBe('refused')
    expect(pp.calls).toHaveLength(0)
  })

  it('a declined card keeps the tab due', async () => {
    await seed('DUE')
    const pp = fakePayPal({ 'POST /v2/checkout/orders': () => ({ status: 422, body: { name: 'UNPROCESSABLE_ENTITY' } }) })
    const r = await payWithTestCard({ db, pp: pp as any, origin: 'x' }, 'tab_1', 'https://api-m.sandbox.paypal.com')
    expect(r.kind).toBe('refused')
    expect((await tab()).state).toBe('DUE')
  })
})


it.each(['approval', 'card'])('seals the ledger before making the %s order', async mode => {
  await seed('DUE')
  const pp = fakePayPal({ 'POST /v2/checkout/orders': body => {
    const hash = db.raw.prepare('SELECT chain_hash FROM calls ORDER BY seq DESC LIMIT 1').get()!.chain_hash
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect((body as any).purchase_units[0].custom_id).toBe(`rt:${hash}`)
    return mode === 'card' ? CAPTURED : ORDER_CREATED
  } })
  const deps = { db, pp: pp as any, origin: 'https://rt.example' }
  if (mode === 'card') await payWithTestCard(deps, 'tab_1', 'https://api-m.sandbox.paypal.com')
  else await startPayment(deps, 'tab_1')
})
