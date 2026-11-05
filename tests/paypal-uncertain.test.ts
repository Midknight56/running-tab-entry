import { expect, it } from 'vitest'
import { payWithTestCard, startPayment } from '../src/bill/settle'
import { refundCall } from '../src/claims/refund'
import { PayPalClient } from '../src/paypal/client'
import { callsOfTab, getTab } from '../src/tab/ledger'
import { fakeD1, fakeKV } from './helpers/d1'

it.each(['card', 'refund'])('keeps a %s unresolved when the client retries a lost response and receives 422', async method => {
  const db = fakeD1()
  await db.prepare(`INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, capture_id, captured_cents, created_at)
    VALUES ('tab_1', 'ws1', 'agt_1', ?, 500, 500, ?, ?, 1)`)
    .bind(method === 'card' ? 'DUE' : 'PAID', method === 'card' ? null : 'CAP1', method === 'card' ? 0 : 500).run()
  for (const seq of [1, 2, 3]) await db.prepare(`INSERT INTO calls
    (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
    VALUES (?, ?, 'ws1', 'agt_1', 'tab_1', 'tool', '{}', '{}', ?, 'BILLABLE', 1)`)
    .bind(`call_${seq}`, seq, seq === 3 ? 450 : 25).run()
  const sends: { id: string | null; body?: BodyInit | null }[] = []
  const pp = new PayPalClient({ base: 'https://api-m.sandbox.paypal.com', clientId: 'test', secret: 'test', kv: fakeKV(),
    memory: new Map([['test', { token: 'test', until: Number.MAX_SAFE_INTEGER }]]),
    fetch: async (_input, init) => {
      sends.push({ id: new Headers(init?.headers).get('PayPal-Request-Id'), body: init?.body })
      if (sends.length === 1) throw new Error('lost answer after send')
      if (sends.length === 2) return new Response('{"name":"UNPROCESSABLE_ENTITY"}', { status: 422 })
      return new Response(JSON.stringify(method === 'refund' ? { id: 'REF1', status: 'COMPLETED' }
        : { id: 'ORD1', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP1', status: 'COMPLETED', amount: { value: '5.00' } }] } }] }), { status: 201 })
    },
  })
  if (method === 'card') {
    await payWithTestCard({ db, pp, origin: 'x' }, 'tab_1', 'https://api-m.sandbox.paypal.com')
    expect(await db.prepare('SELECT state FROM pay_attempts').first('state')).toBe('SENT')
    expect(await startPayment({ db, pp, origin: 'x' }, 'tab_1')).toMatchObject({ kind: 'paid' })
  } else {
    await db.prepare("INSERT INTO claims (id, ws_id, call_id, reason_text, state, created_at) VALUES ('clm_1', 'ws1', 'call_1', 'bad', 'APPROVED', 1)").run()
    const call = (await callsOfTab(db, 'tab_1'))[0]
    expect(await refundCall(db, pp, 'clm_1', call, (await getTab(db, 'tab_1'))!, 'auto')).toMatchObject({ status: 'UNCERTAIN' })
    expect((await getTab(db, 'tab_1'))!.refunded_cents).toBe(25)
    expect(await refundCall(db, pp, 'clm_1', call, (await getTab(db, 'tab_1'))!, 'auto')).toMatchObject({ ok: true, status: 'COMPLETED' })
    expect((await getTab(db, 'tab_1'))!.refunded_cents).toBe(25)
  }
  expect(sends).toHaveLength(3)
  expect(new Set(sends.map(s => s.id)).size).toBe(1)
  expect(new Set(sends.map(s => s.body)).size).toBe(1)
})
