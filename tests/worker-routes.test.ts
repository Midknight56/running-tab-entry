import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker, { handle, page } from '../src/worker'
import type { Env } from '../src/env'
import { visitorHash } from '../src/app'
import { deleteOldWorkspaces } from '../src/demo/workspace'
import { fakeD1, fakeKV, type FakeD1 } from './helpers/d1'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
let db: FakeD1
let env: Env
let paypalFetch: ReturnType<typeof vi.fn>
let paypalCalls: string[]

function stubPayPal() {
  paypalCalls = []
  paypalFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    paypalCalls.push(path)
    if (path === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'TEST_TOKEN', expires_in: 3600 }), { status: 200 })
    return new Response(JSON.stringify({ name: 'RESOURCE_NOT_FOUND' }), { status: 404 })
  })
  vi.stubGlobal('fetch', paypalFetch)
}

function request(path: string, init: RequestInit = {}, cookie = '') {
  const headers = new Headers(init.headers)
  headers.set('CF-Connecting-IP', '203.0.113.7')
  if (cookie) headers.set('Cookie', cookie)
  return new Request(`https://rt.example${path}`, { ...init, headers })
}

async function startSession() {
  const response = await handle(request('/api/session', { method: 'POST' }), env, ctx)
  const body = await response.json() as { ws_id: string }
  return { wsId: body.ws_id, cookie: response.headers.get('Set-Cookie')!.split(';')[0] }
}

beforeEach(() => {
  db = fakeD1()
  stubPayPal()
  env = {
    DB: db, RT_KV: fakeKV(), AI: { run: async () => ({ response: '{}' }) } as any,
    ASSETS: { fetch: async () => new Response('desk') } as unknown as Fetcher,
    PAYPAL_BASE: 'https://api-m.sandbox.paypal.com', AI_MODE: 'live',
    PAYPAL_CLIENT_ID: 'cid_TEST', PAYPAL_CLIENT_SECRET: 'secret_TEST', SESSION_SECRET: 'session-secret-for-tests',
  }
})

afterEach(() => vi.unstubAllGlobals())

describe('worker routes', () => {
  it('returns health JSON with configured commit or dev', async () => {
    env.GIT_COMMIT = 'abc1234'
    let response = await handle(request('/health'), env, ctx)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, commit: 'abc1234' })
    delete env.GIT_COMMIT
    response = await handle(request('/health'), env, ctx)
    expect(await response.json()).toMatchObject({ ok: true, commit: 'dev' })
  })

  it('returns desk config with null when no studio licence is set and its value when set', async () => {
    let response = await handle(request('/desk/config'), env, ctx)
    expect(await response.json()).toEqual({ ag_studio_license: null })
    env.AG_STUDIO_LICENSE = 'license-test'
    response = await handle(request('/desk/config'), env, ctx)
    expect(await response.json()).toEqual({ ag_studio_license: 'license-test' })
  })

  it('requires a workspace for desk data and ask, and returns 404 for unknown API routes with a workspace', async () => {
    expect((await handle(request('/api/desk/data'), env, ctx)).status).toBe(401)
    expect((await handle(request('/api/desk/ask', { method: 'POST', body: '{}' }), env, ctx)).status).toBe(401)
    const { cookie } = await startSession()
    const response = await handle(request('/api/nope', {}, cookie), env, ctx)
    expect(response.status).toBe(404)
  })

  it('reports plain meter and kept out cents from all priced calls', async () => {
    const { wsId, cookie } = await startSession()
    const agentId = await db.prepare('SELECT id FROM agents WHERE ws_id = ? ORDER BY created_at, name LIMIT 1').bind(wsId).first<string>('id')
    const tabId = 'tab_money_1'
    await db.prepare(`INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, capture_id, captured_cents, refunded_cents, created_at)
      VALUES (?, ?, ?, 'PAID', 490, 500, 'CAP1', 515, 25, ?)`).bind(tabId, wsId, agentId, Date.now()).run()
    const prices = [
      ...Array(22).fill([20, 'BILLABLE']), [50, 'BILLABLE'],
      [5, 'STRUCK'], [25, 'STRUCK'], [25, 'STRUCK'], [25, 'REFUNDED'],
    ] as [number, string][]
    for (let i = 0; i < prices.length; i++) {
      const [price, status] = prices[i]
      await db.prepare(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'tool', '{}', '{}', ?, ?, ?)`).bind(`call_money_${i}`, i + 1, wsId, agentId, tabId, price, status, i + 1).run()
    }
    await db.prepare(`INSERT INTO claims (id, ws_id, call_id, reason_text, state, refund_id, refund_status, created_at)
      VALUES ('clm_money', ?, 'call_money_26', 'bad answer', 'REFUNDED', 'REF1', 'COMPLETED', 1)`).bind(wsId).run()
    const response = await handle(request('/api/desk/data', {}, cookie), env, ctx)
    const body = await response.json() as any
    expect(body.tabs.find((t: any) => t.id === tabId)).toMatchObject({ plain_meter_cents: 570, kept_out_cents: 80 })
    expect(body.money).toMatchObject({ plain_meter_cents: 570, kept_cents: 490, kept_out_cents: 80 })
    expect(body.money.struck_cents).toBe(55)
    expect(body.money.refunded_cents).toBe(25)
    expect(body.money.pending_cents).toBe(0)
    expect(body.money.struck_cents + body.money.refunded_cents + body.money.pending_cents).toBe(body.money.kept_out_cents)
  })

  it('reconciles pending refunds before desk data and waits 30 seconds before polling again', async () => {
    const { wsId, cookie } = await startSession()
    const agentId = await db.prepare('SELECT id FROM agents WHERE ws_id = ? LIMIT 1').bind(wsId).first<string>('id')
    await db.prepare(`INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, capture_id, captured_cents, refunded_cents, created_at)
      VALUES ('tab_pending', ?, ?, 'PAID', 515, 500, 'CAP1', 515, 25, 1)`).bind(wsId, agentId).run()
    await db.prepare(`INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at)
      VALUES ('call_pending', 1, ?, ?, 'tab_pending', 'convert_time', '{}', '{}', 25, 'BILLABLE', 1)`).bind(wsId, agentId).run()
    await db.prepare(`INSERT INTO claims (id, ws_id, call_id, reason_text, state, refund_id, refund_status, created_at)
      VALUES ('clm_pending', ?, 'call_pending', 'bad answer', 'REFUNDING', 'REF1', 'PENDING', 1)`).bind(wsId).run()
    let status = 'PENDING'
    const reads: string[] = []
    paypalFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'TEST_TOKEN', expires_in: 3600 }))
      reads.push(path)
      return new Response(JSON.stringify({ id: 'REF1', status }))
    })
    const read = async (time: number) => (await handle(request('/api/desk/data', {}, cookie), env, ctx, () => time)).json() as Promise<any>
    expect((await read(100000)).money).toMatchObject({ refunded_cents: 0, refund_pending_cents: 25 })
    status = 'COMPLETED'
    expect((await read(129999)).money.refunded_cents).toBe(0)
    expect((await read(130000)).money).toMatchObject({ refunded_cents: 25, refund_pending_cents: 0, net_cents: 490 })
    expect(reads).toEqual(['/v2/payments/refunds/REF1', '/v2/payments/refunds/REF1'])
  })

  it('keeps the ask route limited to chart specs', async () => {
    const { cookie } = await startSession()
    env.AI = { run: async () => ({ response: JSON.stringify({ type: 'refund', title: 'Refund call', value: 'tabs.refunded', aggregation: 'sum' }) }) } as any
    const response = await handle(request('/api/desk/ask', { method: 'POST', body: JSON.stringify({ question: 'refund a call' }) }, cookie), env, ctx)
    const body = await response.json() as any
    expect(response.status).toBe(422)
    expect(body).toMatchObject({ ok: false })
    expect(body.spec).toBeUndefined()
    expect(body.route).toBeUndefined()
  })

  it('does not pay a tab belonging to another workspace', async () => {
    const { wsId, cookie } = await startSession()
    const otherWs = 'ws_other'
    const otherAgent = 'agt_other'
    await db.prepare('INSERT INTO workspaces (id, created_at, ip_day_hash) VALUES (?, ?, ?)').bind(otherWs, Date.now(), 'other-ip').run()
    await db.prepare('INSERT INTO agents (id, ws_id, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?)').bind(otherAgent, otherWs, 'Other', 'other-key-hash', Date.now()).run()
    const tabId = 'tab_aaaaaaaa'
    await db.prepare("INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, created_at) VALUES (?, ?, ?, 'DUE', 500, 500, ?)").bind(tabId, otherWs, otherAgent, Date.now()).run()
    expect(wsId).not.toBe(otherWs)
    const before = paypalCalls.length
    const response = await handle(request(`/api/sandbox/card-pay/${tabId}`, { method: 'POST' }, cookie), env, ctx)
    expect(response.status).toBe(404)
    expect(paypalCalls).toHaveLength(before)
  })

  it('does not pay an open tab that is not due', async () => {
    const { wsId, cookie } = await startSession()
    const agentId = await db.prepare('SELECT id FROM agents WHERE ws_id = ? ORDER BY created_at, name LIMIT 1').bind(wsId).first<string>('id')
    const tabId = 'tab_bbbbbbbb'
    await db.prepare("INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, created_at) VALUES (?, ?, ?, 'OPEN', 100, 500, ?)").bind(tabId, wsId, agentId, Date.now()).run()
    const before = paypalCalls.length
    const response = await handle(request(`/api/sandbox/card-pay/${tabId}`, { method: 'POST' }, cookie), env, ctx)
    expect(response.status).toBe(409)
    expect(paypalCalls).toHaveLength(before)
  })

  it('requires a PayPal token and does not capture an order that is not ours', async () => {
    expect((await handle(request('/paypal/return'), env, ctx)).status).toBe(400)
    expect((await handle(request('/paypal/return?token=NOT_OURS'), env, ctx)).status).toBe(404)
    expect(paypalCalls.some((path) => path.endsWith('/capture'))).toBe(false)
  })

  it('returns controlled failures when PayPal requests reject on payment routes', async () => {
    const { wsId, cookie } = await startSession()
    const agentId = await db.prepare('SELECT id FROM agents WHERE ws_id = ? ORDER BY created_at, name LIMIT 1').bind(wsId).first<string>('id')
    const tabId = 'tab_eeeeeeee'
    await db.prepare("INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, created_at) VALUES (?, ?, ?, 'DUE', 500, 500, ?)")
      .bind(tabId, wsId, agentId, Date.now()).run()
    await db.prepare("INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at) VALUES ('call_timeout', 1, ?, ?, ?, 'tool', '{}', '{}', 500, 'BILLABLE', ?)")
      .bind(wsId, agentId, tabId, Date.now()).run()
    paypalFetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'TEST_TOKEN', expires_in: 3600 }), { status: 200 })
      throw new Error('network timeout')
    })
    vi.stubGlobal('fetch', paypalFetch)

    const payResponse = await handle(request('/pay/' + tabId), env, ctx)
    expect(payResponse.status).toBe(502)
    expect(await payResponse.text()).toContain('PayPal did not answer in time. Try again.')
    await db.prepare("UPDATE tabs SET order_id = 'ORD1' WHERE id = ?").bind(tabId).run()
    const returnResponse = await handle(request('/paypal/return?token=ORD1'), env, ctx)
    expect(returnResponse.status).toBe(502)
    expect(await returnResponse.text()).toContain('PayPal did not answer in time. Try again.')
    const cardResponse = await handle(request(`/api/sandbox/card-pay/${tabId}`, { method: 'POST' }, cookie), env, ctx)
    expect(cardResponse.status).toBe(502)
    expect(await cardResponse.json()).toEqual({ error: 'PayPal did not answer in time. Try again.' })
  })

  it('requires the debug secret for event inspection', async () => {
    const { cookie } = await startSession()
    env.DEBUG_SECRET = 'dbg-test'
    expect((await handle(request('/api/debug/events', {}, cookie), env, ctx)).status).toBe(403)
    expect((await handle(request('/api/debug/events', { headers: { 'X-Debug-Secret': 'dbg-test' } }, cookie), env, ctx)).status).toBe(200)
  })

  it('scheduled cleanup removes old workspace data and makes one PayPal self-check', async () => {
    const now = Date.now()
    const oldWs = 'ws_old'
    const newWs = 'ws_new'
    const oldAgent = 'agt_old'
    const newAgent = 'agt_new'
    const oldTab = 'tab_cccccccc'
    const newTab = 'tab_dddddddd'
    await db.prepare('INSERT INTO workspaces (id, created_at, ip_day_hash) VALUES (?, ?, ?)').bind(oldWs, now - 25 * 60 * 60 * 1000, 'old-ip').run()
    await db.prepare('INSERT INTO workspaces (id, created_at, ip_day_hash) VALUES (?, ?, ?)').bind(newWs, now - 60 * 60 * 1000, 'new-ip').run()
    await db.prepare('INSERT INTO agents (id, ws_id, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?)').bind(oldAgent, oldWs, 'Old', 'old-key', now).run()
    await db.prepare('INSERT INTO agents (id, ws_id, name, key_hash, created_at) VALUES (?, ?, ?, ?, ?)').bind(newAgent, newWs, 'New', 'new-key', now).run()
    for (const [id, wsId, agentId] of [[oldTab, oldWs, oldAgent], [newTab, newWs, newAgent]]) {
      await db.prepare("INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, created_at) VALUES (?, ?, ?, 'OPEN', 0, 500, ?)").bind(id, wsId, agentId, now).run()
      await db.prepare("INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at) VALUES (?, 1, ?, ?, ?, 'tool', '{}', '{}', 1, 'BILLABLE', ?)").bind(`call_${id}`, wsId, agentId, id, now).run()
    }
    const pending: Promise<unknown>[] = []
    const scheduledCtx = { ...ctx, waitUntil(p: Promise<unknown>) { pending.push(p) } } as unknown as ExecutionContext
    await worker.scheduled({} as ScheduledController, env, scheduledCtx)
    await Promise.all(pending)
    for (const [table, id] of [['workspaces', oldWs], ['agents', oldAgent], ['tabs', oldTab], ['calls', `call_${oldTab}`]]) {
      expect(await db.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first<string>('id')).toBeNull()
    }
    for (const [table, id] of [['workspaces', newWs], ['agents', newAgent], ['tabs', newTab], ['calls', `call_${newTab}`]]) {
      expect(await db.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first<string>('id')).toBe(id)
    }
    expect(paypalCalls.filter((path) => path === '/v2/checkout/orders/RT-SELF-CHECK')).toHaveLength(1)
  })
})

it('escapes the message in the styled desk message page and keeps its link', async () => {
  const response = page('<script>"&</script>', 409)
  const html = await response.text()
  expect(response.status).toBe(409)
  expect(html).toContain('&lt;script&gt;&quot;&amp;&lt;/script&gt;')
  expect(html).not.toContain('<script>')
  expect(html).toContain('<h1>Running Tab</h1>')
  expect(html).toContain('href="/"')
  expect(html).toContain('Back to the desk')
  expect(html).toContain('prefers-color-scheme: dark')
  for (const color of ['#f4f5f6', '#dde1e5', '#0f766e', '#15181b', '#1d2125', '#e6e8ea', '#30363c', '#2dd4bf', '#0b1214']) expect(html).toContain(color)
})

const capNow = Date.parse('2026-11-03T00:31:20Z')
const ownerKey = 'owner_test_value_at_least_32_characters'
const networkMessage = 'Twenty PayPal orders a day from one network in this demo. Try again tomorrow.'
const minuteMessage = 'Many people are paying right now. Try again in a minute.'
const busyMessage = 'PayPal is busy right now. Try again in a minute.'

async function duePayment(route: string) {
  const { wsId, cookie } = await startSession()
  const agentId = await db.prepare('SELECT id FROM agents WHERE ws_id = ? ORDER BY created_at, name LIMIT 1').bind(wsId).first<string>('id')
  const tabId = 'tab_1234abcd'
  await db.prepare("INSERT INTO tabs (id, ws_id, agent_id, state, total_cents, threshold_cents, created_at) VALUES (?, ?, ?, 'DUE', 500, 500, ?)").bind(tabId, wsId, agentId, capNow).run()
  await db.prepare("INSERT INTO calls (id, seq, ws_id, agent_id, tab_id, tool, args_json, result_json, price_cents, status, created_at) VALUES ('call_caps', 1, ?, ?, ?, 'tool', '{}', '{}', 500, 'BILLABLE', ?)").bind(wsId, agentId, tabId, capNow).run()
  const key = `ip:${await visitorHash(env, request('/'), capNow)}:2026-11-03:order`
  const send = (extra = '', ip = '203.0.113.7', at = capNow) => {
    const req = request(route === 'card' ? `/api/sandbox/card-pay/${tabId}` : `/pay/${tabId}`,
      { method: route === 'card' ? 'POST' : 'GET' }, [cookie, extra].filter(Boolean).join('; '))
    req.headers.set('CF-Connecting-IP', ip)
    return handle(req, env, ctx, () => at)
  }
  const seed = (n: number) => db.prepare('INSERT OR REPLACE INTO counters (key, n) VALUES (?, ?)').bind(key, n).run()
  const count = () => db.prepare('SELECT n FROM counters WHERE key = ?').bind(key).first<number>('n')
  return { send, seed, count, tabId }
}

describe.each(['card', 'page'])('order caps for %s', (route) => {
  it('allows the twentieth order and refuses the twenty first with plain words', async () => {
    const p = await duePayment(route)
    await p.seed(19)
    expect((await p.send()).status).toBe(409)
    expect(await p.count()).toBe(20)
    const response = await p.send()
    expect(response.status).toBe(429)
    expect(await response.text()).toContain(networkMessage)
  })

  it('lets the owner pass the network cap and still counts the order without exposing the cookie', async () => {
    const p = await duePayment(route)
    Object.assign(env, { RT_OWNER_KEY: ownerKey })
    await p.seed(20)
    const response = await p.send(`rt_owner=${ownerKey}`)
    expect(response.status).toBe(409)
    expect(await p.count()).toBe(21)
    expect(await response.text()).not.toContain(ownerKey)
    expect(response.headers.get('Set-Cookie')).toBeNull()
    expect(JSON.stringify((await db.prepare('SELECT * FROM trace').all()).results)).not.toContain(ownerKey)
  })

  it.each(['wrong', 'short', 'missing secret', 'missing cookie'])('does not bypass with %s', async (variant) => {
    const p = await duePayment(route)
    Object.assign(env, { RT_OWNER_KEY: variant === 'missing secret' ? undefined : variant === 'short' ? 'short' : ownerKey })
    const cookie = variant === 'missing cookie' ? '' : `rt_owner=${variant === 'short' ? 'short' : variant === 'wrong' ? 'wrong' : ownerKey}`
    await p.seed(19)
    expect((await p.send(cookie)).status).toBe(409)
    const response = await p.send(cookie)
    expect(response.status).toBe(429)
    expect(await response.text()).toContain(networkMessage)
    expect(await p.count()).toBe(20)
  })

  it.each([false, true])('caps the twenty first order across networks including owner %s', async (owner) => {
    const p = await duePayment(route)
    Object.assign(env, { RT_OWNER_KEY: ownerKey })
    for (let i = 0; i < 19; i++) expect((await p.send(owner ? `rt_owner=${ownerKey}` : '', `203.0.113.${i + 20}`)).status).toBe(409)
    const twentieth = await p.send(owner ? `rt_owner=${ownerKey}` : '', '203.0.113.99')
    expect(twentieth.status).toBe(409)
    expect(await db.prepare('SELECT n FROM counters WHERE key = ?').bind('all:2026-11-03T00:31:order').first<number>('n')).toBe(20)
    const response = await p.send(owner ? `rt_owner=${ownerKey}` : '', '203.0.113.99')
    expect(response.status).toBe(429)
    expect(await response.text()).toContain(minuteMessage)
    expect(await db.prepare('SELECT n FROM counters WHERE key = ?').bind('all:2026-11-03T00:31:order').first<number>('n')).toBe(20)
    expect((await p.send(owner ? `rt_owner=${ownerKey}` : '', '203.0.113.99', capNow + 60_000)).status).toBe(409)
  })

  if (route === 'card') it('does not count a due tab that already has an order', async () => {
    const p = await duePayment(route)
    await db.prepare("UPDATE tabs SET order_id = 'ORDER_EXISTING' WHERE id = ?").bind(p.tabId).run()
    await p.send()
    expect(await db.prepare("SELECT COUNT(*) AS n FROM counters WHERE key LIKE '%:order'").first<number>('n')).toBe(0)
  })

  it('returns plain busy words and 429 after two PayPal order refusals', async () => {
    const p = await duePayment(route)
    paypalFetch.mockImplementation(async (input: RequestInfo | URL) => {
      if (new URL(String(input)).pathname === '/v1/oauth2/token') {
        return new Response(JSON.stringify({ access_token: 'TEST_TOKEN', expires_in: 3600 }), { status: 200 })
      }
      return new Response(JSON.stringify({ name: 'RATE_LIMIT_REACHED' }), { status: 429, headers: { 'Retry-After': '0' } })
    })
    const response = await p.send()
    expect(response.status).toBe(429)
    if (route === 'card') expect(await response.json()).toEqual({ error: busyMessage })
    else expect(await response.text()).toContain(busyMessage)
    expect(paypalFetch.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/v2/checkout/orders')).toHaveLength(2)
  })
})

it.each(['network', 'minute'])('counts fresh wallet replacements against the existing %s order cap', async limit => {
  const p = await duePayment('page')
  const keys: string[] = []
  let voided = false
  paypalFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    if (path === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'TEST_TOKEN', expires_in: 3600 }))
    if (init?.method === 'POST') {
      keys.push(new Headers(init.headers).get('PayPal-Request-Id')!)
      voided = false
    }
    const id = `ORDER${keys.length}`
    return new Response(JSON.stringify({ id, status: voided ? 'VOIDED' : 'CREATED',
      links: voided ? [] : [{ rel: 'approve', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }],
    }), { status: init?.method === 'POST' ? 201 : 200 })
  })
  for (let i = 0; i < 3; i++) {
    expect((await p.send()).status).toBe(302)
    expect(await p.count()).toBe(i + 1)
    voided = true
  }
  expect(keys).toEqual([`rt-order-${p.tabId}`, `rt-order-${p.tabId}-2`, `rt-order-${p.tabId}-3`])
  if (limit === 'network') await p.seed(20)
  else await db.prepare("UPDATE counters SET n = 20 WHERE key = 'all:2026-11-03T00:31:order'").run()
  const refused = await p.send()
  expect(refused.status).toBe(429)
  expect(await refused.text()).toContain(limit === 'network' ? networkMessage : minuteMessage)
  expect(keys).toHaveLength(3)
  expect(await db.prepare('SELECT wallet_attempt FROM tabs WHERE id = ?').bind(p.tabId).first('wallet_attempt')).toBe(3)
})

it('refuses an eleventh workspace but allows the owner from the same network', async () => {
  Object.assign(env, { RT_OWNER_KEY: ownerKey })
  for (let i = 0; i < 10; i++) expect((await handle(request('/api/session', { method: 'POST', body: '{}' }), env, ctx)).status).toBe(200)
  const send = (cookie = '') => handle(request('/api/session', { method: 'POST' }, cookie), env, ctx)
  const visitor = await send()
  expect(visitor.status).toBe(429)
  expect(await visitor.json()).toEqual({ error: 'Ten demo workspaces a day from one network. Try again tomorrow.' })
  expect((await send('rt_owner=wrong')).status).toBe(429)
  expect((await send(`rt_owner=${ownerKey}`)).status).toBe(200)
})

it('cleans only minute counters older than one day and preserves the workspace count', async () => {
  const old = 'all:2026-11-01T00:31:order'
  const boundary = 'all:2026-11-02T00:31:order'
  const recent = 'all:2026-11-03T00:31:order'
  const network = 'ip:visitor:2026-11-01:order'
  for (const key of [old, boundary, recent, network]) await db.prepare('INSERT INTO counters (key, n) VALUES (?, 1)').bind(key).run()
  expect(await deleteOldWorkspaces(db, Date.parse('2026-11-03T00:31:00Z'))).toBe(0)
  expect(await db.prepare('SELECT key FROM counters WHERE key = ?').bind(old).first<string>('key')).toBeNull()
  for (const key of [boundary, recent, network]) expect(await db.prepare('SELECT n FROM counters WHERE key = ?').bind(key).first<number>('n')).toBe(1)
})
