import { expect, test } from '@playwright/test'
import { asVisitor, setMock } from './helpers'

const sizes = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]

test('long desk values and actions fit at phone widths', async ({ page }) => {
  await page.route('**/api/desk/data', async (route) => {
    const response = await route.fetch()
    const data = await response.json()
    if (data.agents[0]) data.agents[0].name = 'A very long scheduler agent name '.repeat(12)
    const due = data.tabs.find((tab: { state: string }) => tab.state === 'DUE')
    if (due) due.total_cents = 999999
    const struck = data.calls.find((call: { status: string }) => call.status === 'STRUCK')
    if (struck) struck.reason_code = 'A'.repeat(200)
    await route.fulfill({ response, json: data })
  })
  await page.setViewportSize(sizes[0])
  await asVisitor(page)
  await setMock(page, { capture: 'ok' })
  await page.goto('/')
  await page.getByRole('button', { name: 'Run the agent' }).click()
  await expect(page.getByRole('link', { name: /^Pay .* with PayPal$/ })).toBeVisible({ timeout: 90_000 })
  await expect(page.getByText('A'.repeat(200), { exact: true })).toBeVisible()

  for (const size of sizes) {
    await page.setViewportSize(size)
    const results = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll<HTMLElement>('.rt-btn')].filter((el) => el.getClientRects().length).map((el) => {
        const box = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        const range = document.createRange()
        range.selectNodeContents(el)
        const text = range.getBoundingClientRect()
        return {
          name: el.textContent?.trim(), x: box.x, right: box.right, y: box.y, bottom: box.bottom,
          height: box.height, textLeft: text.left, textRight: text.right,
        }
      })
      const overlaps: string[] = []
      for (let i = 0; i < buttons.length; i++) for (let j = i + 1; j < buttons.length; j++) {
        const a = buttons[i], b = buttons[j]
        const gapX = Math.max(b.x - a.right, a.x - b.right)
        const gapY = Math.max(b.y - a.bottom, a.y - b.bottom)
        if (Math.max(gapX, gapY) < 12) overlaps.push(`${a.name} and ${b.name} are ${Math.max(gapX, gapY)} px apart`)
      }
      return { scroll: document.documentElement.scrollWidth - window.innerWidth, buttons, overlaps }
    })
    expect(results.scroll).toBeLessThanOrEqual(0)
    expect(results.overlaps).toEqual([])
    for (const b of results.buttons) {
      expect(b.x, `${b.name} left edge`).toBeGreaterThanOrEqual(16)
      expect(b.right, `${b.name} right edge`).toBeLessThanOrEqual(size.width - 16)
      expect(b.height, `${b.name} height`).toBeGreaterThanOrEqual(44)
      expect(b.textLeft, `${b.name} text left padding`).toBeGreaterThanOrEqual(b.x + 8)
      expect(b.textRight, `${b.name} text right padding`).toBeLessThanOrEqual(b.right - 8)
    }
  }
  await page.setViewportSize({ width: 320, height: 568 })
  const firstMeter = page.getByRole('list', { name: 'Tabs by agent' }).locator('.rt-meter-row').first()
  await expect(firstMeter.locator('.rt-meter-name')).toContainText('A very long scheduler agent name')
  await expect(firstMeter.locator('.rt-meter-amount')).toContainText('$9999.99')
  await page.getByRole('button', { name: 'Pay by card' }).click()
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('pay and Agent reports call 24 are keyboard reachable and tappable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await asVisitor(page)
  await setMock(page, { capture: 'ok' })
  await page.goto('/')
  await page.getByRole('button', { name: 'Run the agent' }).click()
  const pay = page.getByRole('link', { name: /^Pay \$5\.15 with PayPal$/ })
  await expect(pay).toBeVisible({ timeout: 90_000 })

  const visibleActions = page.locator('.rt-actions .rt-btn, .rt-sum-actions .rt-btn')
  const actionCount = await visibleActions.count()
  const focused = new Set<string>()
  await page.getByRole('heading', { name: 'Running Tab', level: 1 }).click()
  for (let i = 0; i < actionCount + 2 && focused.size < actionCount; i++) {
    await page.keyboard.press('Tab')
    const active = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      return el?.matches('.rt-actions .rt-btn, .rt-sum-actions .rt-btn') ? {
        name: el.textContent?.trim() ?? '', outline: getComputedStyle(el).outlineStyle,
      } : null
    })
    if (active) {
      expect(active.outline).not.toBe('none')
      focused.add(active.name)
    }
  }
  expect(focused.size).toBe(actionCount)

  await pay.click()
  await page.locator('#pay').click()
  await page.waitForURL(/paid=1/)
  const report = page.getByRole('button', { name: 'Agent reports call 24' })
  await expect(report).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => report.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44)
  await page.keyboard.press('Tab')
  for (let i = 0; i < 4; i++) {
    const active = await page.evaluate(() => document.activeElement?.textContent?.trim())
    if (active === 'Agent reports call 24') break
    await page.keyboard.press('Tab')
  }
  await expect(report).toBeFocused()
  expect(await report.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none')
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('explain_bill')).toBeVisible({ timeout: 60_000 })
})
