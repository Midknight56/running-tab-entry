import { describe, expect, it, vi } from 'vitest'
import { PayPalClient } from '../src/paypal/client'
import { fakeKV } from './helpers/d1'

const SECRET = 'sk_TEST_SECRET_VALUE_123'
const CLIENT = 'client_TEST_ID_456'

function paypalFake(opts: { expiresIn?: number; firstCallStatus?: number } = {}) {
  let tokens = 0
  let apiCalls = 0
  const seen: { url: string; headers: Record<string, string> }[] = []
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    seen.push({ url, headers })
    if (url.endsWith('/v1/oauth2/token')) {
      tokens++
      return new Response(JSON.stringify({ access_token: 'tok_' + tokens, expires_in: opts.expiresIn ?? 32400, token_type: 'Bearer' }), { status: 200 })
    }
    apiCalls++
    if (apiCalls === 1 && opts.firstCallStatus) {
      return new Response(JSON.stringify({ name: 'AUTHENTICATION_FAILURE', debug_id: 'dbg401' }), { status: opts.firstCallStatus })
    }
    return new Response(JSON.stringify({ id: 'ORDER1', status: 'CREATED' }), { status: 201, headers: { 'paypal-debug-id': 'dbg201' } })
  })
  return { f, seen, tokens: () => tokens }
}

function client(fake: ReturnType<typeof paypalFake>, now: () => number, kv = fakeKV(), trace: unknown[] = []) {
  return new PayPalClient({
    base: 'https://api-m.sandbox.paypal.com', clientId: CLIENT, secret: SECRET, kv,
    fetch: fake.f as unknown as typeof fetch, now, memory: new Map(), trace: (r) => { trace.push(r) },
  })
}

describe('PayPal client', () => {
  it.each(['null', '[]', '"accepted"'])('marks a non-object success body %s unreadable', async body => {
    const fake = paypalFake()
    fake.f.mockImplementation(async (input: RequestInfo | URL) => String(input).endsWith('/v1/oauth2/token')
      ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
      : new Response(body, { status: 201 }))
    expect(await client(fake, () => 1).request('POST', '/v2/payments/captures/CAP1/refund')).toMatchObject({ status: 201, bodyRead: false })
  })

  it('marks an unreadable response body so a card refusal cannot be assumed', async () => {
    const fake = paypalFake()
    fake.f.mockImplementation(async (input: RequestInfo | URL) => String(input).endsWith('/v1/oauth2/token')
      ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
      : new Response('{broken', { status: 422 }))
    expect(await client(fake, () => 1).request('POST', '/v2/checkout/orders')).toMatchObject({ status: 422, bodyRead: false })
  })

  it('caches the token until 600 s before expires_in, then fetches a new one', async () => {
    const fake = paypalFake({ expiresIn: 3600 })
    let t = 1_000_000
    const kv = fakeKV()
    const c = client(fake, () => t, kv)
    await c.request('GET', '/v2/checkout/orders/X')
    await c.request('GET', '/v2/checkout/orders/X')
    expect(fake.tokens()).toBe(1)
    expect([...kv.store.values()][0].ttl).toBe(3000)
    t += (3600 - 600 - 1) * 1000
    await c.request('GET', '/v2/checkout/orders/X')
    expect(fake.tokens()).toBe(1)
    t += 2000
    await c.request('GET', '/v2/checkout/orders/X')
    expect(fake.tokens()).toBe(2)
  })

  it('reads the token from KV when this isolate has none', async () => {
    const fake = paypalFake()
    const kv = fakeKV()
    await client(fake, () => 5_000, kv).request('GET', '/x')
    await client(fake, () => 6_000, kv).request('GET', '/x')
    expect(fake.tokens()).toBe(1)
  })

  it('on a 401 drops the token, fetches once and retries once', async () => {
    const fake = paypalFake({ firstCallStatus: 401 })
    const r = await client(fake, () => 1).request('GET', '/v2/checkout/orders/X')
    expect(r.status).toBe(201)
    expect(fake.tokens()).toBe(2)
  })

  it('sends a PayPal-Request-Id on every POST, the given one when there is one', async () => {
    const fake = paypalFake()
    const c = client(fake, () => 1)
    await c.request('POST', '/v2/checkout/orders', { body: {}, requestId: 'rt-order-tab1' })
    await c.request('POST', '/v2/checkout/orders', { body: {} })
    const posts = fake.seen.filter((s) => !s.url.endsWith('/token'))
    expect(posts[0].headers['paypal-request-id']).toBe('rt-order-tab1')
    expect(posts[1].headers['paypal-request-id']).toMatch(/^rt-/)
  })

  it('times out while reading a response body', async () => {
    vi.useFakeTimers()
    const fake = paypalFake()
    fake.f.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 })
    })
    const pending = client(fake, () => 1).request('GET', '/body-stall')
    const assertion = expect(pending).rejects.toThrow('PayPal request timed out or failed')
    await vi.advanceTimersByTimeAsync(15_000)
    await assertion
    vi.useRealTimers()
  })

  it('never puts the secret or a token in a trace row or a console line', async () => {
    const fake = paypalFake({ firstCallStatus: 401 })
    const trace: unknown[] = []
    const logs: string[] = []
    const spies = (['log', 'error', 'warn', 'info'] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) }))
    await client(fake, () => 1, fakeKV(), trace).request('POST', '/v2/checkout/orders', { body: { a: 1 } })
    spies.forEach((s) => s.mockRestore())
    const all = JSON.stringify(trace) + logs.join('\n')
    expect(trace.length).toBeGreaterThan(0)
    for (const bad of [SECRET, CLIENT, 'tok_1', 'tok_2', 'Bearer', 'Basic ']) expect(all).not.toContain(bad)
    expect(JSON.stringify(trace)).toContain('dbg201')
  })
})

describe('PayPal busy retry', () => {
  it.each([
    [undefined, 201, 1500], ['2', 201, 2000], ['60', 201, 5000], [undefined, 429, 1500],
  ])('retries once with Retry After %s and final status %s', async (retryAfter, finalStatus, wait) => {
    const seen: Headers[] = []
    const sleep = vi.fn(async (_ms: number) => {})
    const trace: any[] = []
    const f = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers))
      return new Response(JSON.stringify({ name: 'RATE_LIMIT_REACHED', debug_id: `debug${seen.length}` }), {
        status: seen.length === 1 ? 429 : finalStatus,
        headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter },
      })
    })
    const c = new PayPalClient({
      base: 'https://paypal.example', clientId: CLIENT, secret: SECRET, kv: fakeKV(), fetch: f,
      memory: new Map([[CLIENT, { token: 'cached', until: Number.MAX_SAFE_INTEGER }]]),
      sleep, trace: row => { trace.push(row) },
    })
    const result = await c.request('POST', '/v2/checkout/orders', { body: {} })
    expect(result.status).toBe(finalStatus)
    expect(sleep).toHaveBeenCalledExactlyOnceWith(wait)
    expect(f).toHaveBeenCalledTimes(2)
    expect(seen[0].get('PayPal-Request-Id')).toBeTruthy()
    expect(seen[1].get('PayPal-Request-Id')).toBe(seen[0].get('PayPal-Request-Id'))
    expect(trace.map(row => row.http)).toEqual([429, finalStatus])
    expect(trace.map(row => row.paypal_debug_id)).toEqual(['debug1', 'debug2'])
  })
})
