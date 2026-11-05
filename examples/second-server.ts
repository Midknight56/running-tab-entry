import { McpServer, type Tool } from 'mcp-on-workers'
import { agentFromRequest, myTab, reportBadAnswer, withTab, type TabCtx } from '../src/tab'
import { PayPalClient, startPayment, completeReturn, receiveWebhook, fileClaim, approveBySeller, type ClaimDeps } from '../src/tab/paypal'

const toMeters: Tool<TabCtx> = {
  name: 'convert_units',
  title: 'Convert units',
  description: 'Convert kilometers to meters.',
  inputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
  async run(args) {
    const value = Number(args.value) * 1000
    return { content: [{ type: 'text', text: `${value} m` }], structuredContent: { value } }
  },
}

const toFahrenheit: Tool<TabCtx> = {
  name: 'convert_temperature',
  title: 'Convert temperature',
  description: 'Convert Celsius to Fahrenheit, free.',
  inputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
  async run(args) {
    const value = (Number(args.value) * 9) / 5 + 32
    return { content: [{ type: 'text', text: `${value} F` }], structuredContent: { value } }
  },
}

interface Env {
  DB: D1Database
  RT_KV: KVNamespace
  SELLER_KEY?: string
  SELLER_WORKSPACE_ID: string
  SESSION_SECRET: string
  PAYPAL_BASE: string
  PAYPAL_CLIENT_ID: string
  PAYPAL_CLIENT_SECRET: string
  PAYPAL_WEBHOOK_ID: string
}

async function sellerAuthorized(request: Request, secret?: string): Promise<boolean> {
  const auth = request.headers.get('Authorization') ?? ''
  if (!secret || secret.length < 32 || !auth.startsWith('Bearer ')) return false
  const bytes = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', bytes.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  // Native signature verification compares the fixed size signatures in constant time.
  const signature = await crypto.subtle.sign('HMAC', key, bytes.encode(auth.slice(7)))
  return crypto.subtle.verify('HMAC', key, signature, bytes.encode(secret))
}

export function createSeller(options: { judge?: ClaimDeps['judge'] } = {}) {
  return {
    async fetch(request: Request, env: Env) {
      const url = new URL(request.url)
      const pp = new PayPalClient({ base: env.PAYPAL_BASE, clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET, kv: env.RT_KV })
      const approve = url.pathname.match(/^\/seller\/claims\/([^/]+)\/approve$/)
      if ((request.method === 'GET' && url.pathname === '/seller/claims') || (request.method === 'POST' && approve)) {
        if (!await sellerAuthorized(request, env.SELLER_KEY)) return new Response('Unauthorized.', { status: 401 })
        if (!env.SELLER_WORKSPACE_ID) return new Response('Seller workspace is not configured.', { status: 503 })
        if (approve) {
          const claim = await env.DB.prepare('SELECT id FROM claims WHERE id = ? AND ws_id = ?')
            .bind(approve[1], env.SELLER_WORKSPACE_ID).first()
          if (!claim) return new Response('Not found.', { status: 404 })
          const result = await approveBySeller({ db: env.DB, pp, judge: options.judge ?? (async () => null) }, env.SELLER_WORKSPACE_ID, approve[1])
          return result.ok ? Response.json(result.claim) : Response.json({ name: result.name }, { status: 409 })
        }
        const claims = await env.DB.prepare(`SELECT claims.id, calls.seq, calls.tool, calls.price_cents, claims.reason_text, claims.created_at
          FROM claims JOIN calls ON calls.id = claims.call_id AND calls.ws_id = claims.ws_id
          WHERE claims.ws_id = ? AND (claims.state = 'WAITING_SELLER' OR claims.state = 'APPROVED' AND claims.refund_status LIKE 'FAILED%')
          ORDER BY claims.created_at DESC, claims.id DESC LIMIT 50`).bind(env.SELLER_WORKSPACE_ID).all()
        return Response.json(claims.results)
      }
      const payment = { db: env.DB, pp, origin: url.origin }
      const paid = () => new Response('Paid. Your agent can carry on.')
      const pay = url.pathname.match(/^\/pay\/([^/]+)$/)
      if (request.method === 'GET' && pay) {
        const result = await startPayment(payment, pay[1])
        if (result.kind === 'redirect') return Response.redirect(result.url, 302)
        return result.kind === 'paid' ? paid() : new Response(result.reason, { status: 400 })
      }
      if (request.method === 'GET' && url.pathname === '/paypal/return') {
        const result = await completeReturn(payment, url.searchParams.get('token') ?? '')
        return result.kind === 'paid' ? paid() : new Response('Payment was not completed.', { status: 400 })
      }
      if (request.method === 'POST' && url.pathname === '/paypal/webhook') {
        const pending: Promise<unknown>[] = []
        const response = await receiveWebhook(request, { db: env.DB, pp, webhookId: env.PAYPAL_WEBHOOK_ID }, p => { pending.push(p) })
        await Promise.all(pending)
        return response
      }
      if (request.method !== 'POST' || url.pathname !== '/mcp') return new Response('Not found.', { status: 404 })
      return new McpServer<TabCtx>({
        info: { name: 'unit-tools', title: 'Unit tools', version: '1.0.0' },
        secret: env.SESSION_SECRET,
        allowOrigin: () => false,
        tools: [withTab(toMeters, { price_cents: 3 }), toFahrenheit, myTab, reportBadAnswer],
        context: async (req) => {
          const agent = await agentFromRequest(env.DB, req)
          if (!env.SELLER_WORKSPACE_ID || agent.ws_id !== env.SELLER_WORKSPACE_ID) throw new Error('Unknown agent key.')
          return {
            tab: {
              db: env.DB, agent, origin: url.origin, thresholdCents: 3,
              claim: async (agent, seq, reason) => {
                // Without a judge, claims wait for the seller.
                const { claim, message } = await fileClaim({ db: env.DB, pp, judge: options.judge ?? (async () => null) }, agent, seq, reason)
                return { message, state: claim.state, refund_id: claim.refund_id }
              },
            },
          }
        },
      }).handle(request)
    },
  }
}

export default createSeller()
