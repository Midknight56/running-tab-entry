import { expect, test } from '@playwright/test'
import { asVisitor, watchErrors } from './helpers'

// Every button: 8 px padding, 16 px inside the screen, 12 px from its neighbours, nothing overlapping.
for (const size of [{ width: 360, height: 640 }, { width: 390, height: 844 }]) {
  test(`header controls fit and are spaced on ${size.width}x${size.height}`, async ({ page }) => {
    const errors = watchErrors(page)
    await page.setViewportSize(size)
    await asVisitor(page)
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Run the agent' })).toBeVisible()
    await expect(page.getByTestId('phone-desk')).toBeVisible()
    await expect(page.locator('.rt-meter-row').first()).toBeVisible()
    const boxes = await page.locator('.rt-top .rt-btn').evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      return { name: el.textContent?.trim(), x: r.x, y: r.y, w: r.width, h: r.height, pl: parseFloat(s.paddingLeft), pt: parseFloat(s.paddingTop), sw: el.scrollWidth, cw: el.clientWidth }
    }))
    const problems: string[] = []
    for (const b of boxes) {
      if (b.pl < 8 || b.pt < 8) problems.push(`${b.name}: padding ${b.pl}/${b.pt}`)
      if (b.x < 16 || b.x + b.w > size.width - 16) problems.push(`${b.name}: not 16 px inside the screen (${b.x}..${b.x + b.w})`)
      if (b.sw > b.cw + 1) problems.push(`${b.name}: text overflows`)
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j]
      const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w))
      const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h))
      if (Math.max(gapX, gapY) < 12) problems.push(`${a.name} and ${b.name}: ${Math.max(gapX, gapY).toFixed(1)} px apart`)
    }
    expect(problems).toEqual([])
    const scrollX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(scrollX).toBeLessThanOrEqual(0)
    await page.screenshot({ path: `test-results/phone-${size.width}x${size.height}.png` })
    expect(errors).toEqual([])
  })
}
