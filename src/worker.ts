// The routes. Static files (the desk) are served by the assets binding; these paths run the Worker first.
import type { Env } from './env'
import { paypal, refundLimitedPayPal, sellerServer, noteFor, visitorHash, ORDERS_PER_IP_PER_DAY, ORDERS_PER_MINUTE_ALL, isOwner, clientIp, claimFor } from './app'
import { receiveWebhook } from './paypal/webhooks'
import { completeReturn, payWithTestCard, startPayment } from './bill/settle'
import { approveBySeller, MAX_CLAIM_CHARS } from './claims/claims'
import { reconcileWorkspaceRefunds } from './claims/refund'
import { makeClaimJudge } from './claims/judge'
import { gate } from './app'
import { getOrder } from './paypal/orders'
import { budgetError, type BudgetInput } from './tab/budgets'
import { getTab, newId, sealAgent, verifyLedger } from './tab/ledger'
import { McpClient, runAfterPay, runCalls } from './demo/agent'
import { deskData } from './desk-data'
import { studioProxy } from './studio'
import { askDesk } from './desk-ask'
import { readReport } from './desk-report'
import { CONNECT_KEYS_PER_WORKSPACE, KEY_HOURS, sha256Hex, agentKey, bump, createWorkspace, deleteOldWorkspaces, readCookie, signWs, takeRun, verifyWs } from './demo/workspace'
import { utcDay } from './ai/budget'
import { dollars } from './tab/pricing'
import { fakeAi, useFakeAi } from './dev/fake-ai'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } })

const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: to } })

function secure(res: Response): Response {
  const response = new Response(res.body, res)
  const headers = response.headers
  if (!headers.has('X-Content-Type-Options')) headers.set('X-Content-Type-Options', 'nosniff')
  if (!headers.has('Referrer-Policy')) headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  if (!headers.has('Permissions-Policy')) headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  // AG Studio injects styles at runtime, so this policy intentionally has no script-src or default-src.
  if (!headers.has('Content-Security-Policy')) headers.set('Content-Security-Policy', "frame-ancestors 'none'")
  return response
}

async function workspaceOf(env: Env, request: Request): Promise<string | null> {
  const wsId = await verifyWs(env.SESSION_SECRET, readCookie(request, 'rt_ws'))
  if (!wsId) return null
  const row = await env.DB.prepare('SELECT id FROM workspaces WHERE id = ?').bind(wsId).first<string>('id')
  return row ?? null
}

const orderReads = new WeakMap<D1Database, Map<string, Promise<string | null>>>()

async function orderHash(env: Env, wsId: string, orderId: string, now: number): Promise<string | null> {
  let pending = orderReads.get(env.DB)
  if (!pending) { pending = new Map(); orderReads.set(env.DB, pending) }
  const existing = pending.get(orderId)
  if (existing) return existing
  const read = (async () => {
    const cacheKey = `order-hash:${orderId}`
    const cached = await env.DB.prepare('SELECT value_json FROM cache WHERE key = ?').bind(cacheKey).first<string>('value_json')
    if (cached !== null) return JSON.parse(cached) as string | null
    const result = await getOrder(paypal(env, wsId), orderId, wsId)
    if (result.status !== 200) throw new Error('Order unavailable')
    const customId: string | null = result.body?.purchase_units?.[0]?.custom_id ?? null
    await env.DB.prepare('INSERT OR REPLACE INTO cache (key, value_json, at) VALUES (?, ?, ?)')
      .bind(cacheKey, JSON.stringify(customId), now).run()
    return customId
  })()
  pending.set(orderId, read)
  try { return await read }
  finally { pending.delete(orderId) }
}

export async function handle(request: Request, envIn: Env, ctx: ExecutionContext, now: () => number = Date.now): Promise<Response> {
  const env: Env = useFakeAi(envIn, request) ? { ...envIn, AI: fakeAi, AI_MODE: 'live' } : envIn
  const url = new URL(request.url)
  const path = url.pathname
  const m = request.method

  if (path === '/health') return json({ ok: true, commit: env.GIT_COMMIT ?? 'dev', ai_mode: env.AI_MODE })

  if (path === '/mcp' || path === '/mcp/') return sellerServer(env, now).handle(request)

  if (path === '/webhooks/paypal' && m === 'POST') {
    return receiveWebhook(request, { db: env.DB, pp: paypal(env), webhookId: env.PAYPAL_WEBHOOK_ID, now, signingKey: env.LEDGER_SIGNING_KEY }, (p) => ctx.waitUntil(p))
  }

  if (path === '/api/session' && m === 'POST') {
    const existing = await workspaceOf(env, request)
    if (existing) return json({ ws_id: existing, agents: await agentsWithKeys(env, existing) })
    const r = await createWorkspace(env.DB, { ipHash: await visitorHash(env, request, now()), secret: env.SESSION_SECRET, now: now(), owner: await isOwner(env, request) })
    if (!r.ok) return json({ error: r.reason }, 429)
    const cookie = `rt_ws=${encodeURIComponent(await signWs(env.SESSION_SECRET, r.ws_id))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`
    return json({ ws_id: r.ws_id, agents: r.agents }, 200, { 'Set-Cookie': cookie })
  }

  if (path.startsWith('/api/')) {
    const wsId = await workspaceOf(env, request)
    if (!wsId) return json({ error: 'Start a demo workspace first.' }, 401)

    if (path === '/api/connect' && m === 'POST') {
      let body: unknown
      try { body = await request.text(); body = body ? JSON.parse(body as string) : {} }
      catch { return json({ error: 'Budget must be valid JSON.' }, 400) }
      const error = budgetError(body)
      if (error) return json({ error }, 400)
      const budget = body as BudgetInput
      const bytes = crypto.getRandomValues(new Uint8Array(32))
      const key = 'rt_agent_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
      const id = newId('agt')
      const expires = now() + KEY_HOURS * 60 * 60 * 1000
      const result = await env.DB.prepare(`INSERT INTO agents (id, ws_id, name, key_hash, created_at, kind, expires_at, budget_month_cents, budget_call_cents)
        SELECT ?1, ?2, CASE WHEN COUNT(*) = 0 THEN 'Your agent' ELSE 'Your agent ' || (COUNT(*) + 1) END,
          ?3, ?4, 'judge', ?5, ?7, ?8 FROM agents WHERE ws_id = ?2 AND kind = 'judge' HAVING COUNT(*) < ?6`)
        .bind(id, wsId, await sha256Hex(key), now(), expires, CONNECT_KEYS_PER_WORKSPACE, budget.monthly_cents ?? null, budget.max_call_cents ?? null).run()
      if (!result.meta.changes) return json({ error: 'Two agent keys per demo desk. Start a new desk tomorrow.' }, 429)
      const name = await env.DB.prepare('SELECT name FROM agents WHERE id = ?').bind(id).first<string>('name')
      return json({ agent_id: id, name, key, expires_at: expires, mcp_url: `${url.origin}/mcp` })
    }

    if (path === '/api/desk/data' && m === 'GET') {
      await reconcileWorkspaceRefunds(env.DB, refundLimitedPayPal(env, await visitorHash(env, request, now()), wsId, now), wsId, now(), env.LEDGER_SIGNING_KEY)
      return json(await deskData(env.DB, wsId))
    }

    if (path === '/api/desk/report' && m === 'GET') {
      const state = await env.DB.prepare('SELECT state_json FROM desk_reports WHERE ws_id = ?').bind(wsId).first<string>('state_json')
      return state === null ? new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }) : json(JSON.parse(state))
    }
    if (path === '/api/desk/report' && m === 'PUT') {
      const state = await readReport(request)
      if (state === null) return json({ error: 'Layout must be a JSON object with a pages array and under 100 KB.' }, 400)
      await env.DB.prepare(`INSERT INTO desk_reports (ws_id, state_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(ws_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`)
        .bind(wsId, state, now()).run()
      return json({ ok: true })
    }

    const tryCounter = `ws:${wsId}:${utcDay(now())}:claim-tries`
    if (path === '/api/claims/try' && m === 'GET') {
      const used = await env.DB.prepare('SELECT n FROM counters WHERE key = ?').bind(tryCounter).first<number>('n')
      return json({ tries_left: Math.max(0, 5 - (used ?? 0)) })
    }
    if (path === '/api/claims/try' && m === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { call_id?: unknown; reason?: unknown } | null
      const callId = typeof body?.call_id === 'string' ? body.call_id : ''
      const call = await env.DB.prepare(`SELECT c.id, c.seq, c.agent_id FROM calls c
        JOIN tabs t ON t.id = c.tab_id AND t.ws_id = c.ws_id AND t.agent_id = c.agent_id
        JOIN agents a ON a.id = c.agent_id AND a.ws_id = c.ws_id
        WHERE c.id = ? AND c.ws_id = ? AND c.status IN ('BILLABLE', 'REFUNDED')
          AND t.state = 'PAID' AND (t.note IS NULL OR t.note <> 'demo history')`)
        .bind(callId, wsId).first<{ id: string; seq: number; agent_id: string }>()
      if (!call) return json({ error: 'That is not one of your paid calls.' }, 404)
      const agent = await env.DB.prepare('SELECT id, ws_id, name FROM agents WHERE id = ? AND ws_id = ?')
        .bind(call.agent_id, wsId).first<{ id: string; ws_id: string; name: string }>()
      if (!agent) return json({ error: 'That is not one of your paid calls.' }, 404)
      if (!(await bump(env.DB, tryCounter, 5))) {
        return json({ error: 'Five claim tries per workspace a day. Try again tomorrow.', tries_left: 0 }, 429)
      }
      const reason = String(body?.reason ?? '').trim().slice(0, MAX_CLAIM_CHARS)
      const visitor = await visitorHash(env, request, now())
      const result = await claimFor(env, gate(env, visitor, wsId, now), visitor, agent, call.seq, reason, now)
      const used = await env.DB.prepare('SELECT n FROM counters WHERE key = ?').bind(tryCounter).first<number>('n')
      return json({
        state: result.state, message: result.message, refund_id: result.refund_id ?? undefined,
        evidence: result.evidence ?? undefined, reason_code: result.reason_code ?? undefined,
        verdict: result.verdict ?? undefined, tries_left: Math.max(0, 5 - (used ?? 0)),
      })
    }

    const ledgerVerify = /^\/api\/ledger\/verify\/([\w-]+)$/.exec(path)
    if (ledgerVerify && m === 'GET') {
      const id = decodeURIComponent(ledgerVerify[1])
      const agent = await env.DB.prepare('SELECT id FROM agents WHERE ws_id = ? AND id = ?').bind(wsId, id).first<{ id: string }>()
        ?? await env.DB.prepare('SELECT agent_id AS id FROM tabs WHERE ws_id = ? AND id = ?').bind(wsId, id).first<{ id: string }>()
      if (!agent) return json({ error: 'No such agent or tab.' }, 404)
      await sealAgent(env.DB, agent.id, env.LEDGER_SIGNING_KEY)
      const { call_hashes: callHashes, ...verified } = await verifyLedger(env.DB, agent.id, env.LEDGER_SIGNING_KEY)
      const paid = await env.DB.prepare(`SELECT id, order_id FROM tabs WHERE agent_id = ? AND ws_id = ?
        AND state = 'PAID' AND order_id IS NOT NULL ORDER BY paid_at DESC, created_at DESC LIMIT 1`)
        .bind(agent.id, wsId).first<{ id: string; order_id: string }>()
      if (!paid) return json(verified)
      const last = await env.DB.prepare('SELECT id FROM calls WHERE tab_id = ? ORDER BY seq DESC LIMIT 1').bind(paid.id).first<{ id: string }>()
      const ledgerHash = last ? callHashes[last.id] ?? null : null
      try {
        const customId = await orderHash(env, wsId, paid.order_id, now())
        return json({ ...verified, order: { id: paid.order_id, custom_id: customId, ledger_hash: ledgerHash, matches: ledgerHash !== null && customId === `rt:${ledgerHash}` } })
      } catch {
        return json({ ...verified, order: { id: paid.order_id, matches: null, error: 'PayPal did not answer' } })
      }
    }

    if (path === '/api/demo/run' && m === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { phase?: string }
      const agent = await env.DB.prepare("SELECT id, name FROM agents WHERE ws_id = ? ORDER BY created_at, name LIMIT 1").bind(wsId).first<{ id: string; name: string }>()
      if (!agent) return json({ error: 'No agent.' }, 400)
      const client = new McpClient((r) => sellerServer(env, now).handle(r), `${url.origin}/mcp`, await agentKey(env.SESSION_SECRET, agent.id),
        { 'CF-Connecting-IP': clientIp(request) })
      if (body.phase === 'after_pay') {
        const paid = await env.DB.prepare("SELECT total_cents FROM tabs WHERE agent_id = ? AND state = 'PAID' AND note IS NOT 'demo history' ORDER BY paid_at DESC LIMIT 1").bind(agent.id).first<number>('total_cents')
        if (paid === null) return json({ error: 'Pay the tab first.' }, 409)
        return json(await runAfterPay(client, `Why did I pay ${dollars(paid)}?`))
      }
      if (!(await takeRun(env.DB, wsId))) return json({ error: 'Five demo runs per workspace. Start a new one tomorrow.' }, 429)
      const done = await env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM calls WHERE agent_id = ?').bind(agent.id).first<number>('n')
      return json(await runCalls(client, undefined, (done ?? 0) + 1))
    }

    const card = /^\/api\/sandbox\/card-pay\/(tab_[0-9a-f]+)$/.exec(path)
    if (card && m === 'POST') {
      const tab = await getTab(env.DB, card[1])
      if (!tab || tab.ws_id !== wsId) return json({ error: 'No such tab.' }, 404)
      const visitor = await visitorHash(env, request, now())
      if (tab.state === 'DUE' && !tab.order_id) {
        const error = await orderLimit(env, request, now())
        if (error) return json({ error }, 429)
      }
      try {
        const r = await payWithTestCard({ db: env.DB, pp: paypal(env, wsId), origin: url.origin, now, signingKey: env.LEDGER_SIGNING_KEY, note: (t) => noteFor(env, visitor, t, now) }, tab.id, env.PAYPAL_BASE)
        if (r.kind === 'refused' && r.http === 429) return json({ error: r.reason }, 429)
        return json(r, r.kind === 'paid' ? 200 : 409)
      } catch {
        return json({ error: 'PayPal did not answer in time. Try again.' }, 502)
      }
    }

    const approve = /^\/api\/claims\/([\w-]+)\/approve$/.exec(path)
    if (approve && m === 'POST') {
      const claim = await env.DB.prepare('SELECT id FROM claims WHERE id = ? AND ws_id = ?').bind(approve[1], wsId).first<{ id: string }>()
      if (!claim) return json({ error: 'No such claim.' }, 404)
      const visitor = await visitorHash(env, request, now())
      const r = await approveBySeller({ db: env.DB, pp: refundLimitedPayPal(env, visitor, wsId, now), judge: makeClaimJudge(gate(env, visitor, wsId, now)), now, signingKey: env.LEDGER_SIGNING_KEY }, wsId, approve[1])
      if (r.name === 'DEMO_REFUND_LIMIT') return json({ error: 'Ten refunds a day from one network. Try again tomorrow.' }, 429)
      return json(r, r.ok ? 200 : 409)
    }

    if (path === '/api/desk/ask' && m === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { question?: string }
      const r = await askDesk(gate(env, await visitorHash(env, request, now()), wsId, now), String(body.question ?? ''))
      return json(r, r.ok ? 200 : r.busy ? 429 : 422)
    }

    if (path === '/api/studio/llm' && m === 'POST') return studioProxy(request, env, wsId, await visitorHash(env, request, now()), now)

    if (path === '/api/debug/events' && m === 'GET') {
      if (!env.DEBUG_SECRET || request.headers.get('X-Debug-Secret') !== env.DEBUG_SECRET) return json({ error: 'no' }, 403)
      const rows = await env.DB.prepare('SELECT id, event_type, verification, resource_id, outcome, received_at FROM events ORDER BY received_at DESC LIMIT 20').all()
      return json(rows.results)
    }
    return json({ error: 'Not found.' }, 404)
  }

  const pay = /^\/pay\/(tab_[0-9a-f]+)$/.exec(path)
  if (pay && m === 'GET') {
    const tab = await getTab(env.DB, pay[1])
    if (tab && tab.state === 'DUE' && !tab.order_id) {
      const error = await orderLimit(env, request, now())
      if (error) return page(error, 429)
    }
    const visitor = await visitorHash(env, request, now())
    try {
      // The first order was counted above. Count every fresh replacement too.
      const r = await startPayment({ db: env.DB, pp: paypal(env, tab?.ws_id), origin: url.origin, now, signingKey: env.LEDGER_SIGNING_KEY,
        note: (t) => noteFor(env, visitor, t, now), beforeOrder: () => tab?.order_id ? orderLimit(env, request, now()) : Promise.resolve(null) }, pay[1])
      if (r.kind === 'redirect') return redirect(r.url)
      if (r.kind === 'paid') return redirect(`/?tab=${r.tab_id}&paid=1`)
      return page(r.reason, r.http === 429 ? 429 : 409)
    } catch {
      return page('PayPal did not answer in time. Try again.', 502)
    }
  }

  if (path === '/paypal/return' && m === 'GET') {
    const orderId = url.searchParams.get('token')
    if (!orderId) return page('PayPal sent no order.', 400)
    try {
      const r = await completeReturn({ db: env.DB, pp: paypal(env), origin: url.origin, now }, orderId)
      if (r.kind === 'paid') return redirect(`/?tab=${r.tab_id}&paid=1`)
      if (r.kind === 'failed' && r.http === 409) return page(r.reason ?? 'Payment is in progress.', 409)
      if (r.kind === 'failed') return redirect(`/?tab=${r.tab_id}&pay_failed=1`)
      return page('That order is not one of ours.', 404)
    } catch {
      return page('PayPal did not answer in time. Try again.', 502)
    }
  }

  if (path === '/paypal/cancel' && m === 'GET') {
    const tab = url.searchParams.get('tab') ?? ''
    return redirect(`/?tab=${encodeURIComponent(tab)}&cancelled=1`)
  }

  if (path === '/desk/config') return json({ ag_studio_license: env.AG_STUDIO_LICENSE ?? null })

  return env.ASSETS.fetch(request)
}

async function orderLimit(env: Env, request: Request, now: number): Promise<string | null> {
  const owner = await isOwner(env, request)
  const visitor = await visitorHash(env, request, now)
  if (!(await bump(env.DB, `ip:${visitor}:${utcDay(now)}:order`, owner ? undefined : ORDERS_PER_IP_PER_DAY))) {
    return 'Twenty PayPal orders a day from one network in this demo. Try again tomorrow.'
  }
  if (!(await bump(env.DB, `all:${new Date(now).toISOString().slice(0, 16)}:order`, ORDERS_PER_MINUTE_ALL))) {
    return 'Many people are paying right now. Try again in a minute.'
  }
  return null
}

async function agentsWithKeys(env: Env, wsId: string) {
  const rows = (await env.DB.prepare("SELECT id, name FROM agents WHERE ws_id = ? AND kind = 'demo' ORDER BY created_at, name").bind(wsId).all<{ id: string; name: string }>()).results
  return Promise.all(rows.map(async (a) => ({ ...a, key: await agentKey(env.SESSION_SECRET, a.id) })))
}

export function page(message: string, status: number) {
  const safe = message.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Running Tab</title>
<style>
body { margin: 0; padding: 0 16px; background: #f4f5f6; color: #1d2125; font: 15px/1.4 system-ui; }
main { box-sizing: border-box; max-width: 480px; margin: 48px auto; padding: 16px; background: #ffffff; border: 1px solid #dde1e5; border-radius: 8px; overflow-wrap: anywhere; }
h1 { font-size: 18px; margin: 0; }
a { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 8px 14px; border-radius: 8px; background: #0f766e; color: #ffffff; text-decoration: none; }
@media (prefers-color-scheme: dark) {
  body { background: #15181b; color: #e6e8ea; }
  main { background: #1d2125; border-color: #30363c; }
  a { background: #2dd4bf; color: #0b1214; }
}
</style><body><main><h1>Running Tab</h1><p>${safe}</p><a href="/">Back to the desk</a></main></body>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) => secure(await handle(request, env, ctx)),
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      const agents = (await env.DB.prepare('SELECT id FROM agents').all<{ id: string }>()).results
      await Promise.all(agents.map((agent) => sealAgent(env.DB, agent.id, env.LEDGER_SIGNING_KEY)))
      await deleteOldWorkspaces(env.DB, Date.now())
      // Self check: a token and one GET; both land in the trace table under no workspace.
      await paypal(env).request('GET', '/v2/checkout/orders/RT-SELF-CHECK').catch(() => undefined)
    })())
  },
}
