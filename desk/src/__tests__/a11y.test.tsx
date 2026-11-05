import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { Panel } from '../Panel'
import { contrastPairs, contrastRatio } from '../contrast'
import { MoneyFlow } from '../widgets/MoneyFlow'
import { TabMeter } from '../widgets/TabMeter'

describe('accessibility', () => {
  it('exposes tab progress values with agent names', () => {
    render(<TabMeter agents={[{ id: 'a1', name: 'Scheduler bot', created_at: 1 }]} tabs={[{ id: 't1', agent_id: 'a1', state: 'DUE', total_cents: 250, threshold_cents: 500, order_id: null, capture_id: null, captured_cents: 0, refunded_cents: 0, note: null, created_at: 1, due_at: null, paid_at: null }]} />)
    const bar = screen.getByRole('progressbar', { name: 'Scheduler bot tab' })
    expect(bar.getAttribute('aria-valuenow')).toBe('50')
    expect(bar.getAttribute('aria-valuemin')).toBe('0')
    expect(bar.getAttribute('aria-valuemax')).toBe('100')
  })

  it('exposes money labels and values as terms and definitions', () => {
    const { container } = render(<MoneyFlow money={{ captured_cents: 515, refunded_cents: 25, struck_cents: 55, pending_cents: 0, net_cents: 490, plain_meter_cents: 570, kept_cents: 490, kept_out_cents: 80 }} />)
    const pairs: Array<[string, string]> = [['Captured', '$5.15'], ['Struck, not billed', '$0.55'], ['Refunded', '$0.25'], ['Net', '$4.90']]
    for (const [label, value] of pairs) {
      const term = screen.getByText(label, { selector: 'dt' })
      const cell = term.closest('dl')!
      expect(within(cell).getByText(value, { selector: 'dd' }).tagName).toBe('DD')
    }
    expect(container.querySelectorAll('.rt-flow-value[data-testid]')).toHaveLength(4)
  })

  it('exposes money bars with labels and values', () => {
    const { container } = render(<MoneyFlow money={{ captured_cents: 515, refunded_cents: 25, struck_cents: 55, pending_cents: 0, net_cents: 490, plain_meter_cents: 570, kept_cents: 490, kept_out_cents: 80 }} />)
    expect(within(container).getByRole('progressbar', { name: 'Plain meter' }).getAttribute('aria-valuenow')).toBe('100')
    expect(within(container).getByRole('progressbar', { name: 'Running Tab' }).getAttribute('aria-valuenow')).toBe('86')
    expect(container.querySelector('.rt-flow-bars')?.getAttribute('aria-label')).toBe('Plain meter and Running Tab comparison')
    expect(container.textContent).toContain('A plain meter bills $5.70. Running Tab charges $4.90 after refunds. The $0.80 gap: $0.55 struck, $0.25 refunded.')
    expect(container.querySelectorAll('.rt-flow-bar-row')).toHaveLength(2)
  })

  it('marks the panel list as a polite live region', () => {
    render(<Panel trace={[]} events={[]} />)
    expect(screen.getByRole('list', { name: 'Behind the scenes', hidden: true }).getAttribute('aria-live')).toBe('polite')
  })

  it('keeps every checked themed text pair at 4.5:1 or higher', () => {
    for (const pair of contrastPairs) {
      expect(contrastRatio(pair.foreground, pair.background), `${pair.theme}: ${pair.name}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})

it('uses a 24 hour panel time even with a 12 hour locale', () => {
  const original = Date.prototype.toLocaleTimeString
  const spy = vi.spyOn(Date.prototype, 'toLocaleTimeString').mockImplementation(function (this: Date, _locales, options) { return original.call(this, 'en-US', options) })
  try {
    const view = render(<Panel trace={[]} events={[{ id: 'e', event_type: 'test', verification: 'SUCCESS', resource_id: null, outcome: null, received_at: new Date(2026, 0, 1, 13, 32, 32).getTime() }]} />)
    expect(view.container.querySelector('.rt-panel-time')?.textContent).toBe('13:32:32')
  } finally { spy.mockRestore() }
})
