import { expect, test } from '@playwright/test'
import { asVisitor, runToDue, setMock, watchErrors } from './helpers'
import { WORKSPACES_PER_IP_PER_DAY } from '../src/demo/workspace'

test('a cancelled approval keeps the tab due', async ({ page }) => {
  const errors = watchErrors(page)
  await asVisitor(page)
  await setMock(page, { capture: 'ok' })
  const pay = await runToDue(page)
  await pay.click()
  await page.locator('#cancel').click()
  await page.waitForURL(/cancelled=1/)
  await expect(page.getByText('Payment cancelled. The tab is still due.')).toBeVisible()
  await expect(page.getByRole('link', { name: /^Pay \$5\.15 with PayPal$/ })).toBeVisible()
  await expect(page.locator('.rt-meter-row').first()).toHaveAttribute('data-state', 'DUE')
  expect(errors).toEqual([])
})

test('a failed capture says so and keeps the tab due', async ({ page }) => {
  const errors = watchErrors(page)
  await asVisitor(page)
  await setMock(page, { capture: 'fail' })
  const pay = await runToDue(page)
  await pay.click()
  await page.locator('#pay').click()
  await page.waitForURL(/pay_failed=1/)
  await expect(page.getByText('Payment did not go through. The tab is still open.')).toBeVisible()
  await expect(page.locator('.rt-meter-row').first()).toHaveAttribute('data-state', 'DUE')
  await setMock(page, { capture: 'ok' })
  expect(errors).toEqual([])
})

test('a forged webhook is refused and changes nothing', async ({ request }) => {
  const body = JSON.stringify({ id: 'WH-FORGED', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'MOCKCAP1', custom_id: 'rt-tab_x' } })
  const r = await request.post('/webhooks/paypal', {
    data: body,
    headers: {
      'Content-Type': 'application/json', 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://example.com/c.pem',
      'paypal-transmission-id': 't1', 'paypal-transmission-sig': 'forged', 'paypal-transmission-time': '2026-10-23T00:00:00Z',
    },
  })
  expect(r.status()).toBe(400)
})

test('a workspace past the daily cap from one network is refused', async ({ playwright, baseURL }) => {
  const codes: number[] = []
  let refusalBody = ''
  // A fresh client each time: a client that keeps its cookie gets its own workspace back, as it should.
  for (let i = 0; i < WORKSPACES_PER_IP_PER_DAY + 1; i++) {
    const c = await playwright.request.newContext({ baseURL })
    const response = await c.post('/api/session', { headers: { 'CF-Connecting-IP': '198.51.100.77' } })
    codes.push(response.status())
    if (response.status() === 429) refusalBody = await response.text()
    await c.dispose()
  }
  expect(codes).toEqual([...Array(WORKSPACES_PER_IP_PER_DAY).fill(200), 429])
  expect(refusalBody).toMatch(/a day from one network/i)
  expect(refusalBody).toMatch(/try again tomorrow/i)
})

test('the test card pays the tab, and the claim after it is refunded', async ({ page }) => {
  const errors = watchErrors(page)
  await asVisitor(page)
  await setMock(page, { capture: 'ok' })
  await runToDue(page)
  await page.getByRole('button', { name: 'Pay with a test card' }).click()
  await expect(page.locator('.rt-meter-row').first()).toHaveAttribute('data-state', 'PAID', { timeout: 15_000 })
  await page.getByRole('button', { name: 'Agent reports call 24' }).click()
  await expect(page.getByTestId('flow-refunded')).toHaveText('$0.25', { timeout: 60_000 })
  expect(errors).toEqual([])
})

test('the desk assistant says plainly when a visitor has used its share for the day', async ({ page }) => {
  const errors = watchErrors(page)
  const addr = await asVisitor(page)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Run the agent' })).toBeVisible()

  // page.request does not carry the page's extra headers, so it names the same visitor itself.
  let calls = 0
  let exhausted: Awaited<ReturnType<typeof page.request.post>> | undefined
  while (calls < 46) {
    exhausted = await page.request.post('/api/desk/ask', { data: { question: `struck calls by agent ${calls}` }, headers: { 'CF-Connecting-IP': addr } })
    calls++
    if (exhausted.status() === 429) break
  }

  expect(calls).toBeGreaterThanOrEqual(30)
  expect(calls).toBeLessThanOrEqual(45)
  expect(exhausted?.status()).toBe(429)
  expect(((await exhausted!.json()) as { busy?: boolean }).busy).toBe(true)

  await page.getByLabel('Ask the desk').fill('calls by tool, one more')
  await page.getByRole('button', { name: 'Add chart' }).click()
  await expect(page.getByRole('alert')).toContainText("The desk's assistant has used its share for today. The desk and the demo still work.")
  const runButton = page.getByRole('button', { name: 'Run the agent' })
  await expect(runButton).toBeVisible()
  await expect(runButton).toBeEnabled()

  expect(errors.every((error) => /429|Too Many Requests/.test(error))).toBe(true)
  expect(errors.some((error) => error.startsWith('pageerror:'))).toBe(false)
})
