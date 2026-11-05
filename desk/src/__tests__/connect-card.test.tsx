import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ConnectCard } from '../ConnectCard'
import type { Tab } from '../types'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const agents = [{ id: 'judge', name: 'Your agent', created_at: 1 }, { id: 'demo', name: 'Scheduler bot', created_at: 0 }]
const session = { ws_id: 'ws', agents: [{ id: 'demo', name: 'Scheduler bot', key: 'demo_key' }] }
it('shows the key expiry configuration and command with copy buttons', async () => {
  const expires = Date.now() + 7200000
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ agent_id: 'judge', name: 'Your agent', key: 'rt_agent_test', expires_at: expires, mcp_url: 'https://rt.example/mcp' }) })))
  render(<ConnectCard session={session} agents={agents} tabs={[]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Get a key' }))
  expect(await screen.findByText('rt_agent_test')).toBeTruthy()
  expect(screen.getByText(`Expires ${new Date(expires).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)).toBeTruthy()
  expect(screen.getByText(JSON.stringify({ mcpServers: { 'running-tab': { url: 'https://rt.example/mcp', headers: { Authorization: 'Bearer rt_agent_test' } } } }))).toBeTruthy()
  expect(screen.getByText('node client/agent.mjs --url https://rt.example/mcp --key rt_agent_test --wait')).toBeTruthy()
  expect(screen.getByRole('region', { name: 'Connect' }).querySelector('p')?.textContent).toMatch(/^MCP endpoint/)
  expect(screen.getByRole('region', { name: 'Connect' }).querySelector('pre')?.textContent).toBe('rt_agent_test')
  for (const label of ['Key', 'Client config', 'Command']) expect(screen.getByRole('button', { name: `Copy ${label}` })).toBeTruthy()
  expect(screen.getByText('Demo agents')).toBeTruthy()
})
it('shows the refusal text', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ error: 'Two agent keys per demo desk. Start a new desk tomorrow.' }) })))
  render(<ConnectCard session={session} agents={agents} tabs={[]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Get a key' }))
  expect(await screen.findByText('Two agent keys per demo desk. Start a new desk tomorrow.')).toBeTruthy()
})
it('shows payment controls only for the connected agents due tabs', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL) => ({ ok: true, json: async () => ({ kind: 'paid' }) }))
  vi.stubGlobal('fetch', fetch)
  const tabs = [{ id: 'tab_judge', agent_id: 'judge', state: 'DUE', total_cents: 515 }, { id: 'tab_demo', agent_id: 'demo', state: 'DUE', total_cents: 600 }] as Tab[]
  const { rerender } = render(<ConnectCard session={session} agents={agents} tabs={tabs} />)
  expect(screen.getByRole('link', { name: 'Pay $5.15 with PayPal' }).getAttribute('href')).toBe('/pay/tab_judge')
  expect(screen.queryByText('Pay $6.00 with PayPal')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Pay with a test card' }))
  expect(fetch.mock.calls[0][0]).toBe('/api/sandbox/card-pay/tab_judge')
  rerender(<ConnectCard session={session} agents={agents} tabs={tabs.slice(1)} />)
  expect(screen.queryByRole('button', { name: 'Pay with a test card' })).toBeNull()
})

it.each([
  [{ error: 'Five PayPal orders a day from one network in this demo. Try again tomorrow.' }, 'Five PayPal orders a day from one network in this demo. Try again tomorrow.'],
  [{ reason: 'X' }, 'X'],
  [{}, 'Payment did not go through. The tab is still open.'],
])('shows the card payment refusal message %#', async (body, message) => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => body })))
  const tabs = [{ id: 'tab_judge', agent_id: 'judge', state: 'DUE', total_cents: 515 }] as Tab[]
  render(<ConnectCard session={session} agents={agents} tabs={tabs} />)
  fireEvent.click(screen.getByRole('button', { name: 'Pay with a test card' }))
  expect((await screen.findByRole('alert')).textContent).toBe(message)
})


it('sends optional budget inputs as cents', async () => {
  const fetch = vi.fn(async () => ({ ok: false, json: async () => ({ error: 'test response' }) }))
  vi.stubGlobal('fetch', fetch)
  render(<ConnectCard session={session} agents={agents} tabs={[]} />)
  fireEvent.change(screen.getByLabelText('Monthly budget ($)'), { target: { value: '5.00' } })
  fireEvent.change(screen.getByLabelText('Max per call (cents)'), { target: { value: '25' } })
  fireEvent.click(screen.getByRole('button', { name: 'Get a key' }))
  expect(JSON.parse((fetch.mock.calls[0] as any)[1].body)).toEqual({ monthly_cents: 500, max_call_cents: 25 })
})
