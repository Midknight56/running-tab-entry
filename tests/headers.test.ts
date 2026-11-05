import { beforeEach, describe, expect, it } from 'vitest'
import worker from '../src/worker'
import type { Env } from '../src/env'
import { fakeD1, fakeKV } from './helpers/d1'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "frame-ancestors 'none'",
}
let env: Env

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://rt.example${path}`, init)
}

function expectSecurityHeaders(response: Response) {
  for (const [name, value] of Object.entries(securityHeaders)) expect(response.headers.get(name)).toBe(value)
}

beforeEach(() => {
  env = {
    DB: fakeD1(), RT_KV: fakeKV(), AI: { run: async () => ({ response: '{}' }) } as any,
    ASSETS: { fetch: async () => Response.redirect('https://x/y', 302) } as unknown as Fetcher,
    PAYPAL_BASE: 'https://api-m.sandbox.paypal.com', AI_MODE: 'live',
    PAYPAL_CLIENT_ID: 'cid_TEST', PAYPAL_CLIENT_SECRET: 'secret_TEST', SESSION_SECRET: 'session-secret-for-tests',
  }
})

describe('security response headers', () => {
  it('adds headers to health responses', async () => {
    const response = await worker.fetch(request('/health'), env, ctx)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/json')
    expectSecurityHeaders(response)
  })

  it('adds headers and keeps the session cookie', async () => {
    const response = await worker.fetch(request('/api/session', { method: 'POST' }), env, ctx)
    expect(response.status).toBe(200)
    expect(response.headers.get('Set-Cookie')).toContain('rt_ws=')
    expect(response.headers.get('Content-Type')).toBe('application/json')
    expectSecurityHeaders(response)
  })

  it('copies immutable asset redirects and keeps their status and Location', async () => {
    const response = await worker.fetch(request('/desk/index.html'), env, ctx)
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('https://x/y')
    expectSecurityHeaders(response)
  })

  it('adds headers to PayPal cancel redirects and keeps Location', async () => {
    const response = await worker.fetch(request('/paypal/cancel?tab=x'), env, ctx)
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/?tab=x&cancelled=1')
    expectSecurityHeaders(response)
  })
})
