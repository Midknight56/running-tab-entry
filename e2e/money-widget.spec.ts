import { expect, test, type Page } from '@playwright/test'
import { asVisitor, runToDue, setMock, watchErrors } from './helpers'

// The three money parts: the paid receipt with its agent and capture id, the current tab, and the session money.
const PARTS = ['receipt-id', 'current-tab', 'session-money']

// After payment the next tab opens with one $0.25 call; the desk data gets that open tab so the layout holds all three.
async function withOpenTab(page: Page) {
  await page.route('**/api/desk/data', async (route) => {
    const response = await route.fetch()
    const data = await response.json()
    const agent = data.agents[0]
    const open = { tab_id: 'open-after-pay', agent_id: agent?.id, state: 'OPEN', total_cents: 25 }
    data.open_tab = open
    if (data.money) data.money.open_tab = open
    await route.fulfill({ response, json: data })
  })
}

test('the money widget shows the receipt, the current tab and the session money at desktop and phone width', async ({ page }) => {
  const errors = watchErrors(page)
  await withOpenTab(page)
  await asVisitor(page)
  await setMock(page, { capture: 'ok' })
  await runToDue(page)
  await page.getByRole('button', { name: 'Pay by card' }).click()
  await expect(page.locator('.rt-meter-row').first()).toHaveAttribute('data-state', 'PAID', { timeout: 15_000 })

  // Desktop: every part lies inside the widget's own visible box, so nothing needs a scroll to be read.
  const widget = page.locator('.rt-widget-money')
  await expect(widget.getByTestId('receipt-id')).toContainText('PayPal capture')
  await expect(widget.getByTestId('current-tab')).toHaveText('Open, $0.25')
  for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(size)
    const desktop = await widget.evaluate((el, parts) => {
      const box = el.getBoundingClientRect()
      return parts.map((id) => {
        const part = el.querySelector(`[data-testid="${id}"]`)
        if (!part) return `${id} missing`
        const r = part.getBoundingClientRect()
        return r.top >= box.top - 1 && r.bottom <= box.bottom + 1 && r.left >= box.left - 1 && r.right <= box.right + 1
          ? 'inside' : `${id} cut off: ${Math.round(r.top)} to ${Math.round(r.bottom)} in ${Math.round(box.top)} to ${Math.round(box.bottom)}`
      })
    }, PARTS)
    expect(desktop, `desktop ${size.width}`).toEqual(['inside', 'inside', 'inside'])
  }

  // Phone: the money section shows all three parts, inside the screen with the 16 px margin.
  for (const size of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(size)
    for (const id of PARTS) {
      const part = page.getByTestId(id).filter({ visible: true }).first()
      await part.scrollIntoViewIfNeeded()
      await expect(part, `${id} at ${size.width}`).toBeVisible()
      const r = await part.boundingBox()
      expect(r!.x, `${id} left at ${size.width}`).toBeGreaterThanOrEqual(16)
      expect(r!.x + r!.width, `${id} right at ${size.width}`).toBeLessThanOrEqual(size.width - 16)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  }
  expect(errors).toEqual([])
})
