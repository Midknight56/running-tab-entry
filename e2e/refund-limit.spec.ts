import { expect, test } from '@playwright/test'
import { asVisitor, runToDue, setMock, watchErrors } from './helpers'

test('past one fifth of the capture a refund waits for the seller, who can release it', async ({ page }) => {
  const errors = watchErrors(page)
  const addr = await asVisitor(page)
  await setMock(page, { capture: 'ok' })
  await runToDue(page)
  await page.getByRole('button', { name: 'Pay by card' }).click()
  await expect(page.locator('.rt-meter-row').first()).toHaveAttribute('data-state', 'PAID', { timeout: 15_000 })

  const session = await page.request.post('/api/session', { headers: { 'CF-Connecting-IP': addr } })
  expect(session.ok()).toBe(true)
  const sessionBody = await session.json() as { agents: Array<{ key: string }> }
  const key = sessionBody.agents[0].key
  const headers = {
    Authorization: `Bearer ${key}`,
    'CF-Connecting-IP': addr,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2025-11-25',
  }
  let rpcId = 0
  const initialize = await page.request.post('/mcp', {
    headers,
    data: {
      jsonrpc: '2.0', id: ++rpcId, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'refund-limit-test', version: '1.0.0' } },
    },
  })
  expect(initialize.ok()).toBe(true)
  const mcpSessionId = initialize.headers()['mcp-session-id']
  expect(mcpSessionId).toBeTruthy()

  const answers: Array<{ structuredContent: { state: string } }> = []
  for (const callId of [8, 10, 11, 13, 15]) {
    const response = await page.request.post('/mcp', {
      headers: { ...headers, 'MCP-Session-Id': mcpSessionId },
      data: {
        jsonrpc: '2.0', id: ++rpcId, method: 'tools/call',
        params: { name: 'report_bad_answer', arguments: { call_id: callId, reason: 'a retry of an earlier call with the same request' } },
      },
    })
    expect(response.ok()).toBe(true)
    const body = await response.json() as { result: { structuredContent: { state: string } } }
    answers.push(body.result)
  }

  expect(answers.slice(0, 4).map((answer) => answer.structuredContent.state)).toEqual(['REFUNDED', 'REFUNDED', 'REFUNDED', 'REFUNDED'])
  expect(answers[4].structuredContent.state).toBe('WAITING_SELLER')
  await expect(page.getByTestId('flow-refunded')).toHaveText('$1.00')
  const releaseRefund = page.getByRole('button', { name: 'Refund call 15' })
  await expect(releaseRefund).toBeVisible()
  await releaseRefund.click()
  await expect(page.getByTestId('flow-refunded')).toHaveText('$1.25')
  expect(errors).toEqual([])
})
