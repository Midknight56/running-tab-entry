import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('ag-studio-react', () => ({ AgStudio: () => null, AgStudioProvider: ({ children }: { children: React.ReactNode }) => children, createWidgets: () => ({}) }))
vi.mock('ag-studio', () => ({ AgStudioAiModule: {}, createDataEngine: () => ({}), studioTheme: { withParams: () => ({}) } }))

import { App } from '../App'
import { Panel, TryPanel } from '../Panel'
import { loadDesk, runCalls, verifyLedger } from '../data'
import { setDesk } from '../store'
import { StruckLedger } from '../widgets/StruckLedger'
import { billRows, CHECK_SCOPE, TabSummary } from '../widgets/TabSummary'
import { MoneyFlow } from '../widgets/MoneyFlow'
import type { Call, Claim, DeskData, Tab } from '../types'

const connectionError = 'Could not reach the desk. Check your connection and try again.'
const agent = { id: 'a1', name: 'Scheduler bot', created_at: 1 }
const tab = (o: Partial<Tab> = {}): Tab => ({ id: 't', agent_id: 'a1', state: 'PAID', total_cents: 25, threshold_cents: 500, order_id: null, capture_id: 'cap', captured_cents: 25, refunded_cents: 0, note: null, created_at: 1, due_at: null, paid_at: 1, ...o })
const call = (o: Partial<Call> = {}): Call => ({ id: 'c24', seq: 24, agent_id: 'a1', tab_id: 't', tool: 'convert_time', args: {}, answer: '', price_cents: 25, status: 'BILLABLE', reason_code: null, evidence: null, judged_by: null, duration_ms: 0, created_at: 1, ...o })
const claim = (o: Partial<Claim> = {}): Claim => ({ id: 'k', call_id: 'c24', call_seq: 24, agent_id: 'a1', reason_text: 'wrong', verdict: 'none', reason_code: null, evidence: null, refund_id: null, refund_status: null, state: 'WAITING_SELLER', created_at: 1, ...o })
const money = { captured_cents: 50, refunded_cents: 0, refund_pending_cents: 25, struck_cents: 5, pending_cents: 0, net_cents: 50, plain_meter_cents: 55, kept_cents: 50, kept_out_cents: 5 }
const desk = (o: Partial<DeskData> = {}): DeskData => ({ ws_id: 'demo', agents: [agent], tabs: [tab()], calls: [call()], claims: [], events: [], trace: [], money, ...o })
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

function mockDesk(data: DeskData, action?: string, body?: unknown) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === action) {
      if (body !== undefined) return response(body, 409)
      throw new Error('offline')
    }
    if (url === '/api/session') return response({ ws_id: 'demo', agents: [] })
    if (url === '/api/claims/try') return response({ tries_left: 5 })
    if (url === '/api/desk/data') return response(data)
    if (url === '/api/desk/report') return response(null, 204)
    throw new Error(`Unexpected request ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  setDesk(data)
  return fetch
}

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); setDesk(desk({ ws_id: '', agents: [], tabs: [], calls: [] })) })

it.each([
  ['WAITING_SELLER', null, 'Awaiting the seller'],
  ['APPROVED', null, 'Approved, refund not sent'],
  ['APPROVED', 'FAILED_TIMEOUT', 'Approved, refund not sent'],
  ['REFUNDING', 'IN_FLIGHT', 'Refund sending'],
  ['REFUNDING', 'RETRY', 'Refund sending'],
  ['REFUNDING', 'PENDING', 'Refund pending at PayPal'],
])('keeps the charge billed for claim state %s and refund status %s', (state, refund_status, label) => {
  const view = render(<StruckLedger agents={[agent]} calls={[call()]} claims={[claim({ state, refund_status })]} />)
  expect(view.getByText(label)).toBeTruthy()
  expect(view.getByText('$0.25 billed')).toBeTruthy()
  expect(view.container.textContent).not.toContain('not billed')
  expect(view.queryByRole('button', { name: 'Claim this call' })).toBeNull()
})

it('shows completed refunds and leaves rejected claims out', () => {
  const view = render(<StruckLedger agents={[agent]} calls={[call()]} claims={[claim({ state: 'REFUNDED' }), claim({ id: 'rejected', state: 'REJECTED' })]} />)
  expect(view.getByText('$0.25 refunded')).toBeTruthy()
  expect(view.container.querySelectorAll('.rt-ledger-row')).toHaveLength(1)
  expect(view.queryByRole('button', { name: 'Claim this call' })).toBeNull()
})

it.each([
  ['WAITING_SELLER', 'none', 'Waiting for the seller'],
  ['WAITING_SELLER', null, 'Waiting for the seller'],
  ['WAITING_SELLER', 'approve', 'Upheld'],
  ['APPROVED', null, 'Upheld'],
  ['REFUNDING', null, 'Upheld'],
  ['REFUNDED', null, 'Upheld'],
])('shows the claim result for %s with verdict %s', async (state, verdict, label) => {
  vi.stubGlobal('fetch', vi.fn(async () => response({ state, verdict })))
  render(<TryPanel agents={[agent]} {...{ calls: [call()], tabs: [tab()], triesLeft: 5 }} />)
  fireEvent.change(screen.getByLabelText('Reason for claim'), { target: { value: 'wrong' } })
  fireEvent.click(screen.getByRole('button', { name: 'Try claim' }))
  expect(await screen.findByText(label)).toBeTruthy()
  if (label !== 'Upheld') expect(screen.queryByText('Upheld')).toBeNull()
})

it.each([0, 25])('keeps pending refunds separate from %s completed cents in money and receipt', done => {
  const receipt = { tab_id: 't1', agent_id: 'a1', metered_cents: 55, struck_cents: 5, captured_cents: 50, refunded_cents: done, refund_pending_cents: 25, net_cents: 50 - done }
  const m = { ...money, refunded_cents: done, net_cents: 50 - done, kept_cents: 50 - done, kept_out_cents: 5 + done, refund_pending_cents: 25 }
  const paidTab = { ...tab({ total_cents: 50, captured_cents: 50, refunded_cents: done + 25 }), refund_pending_cents: 25, refunded_done_cents: done }
  const view = render(<><MoneyFlow money={m} receipt={receipt} /><TabSummary agent={agent} tabs={[paidTab]} calls={[]} /></>)
  expect(view.getByText('Refund pending: $0.25')).toBeTruthy()
  expect(view.getByTestId('flow-net').textContent).toBe(done ? '$0.25' : '$0.50')
  expect(view.getByTestId('flow-pending').textContent).toBe('$0.25')
  expect(view.getByTestId('flow-refunded').textContent).toBe(done ? '$0.25' : '$0.00')
  expect(view.getByTestId('flow-line').textContent).toContain('$0.25 of refunds is pending at PayPal and still counted as kept.')
  expect(view.getByTestId('flow-line').textContent).not.toContain('after refunds')
  const rows = billRows(paidTab, [])
  expect(rows).toContainEqual({ label: 'Refund pending', cents: 25 })
  expect(rows).toContainEqual({ label: 'Net paid', cents: 50 - done, kind: 'total' })
  if (done) expect(rows).toContainEqual({ label: 'Refund completed', cents: done })
  else expect(rows.some(row => row.label === 'Refund completed')).toBe(false)
})

it('normalizes rejected action requests', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  await expect(runCalls()).resolves.toEqual({ ok: false, status: 0, body: { error: connectionError } })
})

it.each([loadDesk, () => verifyLedger('a1')])('returns null after a rejected read request %#', async read => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  await expect(read()).resolves.toBeNull()
})

it.each([
  ['Run the agent', '/api/demo/run', 'run'],
  ['Pay by card', '/api/sandbox/card-pay/t', 'card'],
  ['Add chart', '/api/desk/ask', 'ask'],
  ['Verify ledger', '/api/ledger/verify/a1', 'verify'],
  ['Refund call 24', '/api/claims/k/approve', 'refund'],
  ['Agent reports call 24', '/api/demo/run', 'after'],
])('enables %s again after a rejected fetch and shows the error', async (name, route, action) => {
  const data = desk({ tabs: action === 'run' ? [] : [tab({ state: action === 'card' ? 'DUE' : 'PAID' })], claims: action === 'refund' ? [claim()] : [] })
  mockDesk(data, route)
  render(<App license={null} />)
  await screen.findByRole('region', { name: 'Try to break it' })
  if (action === 'ask') fireEvent.change(screen.getByLabelText('Ask the desk'), { target: { value: 'struck calls' } })
  fireEvent.click(screen.getByRole('button', { name }))
  const message = action === 'verify' ? await screen.findByText('Could not verify ledger.') : await screen.findByRole('alert')
  expect(message.textContent).toBe(action === 'verify' ? 'Could not verify ledger.' : connectionError)
  await waitFor(() => expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false))
})

it('shows Refunding until the seller request settles and then shows the server reason', async () => {
  const data = desk({ claims: [claim()] })
  const fetch = mockDesk(data)
  let finish!: (value: ReturnType<typeof response>) => void
  fetch.mockImplementationOnce(async () => response({ ws_id: 'demo', agents: [] }))
  render(<App license={null} />)
  await screen.findByRole('region', { name: 'Try to break it' })
  fetch.mockImplementation(async input => String(input) === '/api/claims/k/approve' ? new Promise(resolve => { finish = resolve }) : response(data))
  fireEvent.click(screen.getByRole('button', { name: 'Refund call 24' }))
  expect((screen.getByRole('button', { name: 'Refunding' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => finish(response({ reason: 'The capture is not ready.' }, 409)))
  expect((await screen.findByRole('alert')).textContent).toBe('The capture is not ready.')
  expect((screen.getByRole('button', { name: 'Refund call 24' }) as HTMLButtonElement).disabled).toBe(false)
})

it('shows a rejected session error without leaving an opening status', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  render(<App license={null} />)
  expect((await screen.findByRole('alert')).textContent).toBe(connectionError)
  expect(screen.queryByRole('status')).toBeNull()
})

it('retries rejected polls at 3, 6 and 10 seconds and resets after success', async () => {
  vi.useFakeTimers()
  const data = desk()
  const fetch = mockDesk(data)
  let polls = 0
  fetch.mockImplementation(async input => {
    if (String(input) === '/api/desk/data') {
      polls++
      if (polls <= 3) throw new Error('offline')
      return response(data)
    }
    return response({ ws_id: 'demo', agents: [] })
  })
  render(<App license={null} />)
  await act(async () => {})
  expect(polls).toBe(1)
  for (const [delay, count] of [[3000, 2], [6000, 3], [10000, 4], [3000, 5]]) {
    await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1) })
    expect(polls).toBe(count - 1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(polls).toBe(count)
  }
  cleanup()
  expect(vi.getTimerCount()).toBe(0)
})

it.each([true, false])('renders the check scope beside the bill with phone %s', async narrow => {
  vi.stubGlobal('matchMedia', () => ({ matches: narrow, addEventListener() {}, removeEventListener() {} }))
  mockDesk(desk())
  render(<App license={null} />)
  const summary = await screen.findByTestId('tab-summary')
  const note = within(summary).getByText(CHECK_SCOPE)
  if (narrow) {
    const form = await screen.findByRole('region', { name: 'Try to break it' })
    expect(note.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  }
})

it('shows five newest phone ledger rows and expands all thirty after the claim form without claim actions', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  const calls = Array.from({ length: 30 }, (_, i) => call({ id: `c${i + 1}`, seq: i + 1, status: 'STRUCK' }))
  mockDesk(desk({ calls }))
  const view = render(<App license={null} />)
  const show = await screen.findByRole('button', { name: 'Show all 30' })
  const rows = view.container.querySelectorAll('.rt-ledger-row')
  expect(rows).toHaveLength(5)
  expect(rows[0].textContent).toContain('call 30')
  expect(view.queryByRole('button', { name: 'Claim this call' })).toBeNull()
  const form = screen.getByRole('region', { name: 'Try to break it' })
  const summary = screen.getByTestId('tab-summary')
  expect(summary.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(form.compareDocumentPosition(rows[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect([...view.container.querySelectorAll('.rt-phone > section')].map(s => s.querySelector('h2')?.textContent)).toEqual(['Tabs', 'Money', 'Struck and refunded'])
  fireEvent.click(show)
  expect(view.container.querySelectorAll('.rt-ledger-row')).toHaveLength(30)
})

it('selects a billable call from the receipt and focuses the reason', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  const scroll = vi.fn()
  const original = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = scroll
  try {
    mockDesk(desk({ calls: [call({ seq: 23, id: 'c23', status: 'BILLABLE' }), call()] }))
    const view = render(<App license={null} />)
    await screen.findByRole('region', { name: 'Try to break it' })
    const row = screen.getByText('Call 23, convert_time, $0.25', { selector: 'span' }).closest('li')!
    fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Claim this call' }))
    expect((screen.getByLabelText('Call') as HTMLSelectElement).value).toBe('c23')
    expect(document.activeElement).toBe(screen.getByLabelText('Reason for claim'))
    expect(scroll).toHaveBeenCalled()
  } finally { HTMLElement.prototype.scrollIntoView = original }
})

it('only offers billable or refunded calls on paid tabs, including refunded calls for repeat-claim trials', () => {
  render(<TryPanel agents={[agent]} {...{ calls: [call(), call({ id: 'unpaid', seq: 25, tab_id: 'due' }), call({ id: 'struck', seq: 23, status: 'STRUCK' }), call({ id: 'refunded', seq: 22, status: 'REFUNDED' })], tabs: [tab(), tab({ id: 'due', state: 'DUE' })], triesLeft: 5 }} />)
  expect(screen.getByRole('option', { name: 'Scheduler bot, call 24, convert_time, $0.25' })).toBeTruthy()
  expect(screen.getByRole('option', { name: 'Scheduler bot, call 22, convert_time, $0.25' })).toBeTruthy()
  expect(screen.queryByRole('option', { name: /Call 23/ })).toBeNull()
  expect(screen.queryByRole('option', { name: /Call 25/ })).toBeNull()
})

it('keeps the empty claim state for an unpaid billable call', () => {
  render(<TryPanel agents={[agent]} {...{ calls: [call()], tabs: [tab({ state: 'DUE' })], triesLeft: 5 }} />)
  expect(screen.getByText('Run the agent and pay a tab to try a claim.')).toBeTruthy()
  expect(screen.queryByRole('combobox')).toBeNull()
})

it('keeps the combined log in a section the visitor can fold', () => {
  const view = render(<Panel trace={[]} events={[]} />)
  const summary = screen.getByText('PayPal and model log')
  expect(summary.tagName).toBe('SUMMARY')
  expect(view.container.querySelector('details .rt-panel')).toBeTruthy()
})

it('uses a 320 px side column on wide screens', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
  expect(css).toMatch(/\.rt-main\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 320px/)
})

it('keeps the Studio calls report as the original AG Grid widget', () => {
  const report = readFileSync(resolve(process.cwd(), 'src/studio/report.ts'), 'utf8')
  const widgets = readFileSync(resolve(process.cwd(), 'src/studio/widgets.tsx'), 'utf8')
  expect(report).toContain("type: 'grid'")
  expect(report).toContain("f('calls.call'), f('calls.agent'), f('calls.tool'), f('calls.status'), f('calls.reason'), f('calls.judged_by'), f('calls.price'), f('calls.seconds')")
  expect(widgets).not.toContain('rt-call-ledger')
})

it('keeps Agent reports call 24 after a rejected claim on another call, and hides it once call 24 is claimed', async () => {
  const calls = [call(), call({ id: 'c30', seq: 30 })]
  const rejected = claim({ id: 'k30', call_id: 'c30', call_seq: 30, state: 'REJECTED', verdict: 'reject' })
  mockDesk(desk({ calls, claims: [rejected] }))
  const view = render(<App license={null} />)
  await screen.findByRole('region', { name: 'Try to break it' })
  expect(await screen.findByRole('button', { name: 'Agent reports call 24' })).toBeTruthy()
  view.unmount()
  mockDesk(desk({ calls, claims: [rejected, claim({ state: 'REFUNDED', refund_status: 'COMPLETED' })] }))
  render(<App license={null} />)
  await screen.findByRole('region', { name: 'Try to break it' })
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Agent reports call 24' })).toBeNull())
})
