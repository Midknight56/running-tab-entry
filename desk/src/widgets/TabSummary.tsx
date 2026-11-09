import { useContext, type ReactNode } from 'react'
import { ClaimSelection } from '../claim-selection'
import { CopyBlock } from '../ConnectCard'
import { usd, type Agent, type Call, type Claim, type Tab } from '../types'
import { currentTabs } from './TabMeter'
import { billTab } from '../selection'

interface BillRow { label: string; cents: number; detail?: string; kind?: 'struck' | 'total' }

export function billRows(tab: Tab, calls: Call[]): BillRow[] {
  const mine = calls.filter(c => c.tab_id === tab.id)
  const tools = new Map<string, { count: number; cents: number }>()
  for (const c of mine.filter(c => c.status === 'BILLABLE' || c.status === 'REFUNDED')) {
    const row = tools.get(c.tool) ?? { count: 0, cents: 0 }
    row.count++; row.cents += c.price_cents
    tools.set(c.tool, row)
  }
  const toolSum = [...tools.values()].reduce((sum, row) => sum + row.cents, 0)
  const rows: BillRow[] = []

  if (tab.state === 'PAID') {
    const captured = tab.captured_cents || tab.total_cents
    if (toolSum === captured) {
      rows.push(...[...tools].map(([tool, row]) => ({ label: `${tool} x ${row.count}`, cents: row.cents })).sort((a, b) => b.cents - a.cents))
    }
    const struck = mine.filter(c => c.status === 'STRUCK')
    const struckCents = struck.reduce((sum, c) => sum + c.price_cents, 0)
    const metered = mine.reduce((sum, c) => sum + (c.price_cents || 0), 0) || (tab.plain_meter_cents ?? (captured + struckCents))
    rows.push({ label: 'Metered call value', cents: metered })
    rows.push({
      label: 'Struck before payment',
      cents: struckCents,
      kind: 'struck',
      ...(struck.length ? { detail: `${struck.length} ${struck.length === 1 ? 'call' : 'calls'}` } : {}),
    })
    rows.push({ label: 'Captured', cents: captured, kind: 'total' })
    const done = tab.refunded_done_cents ?? tab.refunded_cents ?? 0
    const pending = tab.refund_pending_cents ?? 0
    if (done > 0) rows.push({ label: 'Refund completed', cents: done })
    if (pending > 0) rows.push({ label: 'Refund pending', cents: pending })
    rows.push({ label: 'Net paid', cents: captured - done, kind: 'total' })
    return rows
  }

  if (toolSum === tab.total_cents) {
    rows.push(...[...tools].map(([tool, row]) => ({ label: `${tool} x ${row.count}`, cents: row.cents })).sort((a, b) => b.cents - a.cents))
  }
  rows.push({ label: 'Total', cents: tab.total_cents, kind: 'total' })
  const struck = mine.filter(c => c.status === 'STRUCK')
  if (struck.length && rows.some(row => row.kind === 'total')) rows.push({ label: 'Struck, not billed', detail: `${struck.length} ${struck.length === 1 ? 'call' : 'calls'}`, cents: struck.reduce((sum, c) => sum + c.price_cents, 0), kind: 'struck' })
  return rows
}

const LABEL = { OPEN: 'Open', DUE: 'Due', PAID: 'Paid' }

/** A call's request in one line, so two billed calls can be compared side by side. */
export const argsText = (args: Record<string, unknown>) =>
  Object.entries(args).map(([key, value]) => `${key} ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`).join(', ')

/** What the checks cover, said next to the bill. */
export const CHECK_SCOPE = 'Checks strike only what they test: errors, missing parts, a wrong converted time, and answers off the request. A wrong answer no check catches is still billed.'

export function TabSummary({ agent, tabs, calls, claims = [], children }: { agent?: Agent; tabs: Tab[]; calls: Call[]; claims?: Claim[]; children?: ReactNode }) {
  const pickClaim = useContext(ClaimSelection)
  if (!agent) return null
  const mine = tabs.filter(t => t.agent_id === agent.id && t.note !== 'demo history')
  const tab = billTab(agent, tabs) ?? currentTabs([agent], tabs)[0].tab
  const state = tab?.state ?? 'OPEN'
  const receipt = tab && state !== 'OPEN'
  const billed = calls.filter(c => c.tab_id === tab?.id && (c.status === 'BILLABLE' || c.status === 'REFUNDED')).length
  const struck = calls.filter(c => c.tab_id === tab?.id && c.status === 'STRUCK').length
  const line = state === 'PAID' ? 'Nothing left to pay on this tab.' : state === 'DUE'
    ? `${billed} ${billed === 1 ? 'call' : 'calls'} billed.${struck ? ` ${struck} struck ${struck === 1 ? 'call' : 'calls'} cost nothing.` : ''}`
    : `Nothing due yet. This tab comes due at ${usd(tab?.threshold_cents ?? 500)}.`
  const held = calls.some(c => c.tab_id === tab?.id && c.status === 'PENDING_AUDIT')
  const claimWaiting = claims.some(k => k.agent_id === agent.id && k.state === 'WAITING_SELLER')
  const refundPending = (tab?.refund_pending_cents ?? 0) > 0
  const paymentChecking = state === 'DUE' && !!tab?.payment_checking
  return <section className={`rt-sum${receipt ? ' rt-sum-bill' : ''}`} aria-label="Your tab" data-testid="tab-summary">
    <div className="rt-sum-main">
      <div className="rt-sum-head"><span>{agent.name}'s tab</span><span className={`rt-pill rt-pill-${state.toLowerCase()}`}>{LABEL[state]}</span></div>
      <div className={`rt-sum-amount rt-sum-${state.toLowerCase()}`} data-testid="sum-amount">{usd(tab?.total_cents ?? 0)}</div>
      <p data-testid="sum-line">{line}</p>
      {state === 'PAID' && tab?.capture_id && <p className="rt-sum-capture" data-testid="bill-capture">PayPal capture {tab.capture_id}</p>}
      <div className="rt-sum-actions">{children}</div>
      {held && <p className="rt-sum-state" data-testid="audit-held">Check unavailable. Call held, not billed.</p>}
      {paymentChecking && <p className="rt-sum-state" data-testid="payment-uncertain">Payment response not received. Checking with PayPal.</p>}
      {claimWaiting && <p className="rt-sum-state" data-testid="claim-waiting">Claim waiting for the seller.</p>}
      {refundPending && <p className="rt-sum-state" data-testid="refund-pending">Refund pending at PayPal.</p>}
      {tab && state === 'DUE' && <>
        <CopyBlock label="Pay link" text={`${location.origin}/pay/${tab.id}`} />
      </>}
    </div>
    {receipt && <table className="rt-receipt" aria-label="Bill"><tbody>
      {billRows(tab, calls).map(row => <tr key={row.label} className={row.kind ? `rt-receipt-${row.kind}` : undefined}>
        <th scope="row">{row.label}{row.detail && <span> {row.detail}</span>}</th>
        <td>{row.cents < 0 ? `-${usd(-row.cents)}` : usd(row.cents)}</td>
      </tr>)}
    </tbody></table>}
    <p className="rt-scope rt-sum-scope">{CHECK_SCOPE}</p>
    {state === 'PAID' && pickClaim && <details className="rt-billed">
      <summary>Billed calls</summary>
      <ul className="rt-billed-list">
        {calls.filter(c => c.tab_id === tab?.id && c.status === 'BILLABLE').sort((a, b) => b.seq - a.seq).map(c => <li key={c.id}>
          <span className="rt-billed-what"><span>Call {c.seq}, {c.tool}, {usd(c.price_cents)}</span>
            <span className="rt-billed-request" data-testid="billed-request">{argsText(c.args ?? {})}</span></span>
          <button className="rt-btn rt-claim" onClick={() => pickClaim(c.id)}>Claim this call</button>
        </li>)}
      </ul>
    </details>}
  </section>
}
