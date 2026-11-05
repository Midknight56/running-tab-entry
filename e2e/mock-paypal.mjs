// A stand in for the PayPal sandbox, for headless end to end runs only. It answers the calls Running Tab makes, with
// the shapes the real sandbox returned on day one (order 200 PAYER_ACTION_REQUIRED with a payer-action link; capture
// at purchase_units[0].payments.captures[0]), and serves a one button approval page.
import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_PAYPAL_PORT ?? 8799)
const orders = new Map()
const byRequestId = new Map()
let mode = { capture: 'ok' }
let n = 0

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'paypal-debug-id': 'mockdbg' + (++n), ...headers })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  let raw = ''
  for await (const c of req) raw += c
  const body = raw && req.headers['content-type']?.includes('json') ? JSON.parse(raw) : {}
  const rid = req.headers['paypal-request-id']
  const p = url.pathname
  if (rid && byRequestId.has(rid)) return send(res, ...byRequestId.get(rid))
  const remember = (status, b) => { if (rid) byRequestId.set(rid, [status, b]); return send(res, status, b) }

  if (p === '/__health') return send(res, 200, { ok: true })
  if (p === '/__mode') { mode = { ...mode, ...body }; return send(res, 200, mode) }
  if (p === '/v1/oauth2/token') return send(res, 200, { access_token: 'mock-token', expires_in: 32400 })
  if (p === '/v2/checkout/orders' && req.method === 'POST') {
    const id = 'MOCKORDER' + (orders.size + 1)
    const pu = body.purchase_units[0]
    if (body.payment_source.card) {
      if (mode.capture === 'fail') return send(res, 422, { name: 'UNPROCESSABLE_ENTITY', debug_id: 'mock422' })
      const c = { id: 'MOCKCAP' + (orders.size + 1), status: 'COMPLETED', amount: { currency_code: 'USD', value: pu.amount.value } }
      orders.set(id, { id, status: 'COMPLETED', value: pu.amount.value, ctx: {}, captures: [c] })
      return remember(201, { id, status: 'COMPLETED', purchase_units: [{ payments: { captures: [c] } }] })
    }
    const ctx = body.payment_source.paypal.experience_context
    orders.set(id, { id, status: 'PAYER_ACTION_REQUIRED', value: pu.amount.value, ctx, captures: [] })
    return remember(200, { id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'self', href: '' }, { rel: 'payer-action', href: `http://127.0.0.1:${PORT}/checkoutnow?token=${id}` }] })
  }
  if (p === '/checkoutnow') {
    const o = orders.get(url.searchParams.get('token'))
    if (!o) return send(res, 404, 'no order', { 'Content-Type': 'text/plain' })
    o.status = 'APPROVED'
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end(`<!doctype html><title>Sandbox approval</title><h1>Pay $${o.value}</h1>
      <a id="pay" href="${o.ctx.return_url}?token=${o.id}&PayerID=MOCKPAYER">Pay now</a>
      <a id="cancel" href="${o.ctx.cancel_url}">Cancel</a>`)
  }
  const cap = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(p)
  if (cap) {
    const o = orders.get(cap[1])
    if (!o) return send(res, 404, { name: 'RESOURCE_NOT_FOUND', debug_id: 'mock404' })
    if (mode.capture === 'fail') return send(res, 500, { name: 'INTERNAL_SERVER_ERROR', debug_id: 'mock500' })
    o.status = 'COMPLETED'
    const c = { id: 'MOCKCAP' + cap[1].replace('MOCKORDER', ''), status: 'COMPLETED', amount: { currency_code: 'USD', value: o.value } }
    o.captures = [c]
    return remember(201, { id: o.id, status: 'COMPLETED', purchase_units: [{ payments: { captures: [c] } }] })
  }
  const get = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(p)
  if (get) {
    const o = orders.get(get[1])
    if (!o) return send(res, 404, { name: 'RESOURCE_NOT_FOUND', debug_id: 'mock404' })
    return send(res, 200, { id: o.id, status: o.status, links: [{ rel: 'payer-action', href: `http://127.0.0.1:${PORT}/checkoutnow?token=${o.id}` }], purchase_units: [{ payments: { captures: o.captures } }] })
  }
  if (/^\/v2\/payments\/captures\/[^/]+\/refund$/.test(p)) return remember(201, { id: 'MOCKREFUND' + (++n), status: 'COMPLETED', amount: body.amount })
  if (p === '/v1/notifications/verify-webhook-signature') return send(res, 200, { verification_status: 'FAILURE' })
  return send(res, 404, { name: 'RESOURCE_NOT_FOUND', debug_id: 'mock404' })
}).listen(PORT, '127.0.0.1', () => console.log('mock paypal on', PORT))
