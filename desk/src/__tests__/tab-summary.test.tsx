import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { billRows, TabSummary } from '../widgets/TabSummary'
import { ClaimSelection } from '../claim-selection'
import type { Call, Tab } from '../types'

const agent = { id: 'a1', name: 'Scheduler bot', created_at: 1 }
const tab = (o: Partial<Tab> = {}): Tab => ({ id: 't', agent_id: 'a1', state: 'DUE', total_cents: 515, threshold_cents: 500, order_id: null, capture_id: null, captured_cents: 0, refunded_cents: 0, note: null, created_at: 1, due_at: null, paid_at: null, ...o })
const call = (o: Partial<Call> = {}): Call => ({ id: 'c', seq: 1, agent_id: 'a1', tab_id: 't', tool: 'convert_time', args: {}, answer: '', price_cents: 25, status: 'BILLABLE', reason_code: null, evidence: null, judged_by: null, duration_ms: 0, created_at: 1, ...o })
const calls = [...Array.from({ length: 19 }, () => call()), ...Array.from({ length: 8 }, () => call({ tool: 'business_days', price_cents: 5 })), ...[25, 5, 5].map(price_cents => call({ status: 'STRUCK', price_cents }))]
afterEach(cleanup)

it('groups tool rows in descending amount with struck calls after the total', () => {
  expect(billRows(tab(), [...calls, call({ tab_id: 'other' })])).toEqual([
    { label: 'convert_time x 19', cents: 475 }, { label: 'business_days x 8', cents: 40 },
    { label: 'Total', cents: 515, kind: 'total' }, { label: 'Struck, not billed', detail: '3 calls', cents: 35, kind: 'struck' },
  ])
  const rows = billRows(tab(), calls)
  const totalIndex = rows.findIndex(row => row.label === 'Total')
  expect(rows.slice(0, totalIndex).reduce((sum, row) => sum + row.cents, 0)).toBe(rows[totalIndex].cents)
  const view = render(<TabSummary agent={agent} tabs={[tab()]} calls={calls} />)
  expect(view.getByTestId('sum-line').textContent).toBe('27 calls billed. 3 struck calls cost nothing.')
  expect(view.getByLabelText('Bill').textContent).toContain('$0.35')
  expect(view.container.textContent).toContain('Pay link')
  expect(view.container.textContent).not.toContain('Your agent gets this link')
})
it('shows only the total while a pending call leaves the tool sum incomplete', () => {
  expect(billRows(tab(), [call(), call({ status: 'PENDING_AUDIT', price_cents: 490 })])).toEqual([{ label: 'Total', cents: 515, kind: 'total' }])
})
it('shows refunded and net paid after the total', () => {
  expect(billRows(tab({ state: 'PAID', refunded_cents: 25, refunded_done_cents: 25 }), calls).slice(-4)).toEqual([
    { label: 'Total', cents: 515, kind: 'total' }, { label: 'Refunded', cents: -25 }, { label: 'Net paid', cents: 490 },
    { label: 'Struck, not billed', detail: '3 calls', cents: 35, kind: 'struck' },
  ])
  const view = render(<TabSummary agent={agent} tabs={[tab({ state: 'PAID', refunded_cents: 25, refunded_done_cents: 25 })]} calls={calls} />)
  expect(view.getByLabelText('Bill').textContent).toContain('-$0.25')
  expect(view.getByTestId('sum-line').textContent).toBe('Nothing left to pay on this tab.')
})
it('uses singular call forms and omits an absent struck sentence', () => {
  const view = render(<TabSummary agent={agent} tabs={[tab({ total_cents: 25 })]} calls={[call(), call({ status: 'STRUCK' })]} />)
  expect(view.getByTestId('sum-line').textContent).toBe('1 call billed. 1 struck call cost nothing.')
  view.rerender(<TabSummary agent={agent} tabs={[tab({ total_cents: 25 })]} calls={[call()]} />)
  expect(view.getByTestId('sum-line').textContent).toBe('1 call billed.')
})
it('picks due before paid before the newest current tab', () => {
  const tabs = [tab({ id: 'open', state: 'OPEN', total_cents: 10, created_at: 3 }), tab({ id: 'paid', state: 'PAID', total_cents: 20 }), tab({ id: 'due', total_cents: 30 }), tab({ id: 'history', note: 'demo history', total_cents: 99, created_at: 9 })]
  const view = render(<TabSummary agent={agent} tabs={tabs} calls={[]} />)
  expect(view.getByTestId('sum-amount').textContent).toBe('$0.30')
  view.rerender(<TabSummary agent={agent} tabs={tabs.filter(t => t.id !== 'due')} calls={[]} />)
  expect(view.getByTestId('sum-amount').textContent).toBe('$0.20')
  view.rerender(<TabSummary agent={agent} tabs={tabs.filter(t => t.state === 'OPEN' || t.note)} calls={[]} />)
  expect(view.getByTestId('sum-amount').textContent).toBe('$0.10')
})
it('keeps the receipt rows with an agent name of 400 characters', () => {
  const view = render(<TabSummary agent={agent} tabs={[tab()]} calls={calls} />)
  const receipt = view.getByLabelText('Bill').innerHTML
  view.rerender(<TabSummary agent={{ ...agent, name: 'A'.repeat(400) }} tabs={[tab()]} calls={calls} />)
  expect(view.getByLabelText('Bill').innerHTML).toBe(receipt)
})
it('draws nothing without an agent and uses the threshold without a tab', () => {
  const view = render(<TabSummary tabs={[]} calls={[]} />)
  expect(view.container.textContent).toBe('')
  view.rerender(<TabSummary agent={agent} tabs={[]} calls={[]} />)
  expect(view.getByTestId('sum-line').textContent).toBe('Nothing due yet. This tab comes due at $5.00.')
})

it('passes the call id from the receipt', () => {
  const pick = vi.fn()
  const view = render(<ClaimSelection.Provider value={pick}><TabSummary agent={agent} tabs={[tab({ state: 'PAID' })]} calls={[call({ id: 'chosen' })]} /></ClaimSelection.Provider>)
  fireEvent.click(view.getByRole('button', { name: 'Claim this call' }))
  expect(pick).toHaveBeenCalledWith('chosen')
})
