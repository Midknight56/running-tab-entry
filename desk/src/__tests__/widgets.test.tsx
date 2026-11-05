import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { TabMeter } from '../widgets/TabMeter'
import { StruckLedger } from '../widgets/StruckLedger'
import { MoneyFlow } from '../widgets/MoneyFlow'
import type { Call, Claim, Tab } from '../types'

const agents = [{ id: 'a1', name: 'Scheduler bot', created_at: 1 }, { id: 'a2', name: 'Travel desk agent', created_at: 1 }]
const tab = (o: Partial<Tab>): Tab => ({ id: 't', agent_id: 'a1', state: 'OPEN', total_cents: 0, threshold_cents: 500, order_id: null, capture_id: null, captured_cents: 0, refunded_cents: 0, note: null, created_at: 1, due_at: null, paid_at: null, ...o })
const call = (o: Partial<Call>): Call => ({ id: 'c', seq: 1, agent_id: 'a1', tab_id: 't', tool: 'convert_time', args: {}, answer: '', price_cents: 25, status: 'BILLABLE', reason_code: null, evidence: null, judged_by: null, duration_ms: 0, created_at: 1, ...o })

describe('tab meter', () => {
  it('draws a due tab in the due colour with its amount, and skips demo history', () => {
    const { container } = render(<TabMeter agents={agents} tabs={[tab({ id: 't1', state: 'DUE', total_cents: 515 }), tab({ id: 'h', agent_id: 'a2', state: 'PAID', total_cents: 300, note: 'demo history' })]} />)
    const rows = container.querySelectorAll('.rt-meter-row')
    expect(rows[0].getAttribute('data-state')).toBe('DUE')
    expect(rows[0].className).toContain('rt-state-due')
    expect(rows[0].textContent).toContain('$5.15')
    expect(rows[1].textContent).toContain('$0.00')
  })
})

describe('struck ledger', () => {
  it('shows one row and no refund due for a call struck on a claim before billing', () => {
    const calls = [call({ id: 'c2', seq: 2, status: 'STRUCK', judged_by: 'claim', reason_code: 'DUPLICATE' })]
    const claims: Claim[] = [{ id: 'k', call_id: 'c2', call_seq: 2, agent_id: 'a1', reason_text: 'dup', verdict: 'approve', reason_code: 'DUPLICATE', evidence: null, refund_id: null, refund_status: 'NOT_DUE', state: 'APPROVED', created_at: 2 }]
    const { container } = render(<StruckLedger agents={agents} calls={calls} claims={claims} />)
    const rows = container.querySelectorAll('.rt-ledger-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('Struck on a claim, no refund due')
    expect(rows[0].textContent).toContain('$0.25 not billed')
    expect(container.textContent).not.toContain('Approved, refund not sent')
  })

  it('shows every struck row with its reason and evidence, and refunded claims', () => {
    const calls = [
      call({ id: 'c9', seq: 9, status: 'STRUCK', reason_code: 'EMPTY', judged_by: 'code', price_cents: 5 }),
      call({ id: 'c21', seq: 21, status: 'STRUCK', reason_code: 'OFF_REQUEST', judged_by: 'model', evidence: 'London has mild weather this week' }),
      call({ id: 'c24', seq: 24, status: 'REFUNDED' }),
    ]
    const claims: Claim[] = [{ id: 'k', call_id: 'c24', call_seq: 24, agent_id: 'a1', reason_text: 'dup', verdict: 'approve', reason_code: 'DUPLICATE', evidence: '"time":"16:00"', refund_id: 'R', refund_status: 'COMPLETED', state: 'REFUNDED', created_at: 2 }]
    const { container } = render(<StruckLedger agents={agents} calls={calls} claims={claims} />)
    const rows = [...container.querySelectorAll('.rt-ledger-row')]
    expect(rows.map((r) => r.getAttribute('data-reason'))).toEqual(['DUPLICATE', 'OFF_REQUEST', 'EMPTY'])
    expect(rows[0].textContent).toContain('$0.25 refunded')
    expect(rows[1].textContent).toContain('London has mild weather this week')
    expect(rows[1].textContent).toContain('Auditor')
    expect(rows[2].textContent).toContain('Empty answer')
  })
})

describe('money flow', () => {
  it('shows the plain meter, Running Tab charge and reconciled gap parts', () => {
    const { getByTestId, getByText } = render(<MoneyFlow money={{ captured_cents: 515, refunded_cents: 25, struck_cents: 55, pending_cents: 0, net_cents: 490, plain_meter_cents: 570, kept_cents: 490, kept_out_cents: 80 }} />)
    expect(getByText('A plain meter bills $5.70. Running Tab charges $4.90 after refunds. The $0.80 gap: $0.55 struck, $0.25 refunded.')).toBeTruthy()
    expect([...document.querySelectorAll('[data-testid^="flow-bar-"]')].map((e) => e.getAttribute('data-testid'))).toEqual(['flow-bar-plain', 'flow-bar-kept'])
    expect(getByTestId('flow-bar-plain').textContent).toContain('Plain meter')
    expect(getByTestId('flow-bar-kept').textContent).toContain('Running Tab')
  })

  it('shows all nonzero parts when they add up', () => {
    const { container } = render(<MoneyFlow money={{ captured_cents: 0, refunded_cents: 10, struck_cents: 20, pending_cents: 30, net_cents: 0, plain_meter_cents: 100, kept_cents: 40, kept_out_cents: 60 }} />)
    expect(container.querySelector('[data-testid="flow-line"]')?.textContent).toContain('The $0.60 gap: $0.20 struck, $0.10 refunded, $0.30 waiting on audit.')
  })

  it('leaves out parts that are zero', () => {
    const { container } = render(<MoneyFlow money={{ captured_cents: 100, refunded_cents: 0, struck_cents: 80, pending_cents: 0, net_cents: 100, plain_meter_cents: 180, kept_cents: 100, kept_out_cents: 80 }} />)
    expect(container.querySelector('[data-testid="flow-line"]')?.textContent).toContain('The $0.80 gap: $0.80 struck.')
  })

  it('omits parts when they do not add up to the gap', () => {
    const { container } = render(<MoneyFlow money={{ captured_cents: 490, refunded_cents: 25, struck_cents: 35, pending_cents: 5, net_cents: 465, plain_meter_cents: 570, kept_cents: 490, kept_out_cents: 80 }} />)
    expect(container.querySelector('[data-testid="flow-line"]')?.textContent).toBe('A plain meter bills $5.70. Running Tab charges $4.90 after refunds. The $0.80 gap.')
  })

  it('ends after after refunds when the gap is zero', () => {
    const { container } = render(<MoneyFlow money={{ captured_cents: 490, refunded_cents: 25, struck_cents: 0, pending_cents: 0, net_cents: 465, plain_meter_cents: 490, kept_cents: 490, kept_out_cents: 0 }} />)
    expect(container.querySelector('[data-testid="flow-line"]')?.textContent).toBe('A plain meter bills $4.90. Running Tab charges $4.90 after refunds.')
  })
})


it('shows the monthly budget beneath its agent', () => {
  const { container } = render(<TabMeter agents={[{ ...agents[0], budget_month_cents: 500, spent_cents: 160 }]} tabs={[]} />)
  expect(container.textContent).toContain('Budget $3.40 left of $5.00')
})
