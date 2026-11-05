// Live check, run by hand: the whole loop on the hosted app, with the real PayPal sandbox and the real model.
//   node tests/live/hosted-loop.live.mjs [base]     (default https://running-tab.midknight-labs.workers.dev)
// It makes one workspace (one of the three a day for this network), runs the scripted agent, pays the tab with the
// sandbox test card, files the claim on call 24, and waits up to 120 s for PayPal's webhooks for the capture and the
// refund. It prints codes, ids and statuses, never a key. Cost: one demo run, about 28 neurons uncached.
const base = process.argv[2] ?? 'https://running-tab.midknight-labs.workers.dev'
let cookie = ''
async function call(path, body) {
  const url = new URL(base + path)
  const owner = process.env.RT_OWNER_KEY
  const cookies = [cookie, ...(owner && url.origin === new URL(base).origin ? [`rt_owner=${encodeURIComponent(owner)}`] : [])].filter(Boolean).join('; ')
  const r = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...(cookies ? { Cookie: cookies } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const set = r.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
const fail = (m) => { console.error('FAIL', m); process.exit(1) }

const s = await call('/api/session', {})
console.log('session', s.status)
if (s.status !== 200) fail('no workspace: ' + JSON.stringify(s.body))
const run = await call('/api/demo/run', {})
const struck = (run.body.steps ?? []).filter((x) => x.status === 'STRUCK').map((x) => `${x.n}:${x.reason_code}`)
console.log('run', run.status, 'steps', run.body.steps?.length, 'struck', struck.join(' '), 'due', run.body.due?.amount)
if (!run.body.due) fail('the tab never came due')
const tabId = new URL(run.body.due.pay_url).pathname.split('/').pop()
const pay = await call(`/api/sandbox/card-pay/${tabId}`, {})
console.log('card pay', pay.status, pay.body.kind)
if (pay.body.kind !== 'paid') fail('not paid: ' + JSON.stringify(pay.body))
const after = await call('/api/demo/run', { phase: 'after_pay' })
console.log('claim', after.status, after.body.claim?.state, after.body.claim?.refund_id)
console.log('explain cites', after.body.explain?.cited_call_ids, 'next call', after.body.next?.status)
for (let i = 0; i < 24; i++) {
  const d = await call('/api/desk/data')
  const ev = d.body.events ?? []
  const seen = ev.map((e) => `${e.event_type} ${e.verification} ${e.outcome}`)
  if (seen.some((x) => x.includes('REFUNDED SUCCESS')) && seen.some((x) => x.includes('COMPLETED SUCCESS'))) {
    console.log('webhooks', seen.join(' | '))
    console.log('money', JSON.stringify(d.body.money))
    process.exit(0)
  }
  await new Promise((r) => setTimeout(r, 5000))
}
fail('no verified webhooks for this capture and refund within 120 s')
