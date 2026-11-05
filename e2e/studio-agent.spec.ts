import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { asVisitor } from './helpers'

const studioSource = readFileSync(new URL('../src/studio.ts', import.meta.url), 'utf8')
const BUSY_TEXT = JSON.parse(studioSource.match(/export const BUSY = ("(?:[^"\\]|\\.)*")/)?.[1] ?? '""') as string

test('a prompt starter adds a chart through the local Studio proxy', async ({ page }) => {
  await asVisitor(page)
  let rounds = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/studio/llm') rounds++
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Run the agent' })).toBeVisible()
  await page.getByRole('button', { name: 'Edit desk' }).click()
  const canvasWidgets = page.locator('.ag-studio-layout-widget')
  const before = await canvasWidgets.count()
  await page.getByRole('button', { name: 'Struck calls by agent', exact: true }).click()

  await expect(page.getByText('Added a chart of struck calls by agent.', { exact: true }).last()).toBeVisible({ timeout: 60_000 })
  await expect.poll(() => canvasWidgets.count(), { timeout: 30_000 }).toBe(before + 1)
  expect(rounds).toBeGreaterThanOrEqual(1)
  expect(rounds).toBeLessThanOrEqual(6)
})

test('the assistant reports a busy reply while the desk still runs', async ({ page }) => {
  await asVisitor(page)
  await page.route('**/api/studio/llm', (route) => route.fulfill({ json: { text: BUSY_TEXT, busy: true } }))
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Run the agent' })).toBeVisible()
  await page.getByRole('button', { name: 'Edit desk' }).click()
  await page.getByRole('button', { name: 'Struck calls by agent', exact: true }).click()
  await expect(page.getByText(BUSY_TEXT, { exact: true })).toBeVisible({ timeout: 30_000 })

  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByRole('button', { name: 'Run the agent' })).toBeEnabled()
  await expect(page.locator('.rt-studio')).toBeVisible()
})
