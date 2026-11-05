# The Running Tab add on

Billing for MCP tools on Cloudflare Workers, built on [mcp-on-workers](https://github.com/Midknight56/mcp-on-workers).
The core imports only this folder and the kit. The optional `src/tab/paypal.ts` barrel connects the payment and claim modules in this repo.

## What it does

`withTab(tool, { price_cents })` wraps a kit tool. On each call it:

1. finds the calling agent's open tab (one per agent, made on the first call);
2. answers `TAB_DUE` with a pay link if that tab is due, and does not run the tool;
3. runs the tool and logs the call with its price in cents;
4. strikes plainly broken answers by code: an error (`ERROR`), an empty answer (`EMPTY`), or an answer that fails the
   tool's `outputSchema` (`SHAPE`). A struck call is never billed;
5. for tools marked `audit: "model"`, asks your auditor whether the answer addresses the request. A call the auditor
   could not settle stays `PENDING_AUDIT` and is not billed;
6. adds a billable call to the tab, and marks the tab due once it reaches its threshold. The call that crosses the
   threshold is served.

The answer carries the call's number, price and the tab's state in `_meta["running-tab/call"]`.

Pass `requires: (args, answer) => string | null` to check required parts after the existing code rules and before the model: return `null` when complete, or a short phrase naming the missing part to strike it as `INCOMPLETE` by code without a model call.
If `requires` throws, normal auditing and billing continue.

`agentTools` adds three free tools for the agent: `my_tab`, `explain_bill` and `report_bad_answer`.

## Use

See `examples/minimal-worker.ts`:

```ts
tools: [withTab(hello, { price_cents: 2 }), ...agentTools],
context: async (req) => ({ tab: { db: env.DB, agent: await agentFromRequest(env.DB, req), origin, thresholdCents: 500 } }),
```

The tables are in `migrations/0001_init.sql`. Agents send `Authorization: Bearer <key>`; only the key's sha256 is stored.

## Install in your own server

Import `withTab` and `agentFromRequest` from `src/tab`. Wrap only tools that should cost money. A tool without `withTab` stays free, including when the tab is due. The context supplies the D1 database, the agent from the request, the public origin for pay links, and the tab threshold in cents. Apply the D1 tables from [`migrations/0001_init.sql`](../../migrations/0001_init.sql) and later migrations in order.

This complete server has one priced tool and one free tool. Its tab comes due at 3 cents, so one priced call is enough
to see the free tool still answer while the priced one waits for payment:

```ts
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
```

## Getting paid

The example now holds the whole loop: priced calls, free `my_tab` and `report_bad_answer` tools, the
`/pay/{tab_id}` redirect, capture at `/paypal/return`, and verified delivery at `/paypal/webhook`.
Payment resumes priced calls. An upheld claim uses the existing refund limits and refunds that call's price once.

Bind `DB` and `RT_KV`, set `SESSION_SECRET`, and configure these PayPal values:

```toml
PAYPAL_BASE = "https://api-m.sandbox.paypal.com"
PAYPAL_CLIENT_ID = "your sandbox client id"
PAYPAL_WEBHOOK_ID = "your sandbox webhook id"
```

Set `PAYPAL_CLIENT_SECRET` and `SELLER_KEY` as Worker secrets. Use at least 32 characters for `SELLER_KEY`.
Set `SELLER_WORKSPACE_ID` to the workspace stored on this seller's agent rows. Agent requests must belong to that workspace.
Send `Authorization: Bearer <SELLER_KEY>` to `GET /seller/claims` to list up to 50 waiting claims, newest first.
Send the same header to `POST /seller/claims/{id}/approve` to approve a refund. A claim outside the workspace returns 404.
Approval returns the claim with 200, or a reason name with 409 when it cannot proceed.
Register `/paypal/webhook` for the seller's PayPal app.
Pass a `judge` function to `createSeller` to review claims against the logged answer. For example:

```ts
const judge: ClaimDeps['judge'] = async (_reason, claimed) => {
  try {
    const answer = JSON.parse(claimed.result_json)
    const empty = !answer.content?.length && answer.structuredContent == null
    if (answer.isError === true || empty) {
      return { approve: true, reason_code: 'INCOMPLETE', evidence: claimed.result_json.slice(0, 300), cited_seqs: [claimed.seq] }
    }
  } catch {
    return null
  }
  return null
}

export default createSeller({ judge })
```

This judge approves an empty answer or a reported error. Other claims wait for seller review.
Without a usable verdict, claims wait for the seller. The default 3 cent tab demonstrates payment after one call;
a refund of that whole capture waits for seller approval under the existing 20 percent automatic refund limit.
The optional barrel depends on `src/bill`, `src/paypal`, `src/claims`, and their imports; keep these with the example.
