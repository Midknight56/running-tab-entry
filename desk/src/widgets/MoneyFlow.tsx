// Widget 3: captured, struck, refunded and net. Captured and refunded come from stored PayPal
// responses; net is captured minus refunded.
import type { Money } from '../types'
import { usd } from '../types'

export function MoneyFlow({ money }: { money: Money }) {
  const net = money.captured_cents - money.refunded_cents
  const pendingRefund = money.refund_pending_cents ?? 0
  const cells = [
    { label: 'Captured', value: money.captured_cents, cls: 'captured' },
    { label: 'Struck, not billed', value: money.struck_cents, cls: 'struck' },
    { label: 'Refunded', value: money.refunded_cents, cls: 'refunded' },
    { label: 'Net', value: net, cls: 'net' },
  ]
  const plain = Math.max(0, money.plain_meter_cents)
  const bars = [
    { label: 'Plain meter', value: plain, cls: 'plain', width: 100 },
    { label: 'Running Tab', value: money.kept_cents, cls: 'kept', width: plain ? Math.min(100, Math.max(0, money.kept_cents / plain * 100)) : 0 },
  ]
  const gap = money.kept_out_cents
  const parts = [
    money.struck_cents > 0 ? `${usd(money.struck_cents)} struck` : null,
    money.refunded_cents > 0 ? `${usd(money.refunded_cents)} refunded` : null,
    money.pending_cents > 0 ? `${usd(money.pending_cents)} waiting on audit` : null,
  ].filter(Boolean)
  const reconciled = money.struck_cents + money.refunded_cents + money.pending_cents === gap
  return (
    <div className="rt-flow">
      {cells.map((c) => (
        <dl key={c.cls} className={`rt-flow-cell rt-flow-${c.cls}`}>
          <dt className="rt-flow-label">{c.label}</dt>
          <dd className="rt-flow-value" data-testid={`flow-${c.cls}`}>{usd(c.value)}</dd>
        </dl>
      ))}
      {pendingRefund > 0 && <p className="rt-flow-line">Refund pending: {usd(pendingRefund)}</p>}
      <p className="rt-flow-line" data-testid="flow-line">
        A plain meter bills {usd(money.plain_meter_cents)}. Running Tab charges {usd(money.kept_cents)} after refunds.
        {gap > 0 && <> The {usd(gap)} gap{reconciled && parts.length > 0 ? `: ${parts.join(', ')}.` : '.'}</>}
        {pendingRefund > 0 && <> {usd(pendingRefund)} pending at PayPal is still included in the charge.</>}
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
    </div>
  )
}
