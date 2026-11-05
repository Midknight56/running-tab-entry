import { useContext, type ReactNode } from 'react'
import { ClaimSelection } from '../claim-selection'
import { CopyBlock } from '../ConnectCard'
import { usd, type Agent, type Call, type Tab } from '../types'
import { currentTabs } from './TabMeter'

interface BillRow { label: string; cents: number; detail?: string; kind?: 'struck' | 'total' }

export function billRows(tab: Tab, calls: Call[]): BillRow[] {
  const mine = calls.filter(c => c.tab_id === tab.id)
  const tools = new Map<string, { count: number; cents: number }>()
  for (const c of mine.filter(c => c.status === 'BILLABLE' || c.status === 'REFUNDED')) {
    const row = tools.get(c.tool) ?? { count: 0, cents: 0 }
    row.count++; row.cents += c.price_cents
    tools.set(c.tool, row)
  }
  const rows: BillRow[] = []
  if ([...tools.values()].reduce((sum, row) => sum + row.cents, 0) === tab.total_cents) {
    rows.push(...[...tools].map(([tool, row]) => ({ label: `${tool} x ${row.count}`, cents: row.cents })).sort((a, b) => b.cents - a.cents))
  }
  rows.push({ label: 'Total', cents: tab.total_cents, kind: 'total' })
  if (tab.state === 'PAID') {
    const done = tab.refunded_done_cents ?? 0
    const pending = tab.refund_pending_cents ?? 0
    if (done > 0) rows.push({ label: 'Refunded', cents: -done })
    if (pending > 0) rows.push({ label: 'Refund pending', cents: pending })
    if (done > 0 || pending > 0) rows.push({ label: 'Net paid', cents: tab.total_cents - done })
  }
  const struck = mine.filter(c => c.status === 'STRUCK')
  if (struck.length && rows.some(row => row.kind === 'total')) rows.push({ label: 'Struck, not billed', detail: `${struck.length} ${struck.length === 1 ? 'call' : 'calls'}`, cents: struck.reduce((sum, c) => sum + c.price_cents, 0), kind: 'struck' })
  return rows
}

const LABEL = { OPEN: 'Open', DUE: 'Due', PAID: 'Paid' }

export function TabSummary({ agent, tabs, calls, children }: { agent?: Agent; tabs: Tab[]; calls: Call[]; children?: ReactNode }) {
  const pickClaim = useContext(ClaimSelection)
  if (!agent) return null
  const mine = tabs.filter(t => t.agent_id === agent.id && t.note !== 'demo history')
  const tab = mine.find(t => t.state === 'DUE') ?? mine.find(t => t.state === 'PAID') ?? currentTabs([agent], tabs)[0].tab
  const state = tab?.state ?? 'OPEN'
  const receipt = tab && state !== 'OPEN'
  const billed = calls.filter(c => c.tab_id === tab?.id && (c.status === 'BILLABLE' || c.status === 'REFUNDED')).length
  const struck = calls.filter(c => c.tab_id === tab?.id && c.status === 'STRUCK').length
  const line = state === 'PAID' ? 'Nothing left to pay on this tab.' : state === 'DUE'
    ? `${billed} ${billed === 1 ? 'call' : 'calls'} billed.${struck ? ` ${struck} struck ${struck === 1 ? 'call' : 'calls'} cost nothing.` : ''}`
    : `Nothing due yet. This tab comes due at ${usd(tab?.threshold_cents ?? 500)}.`
  return <section className={`rt-sum${receipt ? ' rt-sum-bill' : ''}`} aria-label="Your tab" data-testid="tab-summary">
    <div className="rt-sum-main">
      <div className="rt-sum-head"><span>{agent.name}'s tab</span><span className={`rt-pill rt-pill-${state.toLowerCase()}`}>{LABEL[state]}</span></div>
      <div className={`rt-sum-amount rt-sum-${state.toLowerCase()}`} data-testid="sum-amount">{usd(tab?.total_cents ?? 0)}</div>
      <p data-testid="sum-line">{line}</p>
      <div className="rt-sum-actions">{children}</div>
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
    {state === 'PAID' && pickClaim && <details className="rt-billed">
      <summary>Billed calls</summary>
      <ul className="rt-billed-list">
        {calls.filter(c => c.tab_id === tab?.id && c.status === 'BILLABLE').sort((a, b) => b.seq - a.seq).map(c => <li key={c.id}>
          <span>Call {c.seq}, {c.tool}, {usd(c.price_cents)}</span>
          <button className="rt-btn rt-claim" onClick={() => pickClaim(c.id)}>Claim this call</button>
        </li>)}
      </ul>
    </details>}
  </section>
}
