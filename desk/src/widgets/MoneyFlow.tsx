// Widget 3: captured, struck, refunded and net. Captured and refunded come from stored PayPal
// responses; net is captured minus refunded.
import type { Money, OpenTab, SessionMoney, TabReceipt } from '../types'
import { usd } from '../types'

export interface MoneyFlowProps {
  money: Money
  receipt?: TabReceipt | null
  open_tab?: OpenTab | null
  openTab?: OpenTab | null
  session?: SessionMoney | null
}

function sessionMoneySentence(s: SessionMoney): string {
  const prefix = `This session metered ${usd(s.metered_cents)}. ${usd(s.kept_or_billable_cents)} is kept or still billable`
  const hasStruck = s.struck_cents > 0
  const hasRefunded = s.refunded_cents > 0
  const hasPending = (s.pending_audit_cents ?? 0) > 0

  if (hasStruck && hasRefunded && hasPending) {
    return `${prefix}: ${usd(s.struck_cents)} was struck, ${usd(s.refunded_cents)} refunded, and ${usd(s.pending_audit_cents)} waiting on audit.`
  }
  if (hasStruck && hasRefunded) {
    return `${prefix}: ${usd(s.struck_cents)} was struck and ${usd(s.refunded_cents)} refunded.`
  }
  if (hasStruck && hasPending) {
    return `${prefix}: ${usd(s.struck_cents)} was struck and ${usd(s.pending_audit_cents)} waiting on audit.`
  }
  if (hasRefunded && hasPending) {
    return `${prefix}: ${usd(s.refunded_cents)} was refunded and ${usd(s.pending_audit_cents)} waiting on audit.`
  }
  if (hasStruck) {
    return `${prefix}: ${usd(s.struck_cents)} was struck.`
  }
  if (hasRefunded) {
    return `${prefix}: ${usd(s.refunded_cents)} was refunded.`
  }
  if (hasPending) {
    return `${prefix}: ${usd(s.pending_audit_cents)} waiting on audit.`
  }
  return `${prefix}.`
}

export function MoneyFlow(props: MoneyFlowProps) {
  const receipt = props.receipt ?? props.money.receipt ?? null
  const currentTab = props.openTab ?? props.open_tab ?? props.money.open_tab ?? null
  const session = props.session ?? props.money.session ?? {
    metered_cents: props.money.plain_meter_cents,
    kept_or_billable_cents: props.money.kept_cents,
    struck_cents: props.money.struck_cents,
    refunded_cents: props.money.refunded_cents,
    pending_audit_cents: props.money.pending_cents,
  }

  const receiptCells = receipt ? [
    { label: 'Metered call value', value: receipt.metered_cents, cls: 'metered', testid: 'flow-metered' },
    { label: 'Struck before payment', value: receipt.struck_cents, cls: 'struck', testid: 'flow-struck' },
    { label: 'Captured', value: receipt.captured_cents, cls: 'captured', testid: 'flow-captured' },
    { label: 'Refund completed', value: receipt.refunded_cents, cls: 'refunded', testid: 'flow-refunded' },
    ...(receipt.refund_pending_cents > 0 ? [{ label: 'Refund pending', value: receipt.refund_pending_cents, cls: 'pending', testid: 'flow-pending' }] : []),
    { label: 'Net paid', value: receipt.net_cents, cls: 'net', testid: 'flow-net', extraTestId: 'receipt-net' },
  ] : []

  const tabStateLabel = currentTab ? (currentTab.state === 'OPEN' ? 'Open' : currentTab.state === 'DUE' ? 'Due' : currentTab.state) : ''
  const plain = Math.max(0, session.metered_cents)
  const bars = [
    { label: 'Plain meter', value: plain, cls: 'plain', width: 100 },
    { label: 'Running Tab', value: session.kept_or_billable_cents, cls: 'kept', width: plain ? Math.min(100, Math.max(0, session.kept_or_billable_cents / plain * 100)) : 0 },
  ]
  const sentence = sessionMoneySentence(session)
  const pendingRefund = receipt ? receipt.refund_pending_cents : (props.money.refund_pending_cents ?? 0)

  return (
    <div className="rt-flow">
      {receipt && (
        <section className="rt-flow-group">
          <h3>Paid receipt</h3>
          {receipt.agent_name && <p className="rt-flow-id" data-testid="receipt-id">{receipt.agent_name}{receipt.capture_id ? `, PayPal capture ${receipt.capture_id}` : ''}</p>}
          <div className="rt-flow-cells">
            {receiptCells.map((c) => (
              <dl key={c.cls} className={`rt-flow-cell rt-flow-${c.cls}`} {...(c.extraTestId ? { 'data-testid': c.extraTestId } : {})}>
                <dt className="rt-flow-label">{c.label}</dt>
                <dd className="rt-flow-value" data-testid={c.testid}>{usd(c.value)}</dd>
              </dl>
            ))}
          </div>
          {receipt.refund_pending_cents > 0 && <p className="rt-flow-line">Refund pending: {usd(receipt.refund_pending_cents)}</p>}
        </section>
      )}

      {currentTab && (
        <section className="rt-flow-group">
          <h3>Current tab</h3>
          <p className="rt-flow-current" data-testid="current-tab">
            {tabStateLabel}, {usd(currentTab.total_cents)}
          </p>
        </section>
      )}

      <section className="rt-flow-group">
        <h3>Session money</h3>
        <p className="rt-flow-line" data-testid="flow-line">
          <span data-testid="session-money">{sentence}</span>
          {pendingRefund > 0 && <> {usd(pendingRefund)} of refunds is pending at PayPal and still counted as kept.</>}
        </p>
        <div className="rt-flow-bars" aria-label="Plain meter and Running Tab comparison">
          {bars.map((b) => (
            <div key={b.cls} className={`rt-flow-bar-row rt-flow-${b.cls}`} data-testid={`flow-bar-${b.cls}`}>
              <div className="rt-flow-bar-head"><span>{b.label}</span><span>{usd(b.value)}</span></div>
              <div className="rt-flow-bar-track" role="progressbar" aria-label={b.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(b.width)}>
                <div className="rt-flow-bar-fill" style={{ width: `${b.width}%` }} />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
