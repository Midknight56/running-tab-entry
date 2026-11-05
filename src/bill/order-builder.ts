import type { Call, Tab } from '../tab/ledger'
import { cents } from '../tab/pricing'

export interface OrderUrls { return_url: string; cancel_url: string }
export interface OrderItem {
  name: string
  description: string
  quantity: string
  unit_amount: { currency_code: 'USD'; value: string }
  category: 'DIGITAL_GOODS'
  sku: string
}

export function lineItems(calls: Call[]): { items: OrderItem[]; total_cents: number } {
  const groups = new Map<string, { tool: string; price_cents: number; count: number; first: number; last: number; tabId: string }>()
  for (const call of [...calls].sort((a, b) => a.seq - b.seq)) {
    if (call.status !== 'BILLABLE') continue
    const key = JSON.stringify([call.tool, call.price_cents])
    const group = groups.get(key)
    if (group) { group.count++; group.last = call.seq }
    else groups.set(key, { tool: call.tool, price_cents: call.price_cents, count: 1, first: call.seq, last: call.seq, tabId: call.tab_id })
  }
  let total_cents = 0
  const items = [...groups.values()].map(({ tool, price_cents, count, first, last, tabId }) => {
    total_cents += count * price_cents
    return {
      name: `${tool} calls`.slice(0, 127),
      description: `calls ${first} to ${last} of tab ${tabId}`.slice(0, 127),
      quantity: String(count),
      unit_amount: { currency_code: 'USD' as const, value: cents(price_cents) },
      category: 'DIGITAL_GOODS' as const,
      sku: tool.slice(0, 127),
    }
  })
  return { items, total_cents }
}

export function buildOrder(tab: Tab, calls: Call[], opts: {
  urls?: OrderUrls
  note?: string
  card?: { number: string; expiry: string; name: string; security_code: string }
}): Record<string, unknown> {
  const { items, total_cents } = lineItems(calls.map(call => ({ ...call, tab_id: tab.id })))
  const last = [...calls].sort((a, b) => b.seq - a.seq)[0]
  if (total_cents !== tab.total_cents) throw new Error('tab total does not match its billable calls')
  if (total_cents === 0) throw new Error('nothing to bill')
  const count = calls.filter((call) => call.status === 'BILLABLE').length
  const id = `rt-${tab.id}`
  const description = (opts.note ?? `Running Tab statement, ${count} calls`).slice(0, 127)
  let payment_source: Record<string, unknown>
  if (opts.card) {
    payment_source = { card: opts.card }
  } else {
    if (!opts.urls) throw new Error('opts.urls is required for PayPal')
    payment_source = {
      paypal: {
        experience_context: {
          return_url: opts.urls.return_url,
          cancel_url: opts.urls.cancel_url,
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
          brand_name: 'Running Tab',
        },
      },
    }
  }
  return {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: tab.id,
      // A missing seal can be retried later; it must never stop a payment.
      custom_id: last?.chain_hash ? `rt:${last.chain_hash}` : id.slice(0, 127),
      invoice_id: id.slice(0, 127),
      description,
      amount: {
        currency_code: 'USD',
        value: cents(total_cents),
        breakdown: { item_total: { currency_code: 'USD', value: cents(total_cents) } },
      },
      items,
    }],
    payment_source,
  }
}
