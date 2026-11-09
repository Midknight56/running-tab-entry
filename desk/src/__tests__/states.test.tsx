import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('ag-studio-react', () => ({ AgStudio: () => null, AgStudioProvider: ({ children }: { children: React.ReactNode }) => children, createWidgets: () => ({}) }))
vi.mock('ag-studio', () => ({ AgStudioAiModule: {}, createDataEngine: () => ({}), studioTheme: { withParams: () => ({}) } }))

import { App } from '../App'
import { setDesk } from '../store'
import type { DeskData } from '../types'
import type { Tab } from '../types'

const emptyDesk: DeskData = {
  ws_id: '', agents: [], tabs: [], calls: [], claims: [], events: [], trace: [],
  money: { captured_cents: 0, refunded_cents: 0, struck_cents: 0, pending_cents: 0, net_cents: 0, plain_meter_cents: 0, kept_cents: 0, kept_out_cents: 0 },
}

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setDesk(emptyDesk)
})

describe('desk opening states', () => {
  it('shows a status while the session request is pending', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    render(<App license={null} />)
    expect(screen.getByRole('status').textContent).toBe('Opening your demo desk')
  })

  it('shows a refused session reason without a loading status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: 'Ten demo workspaces a day from one network. Try again tomorrow.' }, 429)))
    render(<App license={null} />)
    expect((await screen.findByRole('alert')).textContent).toBe('Ten demo workspaces a day from one network. Try again tomorrow.')
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByTestId('tab-summary')).toBeNull()
    expect(screen.queryByLabelText('Ask the desk')).toBeNull()
    expect(document.querySelector('.rt-studio, .rt-phone, .rt-side')).toBeNull()
  })

  it('shows a data load error after three failures and continues polling', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/session') return response({ ws_id: 'demo', agents: [] })
      if (String(input) === '/api/desk/report') return response(null, 204)
      return response({}, 500)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App license={null} />)
    expect((await screen.findByRole('alert', {}, { timeout: 11000 })).textContent).toBe('The desk could not load. Reload the page.')
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/desk/data').length).toBeGreaterThanOrEqual(3)
  }, 12000)

  it('explains that the desk only builds charts', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/session') return response({ ws_id: 'demo', agents: [] })
      return response({ ...emptyDesk, ws_id: 'demo' })
    }))
    render(<App license={null} />)
    expect(await screen.findByText('The desk builds charts. It cannot refund, approve claims or change prices.')).toBeTruthy()
  })
})

it.each([true, false])('places actions in the summary and draws one claim panel with phone %s', async narrow => {
  vi.stubGlobal('matchMedia', () => ({ matches: narrow, addEventListener() {}, removeEventListener() {} }))
  const data = { ...emptyDesk, ws_id: 'demo', agents: [{ id: 'a1', name: 'Scheduler bot', created_at: 1 }] }
  setDesk(data)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => response(String(input) === '/api/session' ? { ws_id: 'demo', agents: [] } : data)))
  const view = render(<App license={null} />)
  await waitFor(() => expect(screen.getAllByRole('region', { name: 'Try to break it' })).toHaveLength(1))
  expect(within(screen.getByTestId('tab-summary')).getByRole('button', { name: 'Run the agent' })).toBeTruthy()
  expect(within(view.container.querySelector('header')!).queryByRole('button', { name: 'Run the agent' })).toBeNull()
  if (narrow) {
    expect([...view.container.querySelectorAll('.rt-phone > section')].map(section => section.querySelector('h2')?.textContent)).toEqual(['Tabs', 'Money', 'Struck and refunded'])
    expect(view.container.querySelector('.rt-side .rt-try')).toBeNull()
  } else expect(view.container.querySelector('.rt-side .rt-try')).toBeTruthy()
  // Payment details is folded on a first visit; inside it the PayPal and model log is open, so one click shows it.
  const payment = screen.getByTestId('payment-details') as HTMLDetailsElement
  expect(payment.open).toBe(false)
  expect((payment.querySelector('details.rt-log') as HTMLDetailsElement).open).toBe(true)
})

it.each([
  [{ error: 'Five PayPal orders a day from one network in this demo. Try again tomorrow.' }, 'Five PayPal orders a day from one network in this demo. Try again tomorrow.'],
  [{ reason: 'X' }, 'X'],
  [{}, 'Payment did not go through. The tab is still open.'],
])('shows the top card refusal message %#', async (body, message) => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  const tab = { id: 'tab_due', agent_id: 'a1', state: 'DUE', total_cents: 515 } as Tab
  const data = { ...emptyDesk, ws_id: 'demo', agents: [{ id: 'a1', name: 'Scheduler bot', created_at: 1 }], tabs: [tab] }
  setDesk(data)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/sandbox/card-pay/tab_due'
    ? response(body, 429)
    : String(input) === '/api/session' ? response({ ws_id: 'demo', agents: [] }) : response(data)))
  render(<App license={null} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Pay by card' }))
  expect((await screen.findByRole('alert')).textContent).toBe(message)
})
