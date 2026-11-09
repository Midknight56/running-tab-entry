import { describe, expect, it } from 'vitest'
import { studioSources } from '../data'
import type { DeskData } from '../types'

const data: DeskData = {
  ws_id: 'ws1',
  agents: [
    { id: 'a1', name: 'Agent One', created_at: 1 },
    { id: 'a2', name: 'Agent Two', created_at: 2 },
  ],
  tabs: [
    { id: 't1', agent_id: 'a1', state: 'PAID', total_cents: 25, threshold_cents: 500, order_id: null, capture_id: null, captured_cents: 25, refunded_cents: 25, note: 'demo history', created_at: 1, due_at: null, paid_at: null },
    { id: 't2', agent_id: 'a2', state: 'OPEN', total_cents: 25, threshold_cents: 500, order_id: null, capture_id: null, captured_cents: 0, refunded_cents: 0, note: null, created_at: 2, due_at: null, paid_at: null },
  ],
  calls: [
    { id: 'c1', seq: 1, agent_id: 'a1', tab_id: 't1', tool: 'convert_time', args: {}, answer: 'one', price_cents: 25, status: 'BILLABLE', reason_code: null, evidence: null, judged_by: null, duration_ms: 1000, created_at: Date.parse('2026-10-20T12:00:00Z') },
    { id: 'c2', seq: 2, agent_id: 'a1', tab_id: 't1', tool: 'business_days', args: {}, answer: 'two', price_cents: 5, status: 'STRUCK', reason_code: 'OFF_REQUEST', evidence: null, judged_by: 'model', duration_ms: 250, created_at: Date.parse('2026-10-20T12:01:00Z') },
    { id: 'c3', seq: 3, agent_id: 'a2', tab_id: 't2', tool: 'convert_time', args: {}, answer: 'three', price_cents: 25, status: 'REFUNDED', reason_code: null, evidence: null, judged_by: null, duration_ms: 500, created_at: Date.parse('2026-10-21T12:00:00Z') },
    { id: 'c4', seq: 4, agent_id: 'a2', tab_id: 't2', tool: 'business_days', args: {}, answer: 'four', price_cents: 25, status: 'PENDING_AUDIT', reason_code: null, evidence: null, judged_by: null, duration_ms: 750, created_at: Date.parse('2026-10-21T12:01:00Z') },
  ],
  claims: [{ id: 'k1', call_id: 'c3', call_seq: 3, agent_id: 'a2', reason_text: 'duplicate', verdict: null, reason_code: null, evidence: null, refund_id: 'r1', refund_status: 'COMPLETED', state: 'REFUNDED', created_at: 3, price_cents: 25 }],
  events: [],
  trace: [],
  money: { captured_cents: 25, refunded_cents: 25, struck_cents: 5, pending_cents: 25, net_cents: 0, plain_meter_cents: 80, kept_cents: 0, kept_out_cents: 80 },
}

describe('studio data sources', () => {
  it('declares stable schemas and rows with matching fields', () => {
    const sources = studioSources(data, { includeHistory: true })
    expect(sources.map(({ id }) => id)).toEqual(['calls', 'tabs', 'refunds', 'struck', 'billed', 'billable', 'refunded_calls', 'claims'])
    for (const source of sources) {
      const ids = source.fields.map((field) => field.id)
      expect(ids.length).toBeGreaterThan(0)
      for (const row of source.data) expect(Object.keys(row).sort()).toEqual([...ids].sort())
    }

    const calls = sources[0] as typeof sources[0] & { data: { agent: string; price: number; history: string }[] }
    expect(calls.fields).toEqual([
      { id: 'call', name: 'Call', format: 'integerFormat' }, { id: 'agent', name: 'Agent', format: 'textFormat' },
      { id: 'tool', name: 'Tool', format: 'textFormat' }, { id: 'status', name: 'Status', format: 'textFormat' },
      { id: 'reason', name: 'Reason', format: 'textFormat' }, { id: 'judged_by', name: 'Judged by', format: 'textFormat' },
      { id: 'price', name: 'Price', format: 'currencyFormat' }, { id: 'seconds', name: 'Seconds', format: 'decimalFormat' },
      { id: 'day', name: 'Day', format: 'textFormat' }, { id: 'history', name: 'Session', format: 'textFormat' },
    ])
    expect(sources[1].fields).toEqual([
      { id: 'tab', name: 'Tab', format: 'textFormat' }, { id: 'agent', name: 'Agent', format: 'textFormat' },
      { id: 'state', name: 'State', format: 'textFormat' }, { id: 'total', name: 'Total', format: 'currencyFormat' },
      { id: 'captured', name: 'Captured', format: 'currencyFormat' }, { id: 'refunded', name: 'Refunded', format: 'currencyFormat' },
      { id: 'order', name: 'PayPal order', format: 'textFormat' }, { id: 'capture', name: 'PayPal capture', format: 'textFormat' },
    ])
    expect(sources[2].fields).toEqual([
      { id: 'call', name: 'Call', format: 'integerFormat' }, { id: 'agent', name: 'Agent', format: 'textFormat' },
      { id: 'reason', name: 'Reason', format: 'textFormat' }, { id: 'state', name: 'State', format: 'textFormat' },
      { id: 'amount', name: 'Amount', format: 'currencyFormat' }, { id: 'refund', name: 'PayPal refund', format: 'textFormat' },
      { id: 'claim', name: 'Claim', format: 'textFormat' },
    ])
    expect(calls.data.map((row) => row.agent)).toEqual(['Agent One', 'Agent One', 'Agent Two', 'Agent Two'])
    expect(calls.data[0].price).toBe(0.25)
    expect(calls.data.map((row) => row.history)).toEqual(['Seeded tab', 'Seeded tab', 'This session', 'This session'])
    expect((sources[2].data[0] as { amount: number }).amount).toBe(0.25)
  })

  it('keeps completed refunds separate from waiting and rejected claims', () => {
    const sources = studioSources({ ...data, claims: [data.claims[0], { ...data.claims[0], id: 'waiting', state: 'WAITING_SELLER' }, { ...data.claims[0], id: 'rejected', state: 'REJECTED' }] }, { includeHistory: true })
    expect(sources.find(s => s.id === 'refunds')?.data.map(row => (row as { state: string }).state)).toEqual(['REFUNDED'])
    expect(sources.find(s => s.id === 'claims')?.data.map(row => (row as { state: string }).state)).toEqual(['REFUNDED', 'WAITING_SELLER', 'REJECTED'])
    expect(sources.find(s => s.id === 'struck')?.data.map(row => (row as { status: string }).status)).toEqual(['STRUCK'])
    expect(sources.find(s => s.id === 'billed')?.data.map(row => (row as { status: string }).status)).toEqual(['BILLABLE', 'REFUNDED'])
    expect(sources.find(s => s.id === 'struck')?.fields).toEqual(sources[0].fields)
    expect(sources.find(s => s.id === 'billed')?.fields).toEqual(sources[0].fields)
    expect(sources.find(s => s.id === 'claims')?.fields).toEqual(sources[2].fields)
  })
})

it('counts exact billable and refunded sources and keeps the combined billed source explicit', () => {
  const sources = studioSources(data, { includeHistory: true })
  for (const [id, statuses] of [['billable', ['BILLABLE']], ['refunded_calls', ['REFUNDED']], ['billed', ['BILLABLE', 'REFUNDED']]] as const) {
    const source = sources.find(s => s.id === id)
    expect(source?.data.map(row => (row as { status: string }).status)).toEqual(statuses)
    expect(source?.fields).toEqual(sources[0].fields)
  }
  expect(sources.find(s => s.id === 'billed')?.name).toBe('Billed calls, refunded included')
})

it('counts 3 struck calls from a fixture with 20 billable, 3 struck and 1 refunded call', () => {
  const fixture: DeskData = {
    ...data,
    calls: [
      ...Array.from({ length: 20 }, (_, i) => ({ id: `b${i}`, seq: i + 1, agent_id: 'a1', tab_id: 't1', tool: 'convert_time', args: {}, answer: 'one', price_cents: 25, status: 'BILLABLE' as const, reason_code: null, evidence: null, judged_by: null, duration_ms: 1000, created_at: 1 })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: `s${i}`, seq: 21 + i, agent_id: 'a1', tab_id: 't1', tool: 'business_days', args: {}, answer: 'two', price_cents: 5, status: 'STRUCK' as const, reason_code: 'OFF_REQUEST', evidence: null, judged_by: 'model', duration_ms: 250, created_at: 1 })),
      { id: 'r1', seq: 24, agent_id: 'a2', tab_id: 't2', tool: 'convert_time', args: {}, answer: 'three', price_cents: 25, status: 'REFUNDED' as const, reason_code: null, evidence: null, judged_by: null, duration_ms: 500, created_at: 1 },
    ],
  }
  const sources = studioSources(fixture, { includeHistory: true })
  const spec = { value: 'struck.call' }
  const source = spec.value.split('.')[0]
  expect(sources.find((s) => s.id === source)?.data).toHaveLength(3)
})
