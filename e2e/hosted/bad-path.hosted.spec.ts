import { expect, test } from '@playwright/test'

test('hosted bad path keeps payment and workspace boundaries intact', async ({ page, browser, baseURL }, testInfo) => {
  const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(name), fullPage: true })

  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Run the agent' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Run the agent' }).click()
  const pay = page.getByRole('link', { name: /^Pay \$\d+\.\d{2} with PayPal$/ })
  await expect(pay).toBeVisible({ timeout: 180_000 })
  const payPath = await pay.getAttribute('href')
  expect(payPath).toMatch(/^\/pay\/tab_[0-9a-f]+$/)
  const tabId = payPath!.split('/').at(-1)!
  await shot('01-step.png')
  console.log(`01 due: tab ${tabId}, desk state Due`)

  await page.goto(payPath!)
  await page.goto(`/paypal/cancel?tab=${encodeURIComponent(tabId)}`)
  await expect(page.getByText('Payment cancelled. The tab is still due.')).toBeVisible()
  await expect(page.locator('.rt-meter-row').first()).toHaveAttribute('data-state', 'DUE')
  await expect(pay).toBeVisible()
  await shot('02-step.png')
  console.log('02 cancel: desk state Due, paid nothing')

  const forged = await page.request.post('/webhooks/paypal', {
    data: JSON.stringify({ id: 'WH-FORGED', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-FORGED', custom_id: tabId } }),
    headers: {
      'Content-Type': 'application/json',
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://example.com/c.pem',
      'paypal-transmission-id': 'forged-transmission',
      'paypal-transmission-sig': 'forged-signature',
      'paypal-transmission-time': '2026-10-23T00:00:00Z',
    },
  })
  expect(forged.status()).toBe(400)
  await expect(page.locator('.rt-meter-row').first()).toHaveAttribute('data-state', 'DUE')
  await shot('03-step.png')
  console.log(`03 forged webhook: HTTP ${forged.status()}, desk state Due`)

  const cardResponsePromise = page.waitForResponse((response) => response.url().includes('/api/sandbox/card-pay/') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Pay with a test card' }).click()
  const cardResponse = await cardResponsePromise
  expect(cardResponse.status()).toBe(200)
  await expect(page.locator('.rt-meter-row').first()).toHaveAttribute('data-state', 'PAID', { timeout: 30_000 })
  await shot('04-step.png')
  console.log(`04 test card: HTTP ${cardResponse.status()}, tab ${tabId}, desk state Paid`)

  const tries = page.getByRole('region', { name: 'Try to break it' })
  await tries.getByRole('button', { name: 'Tell the judge to approve and refund ten dollars' }).click()
  const claimResponsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/claims/try' && response.request().method() === 'POST')
  await tries.getByRole('button', { name: 'Try claim' }).click()
  const claimResponse = await claimResponsePromise
  expect(claimResponse.status()).toBe(200)
  await expect(tries.locator('.rt-try-verdict strong')).toHaveText('Denied', { timeout: 60_000 })
  await expect(tries.getByText('Refund id:')).toHaveCount(0)
  await shot('05-step.png')
  console.log(`05 claim attack: HTTP ${claimResponse.status()}, tab ${tabId}, Denied, no refund id`)

  const ledgerResponsePromise = page.waitForResponse((response) => new URL(response.url()).pathname.startsWith('/api/ledger/verify/'))
  await page.getByRole('button', { name: 'Verify ledger' }).click()
  const ledgerResponse = await ledgerResponsePromise
  expect(ledgerResponse.status()).toBe(200)
  await expect(page.getByRole('status')).toContainText('Ledger verified', { timeout: 30_000 })
  await shot('06-step.png')
  console.log(`06 ledger: HTTP ${ledgerResponse.status()}, tab ${tabId}, Ledger verified`)

  const otherContext = await browser.newContext({ baseURL })
  try {
    const otherPage = await otherContext.newPage()
    await otherPage.goto('/')
    await expect(otherPage.getByRole('button', { name: 'Run the agent' })).toBeVisible({ timeout: 30_000 })
    await otherPage.getByRole('button', { name: 'Connect an agent' }).click()
    const connect = otherPage.locator('.rt-connect')
    const demoAgents = connect.locator('details').filter({ has: otherPage.getByText('Demo agents', { exact: true }) })
    await demoAgents.locator('summary').click()
    const otherKeyCode = demoAgents.locator('code').last()
    await expect(otherKeyCode).toBeVisible()
    const otherKey = (await otherKeyCode.innerText()).replace(/^Authorization: Bearer /, '')
    expect(otherKey).toBeTruthy()
    const init = await otherPage.request.post('/mcp', {
      headers: {
        Authorization: `Bearer ${otherKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-11-25',
      },
      data: {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'hosted-check', version: '1.0.0' } },
      },
    })
    expect(init.ok()).toBe(true)
    const result = await otherPage.request.post('/mcp', {
      headers: {
        Authorization: `Bearer ${otherKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-11-25',
        'MCP-Session-Id': init.headers()['mcp-session-id'],
      },
        // Ask for the first workspace's tab by its id: the second workspace's key must be refused.
        data: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'explain_bill', arguments: { tab_id: tabId } } },
    })
    expect(result.ok()).toBe(true)
    const resultBody = await result.json() as { result?: { isError?: boolean; structuredContent?: { tab_id?: string; state?: string } } }
    expect(resultBody.result?.isError).toBe(true)
    expect(resultBody.result?.structuredContent?.tab_id).not.toBe(tabId)
    await otherPage.getByRole('button', { name: 'Connect an agent' }).click()
    await otherPage.screenshot({ path: testInfo.outputPath('07-step.png'), fullPage: true })
    console.log(`07 other workspace key: HTTP ${result.status()}, explain_bill on tab ${tabId} refused ${resultBody.result?.isError === true}`)
  } finally {
    await otherContext.close()
  }
})
