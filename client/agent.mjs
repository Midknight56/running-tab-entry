import { pathToFileURL } from 'node:url'

const ct = (time, from, to) => ({ tool: 'convert_time', args: { time, date: '2026-10-23', from, to } })
const bd = (start, end) => ({ tool: 'business_days', args: { start, end } })
const script = [
  ct('09:00', 'America/Halifax', 'Europe/London'), bd('2026-10-20', '2026-10-27'),
  ct('14:30', 'America/New_York', 'Asia/Tokyo'), ct('08:15', 'Europe/Berlin', 'America/Los_Angeles'),
  bd('2026-11-02', '2026-11-16'), ct('17:45', 'Australia/Sydney', 'Europe/Paris'),
  ct('12:00', 'Asia/Kolkata', 'America/Chicago'), bd('2026-12-01', '2026-12-08'),
]
const money = cents => `$${(cents / 100).toFixed(2)}`

export async function run(argv, { fetch = globalThis.fetch, log = console.log, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let sid = ''
  let id = 0
  try {
    const options = {}
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i]
      if (flag === '--wait') options.wait = true
      else if (['--url', '--key', '--calls'].includes(flag) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[flag.slice(2)] = argv[++i]
      else throw new Error('Usage: node client/agent.mjs --url <mcp url> --key <key> [--calls 34] [--wait]')
    }
    const calls = Number(options.calls ?? 34)
    if (!options.url || !options.key || !Number.isInteger(calls) || calls < 1) throw new Error('Supply a URL, a key and a positive whole call count.')
    const rpc = async (method, params) => {
      const response = await fetch(options.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${options.key}`, 'MCP-Protocol-Version': '2025-11-25',
          ...(sid ? { 'MCP-Session-Id': sid } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      })
      sid = response.headers.get('MCP-Session-Id') ?? sid
      const body = await response.json()
      if (body.error) throw new Error(body.error.message)
      if (!response.ok) throw new Error(body.message ?? body.error ?? `Request failed (${response.status}).`)
      return body.result
    }
    const call = async (name, args = {}) => {
      const result = await rpc('tools/call', { name, arguments: args })
      if (result.isError && result.structuredContent?.code !== 'TAB_DUE') throw new Error(result.content?.[0]?.text ?? 'The call failed.')
      return result
    }
    await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'running-tab-client', version: '1.0.0' } })
    for (let n = 0; n < calls;) {
      const step = script[n % script.length]
      const result = await call(step.tool, step.args)
      const due = result.structuredContent
      if (due?.code === 'TAB_DUE') {
        log(`tab due: ${money(due.total_cents)}. Pay at ${due.pay_url}`)
        if (!options.wait) break
        let paid = false
        for (let poll = 0; poll < 120; poll++) {
          await sleep(5000)
          const tab = await call('my_tab')
          if (tab.structuredContent?.state !== 'DUE') { paid = true; break }
        }
        if (!paid) break
        log('paid. carrying on')
        continue
      }
      const meta = result._meta?.['running-tab/call']
      if (meta) {
        const status = { BILLABLE: 'billed', STRUCK: 'struck', PENDING_AUDIT: 'held' }[meta.status] ?? meta.status.toLowerCase().replaceAll('_', ' ')
        log(`call ${meta.seq}  ${step.tool}  ${meta.price_cents}c  ${status}  tab ${money(meta.tab_total_cents)} of $5.00${meta.reason_code ? `  ${meta.reason_code}` : ''}`)
      }
      n++
    }
    const tab = await call('my_tab')
    log(tab.content.map(c => c.text ?? '').join(' ').replace(/\s+/g, ' ').trim())
    return 0
  } catch (error) {
    log(error.message)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await run(process.argv.slice(2))
}
