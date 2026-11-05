// Live check, run by hand: a real tab through MCP, then a real PayPal sandbox order made by the app.
//   node tests/live/settle.live.mjs [base]        (default http://127.0.0.1:8791)
// It uses business_days only (code audited), so it needs no model. It prints codes and ids, never a key.
const base = process.argv[2] ?? 'http://127.0.0.1:8791'

const s = await fetch(base + '/api/session', { method: 'POST' })
const cookie = (s.headers.get('set-cookie') ?? '').split(';')[0]
const session = await s.json()
console.log('POST /api/session', s.status, 'agents', session.agents?.length)
const key = session.agents[0].key

let sid = ''
let id = 0
async function rpc(method, params) {
  const r = await fetch(base + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, ...(sid ? { 'MCP-Session-Id': sid } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  })
  sid = r.headers.get('mcp-session-id') ?? sid
  return (await r.json()).result
}
await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'live-check', version: '1' } })

let due
for (let i = 0; i < 120 && !due; i++) {
  const r = await rpc('tools/call', { name: 'business_days', arguments: { start: '2026-10-20', end: '2026-10-27' } })
  if (r.structuredContent?.code === 'TAB_DUE') due = r.structuredContent
}
console.log('TAB_DUE', due ? `${due.amount} ${due.tab_id}` : 'never')
if (!due) process.exit(1)

const pay = await fetch(new URL(new URL(due.pay_url).pathname, base), { redirect: 'manual', headers: { Cookie: cookie } })
console.log('GET /pay/{tab}', pay.status, '->', pay.headers.get('location'))

const desk = await (await fetch(base + '/api/desk/data', { headers: { Cookie: cookie } })).json()
const tab = desk.tabs.find((t) => t.id === due.tab_id)
console.log('tab', tab.state, 'order', tab.order_id)
for (const t of desk.trace.filter((x) => x.kind === 'paypal').reverse()) {
  console.log('trace', t.method_path, t.http, 'debug_id', t.paypal_debug_id, 'request id', t.request_id, t.ids_json)
}
