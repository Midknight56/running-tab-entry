// Widget 2: every struck call, with its reason, who struck it (code or the model) and the quoted evidence.
import { useState } from 'react'
import type { Agent, Call, Claim, Tab } from '../types'
import { requestLine } from '../Panel'
import { usd } from '../types'

export interface StruckLedgerProps { agents: Agent[]; calls: Call[]; claims: Claim[]; tabs?: Tab[]; limit?: number }

const WHO: Record<string, string> = { code: 'Code', model: 'Auditor', claim: 'Claim' }
const REASONS: Record<string, string> = { WRONG: 'Wrong time' }

export function struckRows(calls: Call[], claims: Claim[]) {
  const fromClaims = claims.filter((c) => c.refund_status !== 'NOT_DUE' && ['REFUNDED', 'REFUNDING', 'APPROVED', 'WAITING_SELLER'].includes(c.state))
  const struck = calls.filter((c) => c.status === 'STRUCK').map((c) => ({
    key: c.id, seq: c.seq, agent_id: c.agent_id, tool: c.tool, reason: c.reason_code ?? '', who: WHO[c.judged_by ?? ''] ?? '',
    evidence: c.evidence ?? '', amount: c.price_cents, refunded: false, billed: false,
    state: c.judged_by === 'claim' ? 'Struck on a claim, no refund due' : '', tab_id: c.tab_id,
    request: requestLine(c.tool, c.args ?? {}), answer: c.answer ?? '',
  }))
  const refunded = fromClaims.map((k) => {
    const call = calls.find((c) => c.id === k.call_id)
    return {
      key: k.id, seq: k.call_seq, agent_id: k.agent_id, tool: call?.tool ?? '', reason: k.reason_code ?? '', who: 'Claim',
      evidence: k.evidence ?? '', amount: call?.price_cents ?? k.price_cents ?? 0, refunded: k.state === 'REFUNDED', billed: true, tab_id: call?.tab_id,
      request: call ? requestLine(call.tool, call.args ?? {}) : '', answer: call?.answer ?? '',
      state: k.state === 'WAITING_SELLER' ? 'Awaiting the seller' : k.state === 'APPROVED' ? 'Approved, refund not sent'
        : k.state === 'REFUNDING' ? (k.refund_status === 'PENDING' ? 'Refund pending at PayPal' : 'Refund sending') : '',
    }
  })
  return [...refunded, ...struck].sort((a, b) => b.seq - a.seq)
}

export function StruckLedger({ agents, calls, claims, tabs = [], limit }: StruckLedgerProps) {
  const [showAll, setShowAll] = useState(false)
  const rows = struckRows(calls, claims)
  const shown = limit && !showAll ? rows.slice(0, limit) : rows
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? ''
  const seeded = (tabId?: string) => tabs.some((t) => t.id === tabId && t.note === 'demo history')
  const clip = (text: string) => text.length > 160 ? text.slice(0, 159) + '…' : text
  if (!rows.length) return <p className="rt-empty">No struck calls yet.</p>
  return (
    <>
    <ul className="rt-ledger">
      {shown.map((r) => (
        <li key={r.key} className="rt-ledger-row" data-reason={r.reason}>
          <div className="rt-ledger-head">
            <span className="rt-ledger-call">{name(r.agent_id)} call {r.seq}</span>
            <span className={`rt-pill rt-pill-reason`}>{REASONS[r.reason] ?? r.reason}</span>
            <span className="rt-dim">{r.who}</span>
            <span className="rt-ledger-amount">{usd(r.amount)} {r.refunded ? 'refunded' : r.billed ? 'billed' : 'not billed'}</span>
          </div>
          {seeded(r.tab_id) && <span className="rt-pill rt-pill-seeded">Seeded tab</span>}
          {r.state && <span className="rt-dim">{r.state}</span>}
          {r.request && <p className="rt-ledger-request"><span className="rt-ledger-label">Request: </span><span data-testid="struck-request">{r.request}</span></p>}
          {r.answer && <p className="rt-ledger-answer"><span className="rt-ledger-label">Answer: </span><span data-testid="struck-answer">{clip(r.answer)}</span></p>}
          {!r.evidence ? <span className="rt-dim">{r.who === 'Claim' ? '' : 'Empty answer'}</span>
            : r.evidence.startsWith('"') ? <code className="rt-evidence">{r.evidence}</code>
            : <q className="rt-evidence">{r.evidence}</q>}
        </li>
      ))}
    </ul>
    {limit && !showAll && rows.length > limit && <button className="rt-btn" onClick={() => setShowAll(true)}>Show all {rows.length}</button>}
    </>
  )
}
