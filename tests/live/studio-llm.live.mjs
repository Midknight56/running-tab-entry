import { chromium } from 'playwright'

const base = process.env.RT_BASE ?? 'https://running-tab.midknight-labs.workers.dev'
const promptStarter = 'Struck calls by agent'
const proxyPath = '/api/studio/llm'
const maxWaitMs = 4 * 60 * 1000
const quietMs = 20 * 1000
const rounds = []
const requestRows = new Map()
const pending = new Set()
let lastProxyAt = 0
let sawParseFailure = false

const isProxy = (request) => new URL(request.url()).pathname === proxyPath
const elapsedSeconds = (start) => ((performance.now() - start) / 1000).toFixed(1)

const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()

  page.on('request', (request) => {
    if (!isProxy(request)) return
    const started = performance.now()
    lastProxyAt = started
    pending.add(request)
    let body = ''
    try { body = request.postData() ?? '' } catch {}
    let round = rounds.length
    try { round = Number(JSON.parse(body).round ?? round) } catch {}
    const row = { round, size: body.length, source: '', busy: false, seconds: '' }
    rounds.push(row)
    requestRows.set(request, { row, started })
  })

  page.on('response', async (response) => {
    const request = response.request()
    const info = requestRows.get(request)
    if (!info) return
    info.row.seconds = elapsedSeconds(info.started)
    try {
      const result = await response.json()
      info.row.source = result.source ?? ''
      info.row.busy = result.busy === true
      if (typeof result.text === 'string' && !info.row.busy && result.text.includes('tool_calls')) {
        const start = result.text.indexOf('{')
        const end = result.text.lastIndexOf('}')
        let validCalls = false
        if (start >= 0 && end > start) {
          try {
            const parsed = JSON.parse(result.text.slice(start, end + 1))
            validCalls = Array.isArray(parsed.tool_calls) && parsed.tool_calls.some((call) => typeof call?.name === 'string')
          } catch {}
        }
        if (!validCalls) sawParseFailure = true
      }
    } catch {}
    pending.delete(request)
    lastProxyAt = performance.now()
  })

  page.on('requestfailed', (request) => {
    if (!isProxy(request)) return
    pending.delete(request)
    lastProxyAt = performance.now()
  })

  await page.goto(base, { waitUntil: 'domcontentloaded' })
  // The assistant and its prompt starters show in Studio's edit mode (the same steps as e2e/studio-agent.spec.ts).
  await page.getByRole('button', { name: 'Run the agent' }).waitFor({ state: 'visible', timeout: 60_000 })
  await page.getByRole('button', { name: 'Edit desk' }).click()
  const starter = page.getByRole('button', { name: promptStarter, exact: true })
  await starter.waitFor({ state: 'visible', timeout: 120_000 })

  const widgetCount = () => page.locator('.ag-studio-layout-widget').count()

  const before = await widgetCount()
  await starter.click()
  const started = performance.now()
  lastProxyAt = started

  while (performance.now() - started < maxWaitMs) {
    await page.waitForTimeout(500)
    if (pending.size === 0 && performance.now() - lastProxyAt >= quietMs) break
  }

  const after = await widgetCount()
  const added = after > before
  const busy = rounds.some((row) => row.busy)
  const roundLimit = rounds.some((row) => row.round >= 6)
  const cause = added ? '' : busy ? 'busy' : roundLimit ? 'round limit' : sawParseFailure ? 'parse failure' : 'no busy reply, malformed tool call, or round limit recorded'

  console.log('round | body characters | source | busy | seconds')
  for (const row of rounds) {
    console.log(`${row.round} | ${row.size} | ${row.source || '(none)'} | ${row.busy ? 'yes' : 'no'} | ${row.seconds || '(pending)'}`)
  }
  console.log(`widget added ${added ? 'yes' : 'no'}, rounds ${rounds.length}, busy ${busy ? 'yes' : 'no'}, seconds ${elapsedSeconds(started)}${added ? '' : `, cause ${cause}`}`)
  process.exitCode = added ? 0 : 1
  await context.close()
} finally {
  await browser.close()
}
