import { expect, test } from '@playwright/test'
import { asVisitor, runToDue, setMock, watchErrors } from './helpers'

test('a judge runs the agent, pays the tab, and sees call 24 refunded and the bill explained', async ({ page }) => {
  const errors = watchErrors(page)
  await asVisitor(page)
  await setMock(page, { capture: 'ok' })
  const pay = await runToDue(page)

  const meter = page.locator('.rt-meter-row').first()
  await expect(meter).toHaveAttribute('data-state', 'DUE')
  await expect(meter).toContainText('$5.15')
  const ledger = page.locator('.rt-ledger-row')
  await expect(ledger.filter({ hasText: 'Scheduler bot call 9' }).first()).toContainText('EMPTY')
  await expect(ledger.filter({ hasText: 'Scheduler bot call 14' }).first()).toContainText('ERROR')
  await expect(ledger.filter({ hasText: 'Scheduler bot call 21' }).first()).toContainText('London has mild weather this week')

  await pay.click()
  await expect(page.locator('h1')).toHaveText('Pay $5.15')
  await page.locator('#pay').click()
  await page.waitForURL(/paid=1/)

  await page.getByRole('button', { name: 'Agent reports call 24' }).click()
  await expect(page.getByLabel('explain_bill')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('flow-captured')).toHaveText('$5.15', { timeout: 10_000 })
  await expect(page.getByTestId('flow-refunded')).toHaveText('$0.25')
  await expect(page.getByTestId('flow-net')).toHaveText('$4.90')
  await expect(page.getByTestId('flow-line')).toHaveText(/A plain meter bills \$\d+\.\d{2}\. Running Tab charges \$\d+\.\d{2} after refunds\. The \$\d+\.\d{2} gap(?:: .+)?\./)
  await expect(ledger.filter({ hasText: 'Scheduler bot call 24' }).first()).toContainText('$0.25 refunded')
  await expect(page.locator('.rt-panel-paypal').filter({ hasText: '/refund' }).first()).toContainText('201')
  await expect(page.locator('.rt-meter-row').first()).toHaveAttribute('data-state', 'OPEN')
  await page.getByRole('button', { name: 'Verify ledger' }).click()
  await expect(page.getByRole('status')).toContainText('Ledger verified')
  await page.getByLabel('Ask the desk').fill('Add a chart of struck calls by agent')
  await page.getByRole('button', { name: 'Add chart' }).click()
  await expect(page.getByTestId('built-count')).toHaveText('1 added', { timeout: 30_000 })
  await expect(page.getByText('Struck calls by agent', { exact: true }).filter({ visible: true }).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Loading...').filter({ visible: true })).toHaveCount(0, { timeout: 15_000 })
  await page.waitForTimeout(3000) // the chart redraws after the last poll
  await page.screenshot({ path: 'test-results/desk-after-refund.png' })
  expect(errors).toEqual([])
})
