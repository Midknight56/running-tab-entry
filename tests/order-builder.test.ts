import { describe, expect, it } from 'vitest'
import type { Call, Tab } from '../src/tab/ledger'
import { buildOrder, lineItems } from '../src/bill/order-builder'

function call(seq: number, tool: string, price_cents: number, status: Call['status'] = 'BILLABLE'): Call {
  return {
    id: `call-${seq}`, seq, ws_id: 'ws', agent_id: 'agent', tab_id: 'tab', tool,
    args_json: '{}', result_json: '{}', price_cents, status, reason_code: null, evidence: null,
    judged_by: null, duration_ms: 1, created_at: seq,
  }
}

function tab(total_cents: number): Tab {
  return {
    id: 'tab-123', ws_id: 'ws', agent_id: 'agent', state: 'DUE', total_cents, threshold_cents: 100,
    order_id: null, capture_id: null, captured_cents: 0, refunded_cents: 0, note: null,
    created_at: 1, due_at: 2, paid_at: null,
  }
}

const urls = { return_url: 'https://example.com/return', cancel_url: 'https://example.com/cancel' }

describe('order builder', () => {
  it('groups billable calls into one item per tool and price in sequence order', () => {
    const calls = [call(1, 'alpha', 5), call(2, 'beta', 25), call(3, 'alpha', 5)]
    const result = lineItems(calls)
    expect(result.items).toHaveLength(2)
    expect(result.items.map((item) => [item.name, item.quantity])).toEqual([['alpha calls', '2'], ['beta calls', '1']])
    const itemTotal = result.items.reduce((sum, item) => sum + Number(item.quantity) * Math.round(Number(item.unit_amount.value) * 100), 0)
    const unit = buildOrder(tab(35), calls, { urls }).purchase_units as Array<Record<string, any>>
    expect(unit[0].amount.breakdown.item_total.value).toBe('0.35')
    expect(Number(unit[0].amount.breakdown.item_total.value) * 100).toBe(itemTotal)
    expect(unit[0].amount.value).toBe(unit[0].amount.breakdown.item_total.value)
    expect(unit[0].custom_id.startsWith('rt-')).toBe(true)
  })

  it('excludes struck, pending audit, and refunded calls', () => {
    const result = lineItems([
      call(1, 'billable', 10), call(2, 'struck', 100, 'STRUCK'),
      call(3, 'pending', 100, 'PENDING_AUDIT'), call(4, 'refunded', 100, 'REFUNDED'),
    ])
    expect(result.items.map((item) => item.sku)).toEqual(['billable'])
    expect(result.total_cents).toBe(10)
  })

  it('rejects a tab total that differs from its billable calls', () => {
    expect(() => buildOrder(tab(11), [call(1, 'one', 10)], { urls })).toThrow('tab total does not match its billable calls')
  })

  it('uses the card payment source without PayPal experience context', () => {
    const card = { number: '4111111111111111', expiry: '2030-12', name: 'A Person', security_code: '123' }
    const order = buildOrder(tab(10), [call(1, 'one', 10)], { card })
    expect(order.payment_source).toEqual({ card })
    expect(order.payment_source).not.toHaveProperty('paypal.experience_context')
  })

  it('builds the requested dollar totals for business days and convert time', () => {
    const calls = [
      ...Array.from({ length: 12 }, (_, i) => call(i + 1, 'business_days', 5)),
      ...Array.from({ length: 18 }, (_, i) => call(i + 13, 'convert_time', 25)),
    ]
    const result = lineItems(calls)
    expect(result.items.map(({ name, quantity, unit_amount }) => [name, quantity, unit_amount.value])).toEqual([
      ['business_days calls', '12', '0.05'], ['convert_time calls', '18', '0.25'],
    ])
    const units = buildOrder(tab(510), calls, { urls }).purchase_units as Array<Record<string, any>>
    expect(units[0].amount.value).toBe('5.10')
    expect(units[0].amount.breakdown.item_total.value).toBe('5.10')
  })
})


it('anchors the highest call hash and describes each item range', () => {
  const calls = [call(3, 'alpha', 5), call(2, 'beta', 25), call(1, 'alpha', 5), Object.assign(call(4, 'bad', 25, 'STRUCK'), { chain_hash: 'abc123' })]
  const unit = (buildOrder(tab(35), calls, { urls }).purchase_units as any[])[0]
  expect(unit).toMatchObject({ custom_id: 'rt:abc123', invoice_id: 'rt-tab-123', reference_id: 'tab-123' })
  expect(unit.items.map((i: any) => i.description)).toEqual(['calls 1 to 3 of tab tab-123', 'calls 2 to 2 of tab tab-123'])
  const long = tab(5); long.id = 'x'.repeat(150)
  expect((buildOrder(long, [call(1, 'alpha', 5)], { urls }).purchase_units as any[])[0].items[0].description).toHaveLength(127)
})
