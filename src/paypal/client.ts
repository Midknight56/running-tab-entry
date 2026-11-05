// PayPal REST with the client credentials grant. The token is cached in this isolate and in KV until 600 s before it
// expires (authentication.md: "always read the expires_in field ... cache the token, and refresh proactively"). On a
// 401 both copies are dropped, one new token is fetched and the call is tried once more. Every POST carries a
// PayPal-Request-Id (authentication.md: "reuse the same value on retries"). Nothing here logs a token or a key.
import type { TraceRow } from '../trace'

export interface PayPalDeps {
  base: string
  clientId: string
  secret: string
  kv: KVNamespace
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** This isolate's copy of the token; tests pass their own map. */
  memory?: Map<string, CachedToken>
  trace?: (row: TraceRow) => void | Promise<void>
}

export interface CachedToken { token: string; until: number }

export interface PayPalResult<T = Record<string, any>> {
  status: number
  body: T
  debugId?: string
  name?: string
  requestId?: string
  bodyRead?: boolean
  /** A connection failed after a possible send before this response was read. */
  uncertainSend?: boolean
}

const KV_KEY = 'pp:token'
const EARLY_SECONDS = 600
const FETCH_TIMEOUT_MS = 15_000
const isolateTokens = new Map<string, CachedToken>()

export class PayPalClient {
  private memory: Map<string, CachedToken>
  private now: () => number
  private f: typeof fetch
  private sleep: (ms: number) => Promise<void>

  constructor(private d: PayPalDeps) {
    this.memory = d.memory ?? isolateTokens
    this.now = d.now ?? Date.now
    this.sleep = d.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.f = d.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  }

  async token(): Promise<string> {
    const mem = this.memory.get(this.d.clientId)
    if (mem && mem.until > this.now()) return mem.token
    const stored = await this.d.kv.get(KV_KEY)
    if (stored) {
      try {
        const c = JSON.parse(stored) as CachedToken
        if (c.until > this.now()) {
          this.memory.set(this.d.clientId, c)
          return c.token
        }
      } catch { /* a broken entry is replaced below */ }
    }
    const basic = btoa(`${this.d.clientId}:${this.d.secret}`)
    const r = await this.fetchWithRetry(this.d.base + '/v1/oauth2/token', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    })
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; name?: string; error?: string }
    if (r.status !== 200 || !j.access_token) {
      await this.d.trace?.({ kind: 'paypal', method_path: 'POST /v1/oauth2/token', http: r.status, paypal_debug_id: r.headers.get('paypal-debug-id') ?? undefined })
      throw new PayPalError(r.status, j.name ?? j.error ?? 'TOKEN_FAILED')
    }
    const life = Math.max(60, (j.expires_in ?? 0) - EARLY_SECONDS)
    const c: CachedToken = { token: j.access_token, until: this.now() + life * 1000 }
    this.memory.set(this.d.clientId, c)
    await this.d.kv.put(KV_KEY, JSON.stringify(c), { expirationTtl: life })
    return c.token
  }

  private async drop() {
    this.memory.delete(this.d.clientId)
    await this.d.kv.delete(KV_KEY)
  }

  async request<T = Record<string, any>>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string,
    opts: { body?: unknown; rawBody?: string; requestId?: string; wsId?: string } = {}): Promise<PayPalResult<T>> {
    const requestId = method === 'POST' ? opts.requestId ?? 'rt-' + crypto.randomUUID() : undefined
    let refreshed = false
    let retriedBusy = false
    let uncertainSend = false
    for (;;) {
      const headers: Record<string, string> = {
        Authorization: 'Bearer ' + (await this.token()),
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      }
      if (requestId) headers['PayPal-Request-Id'] = requestId
      const res = await this.fetchWithRetry(this.d.base + path, {
        method, headers, body: opts.rawBody ?? (opts.body === undefined ? (method === 'POST' ? '{}' : undefined) : JSON.stringify(opts.body)),
      }, () => { uncertainSend = true })
      let bodyTimer: ReturnType<typeof setTimeout> | undefined
      const text = await Promise.race([
        res.text(),
        new Promise<never>((_, reject) => { bodyTimer = setTimeout(() => reject(new Error('PayPal request timed out or failed')), FETCH_TIMEOUT_MS) }),
      ]).finally(() => { if (bodyTimer) clearTimeout(bodyTimer) })
      let body: any = {}
      let bodyRead = false
      try {
        if (text) {
          const parsed = JSON.parse(text)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { body = parsed; bodyRead = true }
        }
      } catch { body = {} }
      const debugId = body?.debug_id ?? res.headers.get('paypal-debug-id') ?? undefined
      const out: PayPalResult<T> = { status: res.status, body, debugId, name: body?.name, requestId, bodyRead }
      if (uncertainSend) out.uncertainSend = true
      await this.d.trace?.({
        kind: 'paypal', method_path: `${method} ${path}`, http: res.status, paypal_debug_id: debugId, request_id: requestId,
        ids: pickIds(body), ws_id: opts.wsId,
      })
      if (res.status === 401 && !refreshed) {
        refreshed = true
        await this.drop()
        continue
      }
      if (res.status === 429 && !retriedBusy) {
        retriedBusy = true
        const retryAfter = res.headers.get('Retry-After')
        const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN
        const ms = Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 5000) : 1500
        await this.sleep(ms)
        continue
      }
      return out
    }
  }

  /** One retry, with the same request id, when the connection itself fails. */
  private async fetchWithRetry(url: string, init: RequestInit, onUncertain?: () => void): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      try {
        return await this.f(url, { ...init, signal: controller.signal })
      } catch (error) {
        onUncertain?.()
        if (attempt === 1) throw new Error('PayPal request timed out or failed')
      } finally {
        clearTimeout(timer)
      }
    }
    throw new Error('PayPal request timed out or failed')
  }
}

export class PayPalError extends Error {
  constructor(public status: number, public paypalName: string, public debugId?: string) {
    super(`PayPal ${status} ${paypalName}`)
  }
}

/** The ids and statuses worth showing on the panel. Never amounts of anything secret, never the body. */
export function pickIds(body: any): Record<string, string> {
  const ids: Record<string, string> = {}
  if (!body || typeof body !== 'object') return ids
  if (typeof body.id === 'string') ids.id = body.id
  if (typeof body.status === 'string') ids.status = body.status
  if (typeof body.name === 'string') ids.name = body.name
  const cap = body.purchase_units?.[0]?.payments?.captures?.[0]
  if (cap?.id) { ids.capture_id = cap.id; ids.capture_status = cap.status }
  if (typeof body.verification_status === 'string') ids.verification_status = body.verification_status
  return ids
}

export { cents, toCents } from '../tab/pricing'
