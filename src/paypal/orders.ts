// Orders v2 and Payments v2. Request ids come from the business action, so a retry or a replay cannot charge twice:
// rt-order-{tab_id}, rt-capture-{order_id}, rt-refund-{claim_id}.
import type { PayPalClient, PayPalResult } from './client'
import { cents, toCents } from '../tab/pricing'

type PP = Pick<PayPalClient, 'request'>

export function createOrder(pp: PP, body: unknown, tabId: string, wsId: string, attempt = 1): Promise<PayPalResult> {
  const requestId = attempt > 1 ? `rt-order-${tabId}-${attempt}` : `rt-order-${tabId}`
  return pp.request('POST', '/v2/checkout/orders', { body, requestId, wsId })
}

export function captureOrder(pp: PP, orderId: string, wsId: string): Promise<PayPalResult> {
  return pp.request('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { requestId: `rt-capture-${orderId}`, wsId })
}

export function getOrder(pp: PP, orderId: string, wsId: string): Promise<PayPalResult> {
  return pp.request('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`, { wsId })
}

export function refundCapture(pp: PP, captureId: string, amountCents: number, claimId: string, wsId: string, note?: string): Promise<PayPalResult> {
  return pp.request('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    body: { amount: { currency_code: 'USD', value: cents(amountCents) }, ...(note ? { note_to_payer: note.slice(0, 255) } : {}) },
    requestId: `rt-refund-${claimId}`, wsId,
  })
}

export function getRefund(pp: PP, refundId: string, wsId: string): Promise<PayPalResult> {
  return pp.request('GET', `/v2/payments/refunds/${encodeURIComponent(refundId)}`, { wsId })
}

/** The buyer's approval link. Our app's orders answer with rel "payer-action" (day one check C5, 22 Oct). */
export function approvalLink(body: any): string | undefined {
  const links: { rel?: string; href?: string }[] = Array.isArray(body?.links) ? body.links : []
  return links.find((l) => l.rel === 'payer-action')?.href ?? links.find((l) => l.rel === 'approve')?.href
}

/** The capture inside an order response, at purchase_units[0].payments.captures[0]. */
export function captureOf(body: any): { id: string; status: string; amount_cents: number } | undefined {
  const cap = body?.purchase_units?.[0]?.payments?.captures?.[0]
  if (!cap?.id) return undefined
  let amount = 0
  try { amount = toCents(String(cap.amount?.value ?? '0')) } catch { amount = 0 }
  return { id: cap.id, status: cap.status, amount_cents: amount }
}
