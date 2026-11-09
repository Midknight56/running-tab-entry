// Fix 6: the desk guides a first visit. Steps, distinct waiting states, folded traces, scope near the bill, struck rows
// with their request and answer, and charts that leave out the seeded tab unless asked.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { deskStep, StepBar, claimLabel } from '../steps'
import { billTab, deskReceipt, newestPaid } from '../selection'
import { MoneyFlow } from '../widgets/MoneyFlow'
import { TabSummary, CHECK_SCOPE } from '../widgets/TabSummary'
import { ClaimSelection } from '../claim-selection'
import { StruckLedger } from '../widgets/StruckLedger'
import { Panel, TryPanel } from '../Panel'
import { studioSources } from '../data'
import type { Agent, Call, Claim, DeskData, Tab } from '../types'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const agent: Agent = { id: 'a1', name: 'Scheduler bot' } as Agent
const tab = (o: Partial<Tab> = {}): Tab => ({
  id: 't1', agent_id: 'a1', state: 'OPEN', total_cents: 0, threshold_cents: 500, order_id: null, capture_id: null,
  captured_cents: 0, refunded_cents: 0, note: null, created_at: 1, due_at: null, paid_at: null, ...o,
})
const call = (o: Partial<Call> = {}): Call => ({
  id: 'c1', seq: 1, agent_id: 'a1', tab_id: 't1', tool: 'convert_time', args: { time: '09:00', to: 'Europe/London' },
  answer: 'London has mild weather this week.', price_cents: 25, status: 'BILLABLE', reason_code: null, evidence: null,
  judged_by: null, duration_ms: 10, created_at: 1, ...o,
})
const claim = (o: Partial<Claim> = {}): Claim => ({
  id: 'k1', call_id: 'c24', call_seq: 24, agent_id: 'a1', reason_text: 'paid twice', verdict: null, reason_code: null,
  evidence: null, refund_id: null, refund_status: null, state: 'WAITING_SELLER', created_at: 1, ...o,
})

describe('deskStep', () => {
  it.each([
    ['no tab', undefined, undefined, false, 1],
    ['an open tab', tab(), undefined, false, 1],
    ['a due tab', tab({ state: 'DUE' }), undefined, false, 2],
    ['a due tab while paying', tab({ state: 'DUE' }), undefined, true, 3],
    ['a paid tab with no claim', tab({ state: 'PAID' }), undefined, false, 4],
    ['a paid tab with a claim', tab({ state: 'PAID' }), claim(), false, 4],
  ] as const)('%s is step %s', (_name, t, k, paying, step) => {
    expect(deskStep(t, k, paying)).toBe(step)
  })

  it('names each claim state', () => {
    expect(claimLabel(undefined)).toBe('No claim yet')
    expect(claimLabel(claim())).toBe('Claim waiting for the seller')
    expect(claimLabel(claim({ state: 'REFUNDING', refund_status: 'PENDING' }))).toBe('Refund pending at PayPal')
    expect(claimLabel(claim({ state: 'REFUNDED' }))).toBe('Refunded')
    expect(claimLabel(claim({ state: 'REJECTED' }))).toBe('Claim rejected')
  })

  it('marks the current step and shows the claim state on step 4', () => {
    render(<StepBar step={4} claim={claim()} />)
    const current = document.querySelector('[aria-current="step"]')
    expect(current?.textContent).toContain('Review claim')
    expect(screen.getByText('Claim waiting for the seller')).toBeTruthy()
    expect(screen.getAllByRole('listitem').map(li => li.textContent?.replace(/\s+/g, ' ').trim().slice(0, 14))).toEqual(
      ['1 Run calls', '2 Review bill', '3 Pay', expect.stringMatching(/^4 Review claim/)])
  })
})

describe('waiting states', () => {
  it('a held call says the check was unavailable', () => {
    render(<TabSummary agent={agent} tabs={[tab({ state: 'DUE', total_cents: 515 })]} calls={[call({ status: 'PENDING_AUDIT' })]} />)
    expect(screen.getByTestId('audit-held').textContent).toBe('Check unavailable. Call held, not billed.')
  })
  it('a claim waiting for the seller says so', () => {
    render(<TabSummary agent={agent} tabs={[tab({ state: 'PAID', total_cents: 515, captured_cents: 515 })]} calls={[]} claims={[claim()]} />)
    expect(screen.getByTestId('claim-waiting').textContent).toBe('Claim waiting for the seller.')
  })
  it('a refund PayPal has not confirmed says so', () => {
    render(<TabSummary agent={agent} tabs={[tab({ state: 'PAID', total_cents: 515, captured_cents: 515, refund_pending_cents: 25 })]} calls={[]} />)
    expect(screen.getByTestId('refund-pending').textContent).toBe('Refund pending at PayPal.')
  })
  it('a payment whose answer was lost says it is being checked', () => {
    render(<TabSummary agent={agent} tabs={[tab({ state: 'DUE', total_cents: 515, payment_checking: true })]} calls={[]} />)
    expect(screen.getByTestId('payment-uncertain').textContent).toBe('Payment response not received. Checking with PayPal.')
  })
  it('a plain due tab shows none of them', () => {
    render(<TabSummary agent={agent} tabs={[tab({ state: 'DUE', total_cents: 515 })]} calls={[call()]} />)
    for (const id of ['audit-held', 'claim-waiting', 'refund-pending', 'payment-uncertain']) expect(screen.queryByTestId(id)).toBeNull()
  })
  it('the scope line sits beside the bill', () => {
    render(<TabSummary agent={agent} tabs={[tab({ state: 'DUE', total_cents: 515 })]} calls={[]} />)
    expect(screen.getByTestId('tab-summary').textContent).toContain(CHECK_SCOPE)
    expect(CHECK_SCOPE).not.toMatch(/does not check the math/)
  })
})

describe('struck rows', () => {
  it('keep the request and the answer on their own labelled lines, never run together', () => {
    render(<StruckLedger agents={[agent]} calls={[call({ status: 'STRUCK', reason_code: 'OFF_REQUEST', judged_by: 'model', evidence: 'London has mild weather' })]} claims={[]} />)
    const request = screen.getByTestId('struck-request').closest('p')
    const answer = screen.getByTestId('struck-answer').closest('p')
    expect(request).not.toBeNull()
    expect(answer).not.toBeNull()
    expect(request).not.toBe(answer)
    expect(request!.textContent).toBe('Request: convert_time time 09:00, to Europe/London')
    expect(answer!.textContent).toBe('Answer: London has mild weather this week.')
    expect(document.querySelector('.rt-ledger-row')!.textContent).not.toContain('Europe/LondonLondon')
  })
  it('show the request, the answer, the decision, the evidence and the price together', () => {
    render(<StruckLedger agents={[agent]} calls={[call({ status: 'STRUCK', reason_code: 'OFF_REQUEST', judged_by: 'model', evidence: 'London has mild weather' })]} claims={[]} />)
    expect(screen.getByTestId('struck-request').textContent).toBe('convert_time time 09:00, to Europe/London')
    expect(screen.getByTestId('struck-answer').textContent).toBe('London has mild weather this week.')
    const row = document.querySelector('.rt-ledger-row')!
    expect(row.textContent).toContain('OFF_REQUEST')
    expect(row.textContent).toContain('Auditor')
    expect(row.textContent).toContain('London has mild weather')
    expect(row.textContent).toContain('$0.25 not billed')
  })
  it('label seeded rows as the seeded tab', () => {
    render(<StruckLedger agents={[agent]} tabs={[tab({ id: 'h1', note: 'demo history' })]} calls={[call({ tab_id: 'h1', status: 'STRUCK', reason_code: 'EMPTY', judged_by: 'code' })]} claims={[]} />)
    expect(screen.getByText('Seeded tab')).toBeTruthy()
  })
})

describe('TryPanel', () => {
  it('says a refund is pending at PayPal after an upheld claim', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ state: 'REFUNDING', verdict: 'approve', tries_left: 4 }), { status: 200 })))
    render(<TryPanel agents={[agent]} calls={[call()]} tabs={[tab({ state: 'PAID' })]} triesLeft={5} />)
    fireEvent.change(screen.getByLabelText('Reason for claim'), { target: { value: 'paid twice' } })
    fireEvent.click(screen.getByRole('button', { name: 'Try claim' }))
    expect(await screen.findByText('Refund pending at PayPal.')).toBeTruthy()
  })
})

describe('charts and the seeded tab', () => {
  const data = {
    ws_id: 'w', agents: [agent], claims: [], events: [], trace: [],
    money: { captured_cents: 0, refunded_cents: 0, struck_cents: 0, pending_cents: 0, net_cents: 0, plain_meter_cents: 0, kept_cents: 0, kept_out_cents: 0 },
    tabs: [tab(), tab({ id: 'h1', note: 'demo history', state: 'PAID' })],
    calls: [call(), call({ id: 'c2', seq: 2 }), call({ id: 'h', seq: 1, tab_id: 'h1' })],
  } as unknown as DeskData
  it('leave out the seeded tab by default', () => {
    const calls = studioSources(data).find(s => s.id === 'calls')!.data as { history: string }[]
    expect(calls).toHaveLength(2)
    expect(calls.every(c => c.history === 'This session')).toBe(true)
    expect(studioSources(data).find(s => s.id === 'tabs')!.data).toHaveLength(1)
  })
  it('include it, labelled, when asked', () => {
    const calls = studioSources(data, { includeHistory: true }).find(s => s.id === 'calls')!.data as { history: string }[]
    expect(calls).toHaveLength(3)
    expect(calls.filter(c => c.history === 'Seeded tab')).toHaveLength(1)
  })
})

describe('payment log', () => {
  it('is open inside Payment details, so one click shows the PayPal calls and the webhook', () => {
    const { container } = render(<Panel trace={[]} events={[]} />)
    const log = container.querySelector('details.rt-log') as HTMLDetailsElement
    expect(log).not.toBeNull()
    expect(log.open).toBe(true)
  })
})

describe('one receipt selection', () => {
  const sched = { id: 'a1', name: 'Scheduler bot', created_at: 1 }
  const travel = { id: 'a2', name: 'Travel desk agent', created_at: 2 }
  const paidOld = { id: 't_old', agent_id: 'a1', state: 'PAID', total_cents: 515, threshold_cents: 500, order_id: 'O1', capture_id: 'CAP_OLD', captured_cents: 515, refunded_cents: 0, note: null, created_at: 1, due_at: 2, paid_at: 3 } as Tab
  const paidNew = { ...paidOld, id: 't_new', capture_id: 'CAP_NEW', created_at: 10, due_at: 11, paid_at: 12 } as Tab
  const otherPaid = { ...paidOld, id: 't_b', agent_id: 'a2', capture_id: 'CAP_B', created_at: 20, due_at: 21, paid_at: 22 } as Tab
  const receipt = (tab: Tab) => ({ tab_id: tab.id, agent_id: tab.agent_id, capture_id: tab.capture_id, order_id: tab.order_id, metered_cents: 550, struck_cents: 35, captured_cents: 515, refunded_cents: 0, refund_pending_cents: 0, net_cents: 515 })

  it('the bill and the money widget pick the same tab: the scheduler newest paid tab', () => {
    const tabs = [paidOld, paidNew, otherPaid]
    expect(newestPaid(tabs.filter(t => t.agent_id === 'a1'))?.id).toBe('t_new')
    expect(billTab(sched, tabs)?.id).toBe('t_new')
    const d = { agents: [sched, travel], tabs, receipts: [receipt(otherPaid), receipt(paidNew), receipt(paidOld)], money: { receipt: receipt(otherPaid) } } as unknown as DeskData
    expect(deskReceipt(d)).toMatchObject({ tab_id: 't_new', agent_name: 'Scheduler bot', capture_id: 'CAP_NEW' })
  })

  it('the money widget names the agent and the PayPal capture of its receipt', () => {
    const money = { captured_cents: 515, refunded_cents: 0, struck_cents: 35, pending_cents: 0, net_cents: 515, plain_meter_cents: 550, kept_cents: 515, kept_out_cents: 35 }
    render(<MoneyFlow money={money} receipt={{ ...receipt(paidNew), agent_name: 'Scheduler bot' }} />)
    expect(screen.getByTestId('receipt-id').textContent).toBe('Scheduler bot, PayPal capture CAP_NEW')
  })

  it('the paid bill shows the same PayPal capture', () => {
    render(<TabSummary agent={sched} tabs={[paidOld, paidNew]} calls={[]} />)
    expect(screen.getByTestId('bill-capture').textContent).toBe('PayPal capture CAP_NEW')
  })
})

describe('billed call rows', () => {
  it('show each call request, so two calls can be compared', () => {
    const paid = { id: 't', agent_id: 'a1', state: 'PAID', total_cents: 50, threshold_cents: 500, order_id: null, capture_id: 'C', captured_cents: 50, refunded_cents: 0, note: null, created_at: 1, due_at: 1, paid_at: 1 } as Tab
    const args = { time: '10:00', date: '2026-10-23', from: 'America/Toronto', to: 'Europe/Dublin' }
    const c = (id: string, seq: number) => ({ id, seq, agent_id: 'a1', tab_id: 't', tool: 'convert_time', args, answer: '', price_cents: 25, status: 'BILLABLE', reason_code: null, evidence: null, judged_by: null, duration_ms: 0, created_at: seq }) as Call
    const view = render(<ClaimSelection.Provider value={() => {}}><TabSummary agent={{ id: 'a1', name: 'Scheduler bot', created_at: 1 }} tabs={[paid]} calls={[c('c23', 23), c('c24', 24)]} /></ClaimSelection.Provider>)
    const rows = [...view.container.querySelectorAll('.rt-billed-list li')]
    const requests = rows.map(li => li.querySelector('[data-testid="billed-request"]')?.textContent)
    expect(requests).toEqual([
      'time 10:00, date 2026-10-23, from America/Toronto, to Europe/Dublin',
      'time 10:00, date 2026-10-23, from America/Toronto, to Europe/Dublin',
    ])
  })
})
