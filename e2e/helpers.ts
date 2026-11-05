import { expect, type Page } from '@playwright/test'

const mockPaypalPort = Number(process.env.MOCK_PAYPAL_PORT ?? 8799)

let ip = 10
/** Each test is its own visitor, so the three workspaces a day cap applies per test. */
export async function asVisitor(page: Page): Promise<string> {
  const addr = `192.0.2.${ip++}`
  await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': addr })
  return addr
}

/** Collects page errors, and console errors except AG Studio's keyless licence banner. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    if (/^\*+$|License|licen[cs]e|watermark|info@ag-grid\.com|unlocked for trial/i.test(t)) return
    errors.push('console: ' + t)
  })
  return errors
}

export async function runToDue(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Run the agent' }).click()
  const pay = page.getByRole('link', { name: /^Pay \$5\.15 with PayPal$/ })
  await expect(pay).toBeVisible({ timeout: 90_000 })
  return pay
}

export async function setMock(page: Page, mode: Record<string, string>) {
  const r = await page.request.post(`http://127.0.0.1:${mockPaypalPort}/__mode`, { data: mode })
  expect(r.ok()).toBe(true)
}
