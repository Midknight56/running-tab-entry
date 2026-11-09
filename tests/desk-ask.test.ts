import { describe, expect, it, vi } from 'vitest'
import { ASK_SYSTEM, askDesk, checkSpec, WIDGET_TYPES } from '../src/desk-ask'

const gate = (text: string | null) => ({ async ask() { return text === null ? null : { text, source: 'live', neurons: 3 } } })

describe('ask the desk', () => {
  it('only accepts chart requests and rejects billing actions', async () => {
    expect(WIDGET_TYPES).toEqual(['column-chart-grouped', 'column-chart-stacked', 'bar-chart-grouped', 'pie-chart', 'donut-chart', 'value'])
    expect(ASK_SYSTEM).toContain('one chart')
    const action = await askDesk(gate('{"type":"refund","title":"Refund call","value":"tabs.refunded","aggregation":"sum"}') as any, 'refund call 1')
    expect(action).toMatchObject({ ok: false })
  })

  it('keeps a spec whose fields and type the desk knows', () => {
    const s = checkSpec('{"type":"column-chart-stacked","title":"Most Struck Calls by Agent","category":"calls.agent","value":"calls.call","aggregation":"count","split":"calls.status"}')
    expect(s).toEqual({ type: 'column-chart-stacked', title: 'All calls by agent and status', scope: 'Counts every call, any status.', category: 'calls.agent', value: 'calls.call', aggregation: 'count', split: 'calls.status' })
  })

  it('drops a spec with an unknown field, a field from another table, an unknown type or a bad aggregation', () => {
    expect(checkSpec('{"type":"pie-chart","title":"x","category":"calls.password","value":"calls.price","aggregation":"sum"}')).toBeNull()
    expect(checkSpec('{"type":"pie-chart","title":"x","category":"tabs.agent","value":"calls.price","aggregation":"sum"}')).toBeNull()
    expect(checkSpec('{"type":"radar-line-chart","title":"x","category":"calls.agent","value":"calls.price","aggregation":"sum"}')).toBeNull()
    expect(checkSpec('{"type":"pie-chart","title":"x","category":"calls.agent","value":"calls.price","aggregation":"drop table"}')).toBeNull()
    expect(checkSpec('{"type":"pie-chart","title":"x","category":"calls.price","value":"calls.agent","aggregation":"sum"}')).toBeNull()
  })

  it('a value widget needs no category', () => {
    const s = checkSpec('{"type":"value","title":"ignored","value":"tabs.refunded","aggregation":"sum"}')
    expect(s).toMatchObject({ type: 'value', title: 'Sum of refunded: tabs', scope: 'Counts every tab, any state.' })
    expect(WIDGET_TYPES).toContain('value')
  })

  it('answers with a spec, or says plainly that it could not', async () => {
    const good = await askDesk(gate('{"type":"pie-chart","title":"Refunds by reason","category":"refunds.reason","value":"refunds.call","aggregation":"count"}') as any, 'refunds by reason')
    expect(good).toMatchObject({ ok: true, spec: { category: 'refunds.reason' } })
    expect(await askDesk(gate('nonsense') as any, 'q')).toMatchObject({ ok: false })
    expect(await askDesk(gate(null) as any, 'q')).toMatchObject({ ok: false, busy: true })
  })

  it('reads "count" as a value to mean counting the rows of the category table (seen live, 23 Oct)', () => {
    const s = checkSpec('{"type":"bar-chart-grouped","title":"Most Struck Calls by Agent","category":"calls.agent","value":"count","aggregation":"count","split":"calls.status"}')
    expect(s).toMatchObject({ title: 'All calls by agent and status', scope: 'Counts every call, any status.', value: 'calls.call', aggregation: 'count', category: 'calls.agent' })
    expect(checkSpec('{"type":"pie-chart","title":"x","category":"tabs.agent","value":"count","aggregation":"count"}')).toBeNull()
  })

  it('drops a split on the same field as the category (seen live, 9 Nov: "Struck calls by agent and agent")', async () => {
    const reply = '{"type":"bar-chart-grouped","title":"Most struck","category":"calls.agent","value":"calls.call","aggregation":"count","split":"calls.agent"}'
    const result = await askDesk(gate(reply) as any, 'Which agent had the most struck calls this week?')
    expect(result).toEqual({ ok: true, spec: { type: 'bar-chart-grouped', title: 'Struck calls by agent', scope: 'Counts only calls with status STRUCK.', category: 'struck.agent', value: 'struck.call', aggregation: 'count' } })
  })

  it('rewrites calls split by status to struck source when question names struck', async () => {
    const reply = '{"type":"column-chart-stacked","title":"Calls by agent","category":"calls.agent","value":"calls.call","aggregation":"count","split":"calls.status"}'
    const result = await askDesk(gate(reply) as any, 'struck calls by agent')
    expect(result).toEqual({
      ok: true,
      spec: {
        type: 'column-chart-stacked',
        title: 'Struck calls by agent',
        scope: 'Counts only calls with status STRUCK.',
        category: 'struck.agent',
        value: 'struck.call',
        aggregation: 'count',
      },
    })
  })

  it('a fixture with 20 billable calls, 3 struck calls and 1 refunded call, put through studioSources from desk/src/data.ts, counted by the returned spec source, gives 3, not 24', async () => {
    const { studioSources } = await vi.importActual<{ studioSources(data: any): { id: string; data: unknown[] }[] }>('../desk/src/data')
    const reply = '{"type":"column-chart-stacked","title":"Calls by agent","category":"calls.agent","value":"calls.call","aggregation":"count","split":"calls.status"}'
    const result = await askDesk(gate(reply) as any, 'struck calls by agent')
    expect(result).toMatchObject({ ok: true })
    if (!result || !result.ok) throw new Error('expected ok')
    const source = result.spec.value.split('.')[0]
    const fixture = {
      ws_id: 'ws1', agents: [], tabs: [], claims: [], events: [], trace: [],
      money: { captured_cents: 0, refunded_cents: 0, struck_cents: 0, pending_cents: 0, net_cents: 0, plain_meter_cents: 0, kept_cents: 0, kept_out_cents: 0 },
      calls: [
        ...Array.from({ length: 20 }, (_, i) => ({ id: `b${i}`, seq: i + 1, agent_id: 'a1', tab_id: 't1', tool: 't', args: {}, answer: '', price_cents: 25, status: 'BILLABLE' as const, reason_code: null, evidence: null, judged_by: null, duration_ms: 10, created_at: 1 })),
        ...Array.from({ length: 3 }, (_, i) => ({ id: `s${i}`, seq: 21 + i, agent_id: 'a1', tab_id: 't1', tool: 't', args: {}, answer: '', price_cents: 25, status: 'STRUCK' as const, reason_code: null, evidence: null, judged_by: null, duration_ms: 10, created_at: 1 })),
        { id: 'r1', seq: 24, agent_id: 'a1', tab_id: 't1', tool: 't', args: {}, answer: '', price_cents: 25, status: 'REFUNDED' as const, reason_code: null, evidence: null, judged_by: null, duration_ms: 10, created_at: 1 },
      ],
    }
    const filtered = studioSources(fixture).find(s => s.id === source)?.data
    expect(filtered).toHaveLength(3)
  })

  it('refuses when question names struck but spec is on billable source', async () => {
    const reply = '{"type":"column-chart-stacked","title":"Billable calls","category":"billable.agent","value":"billable.call","aggregation":"count"}'
    const result = await askDesk(gate(reply) as any, 'struck calls by agent')
    expect(result).toEqual({ ok: false, reason: 'I can filter calls by billable, refunded or struck status, or claims by refunded state. Try struck calls by agent.' })
  })

  it.each([
    ['calls.status', 'STRUCK', 'calls', 'struck'],
    ['calls.status', 'BILLABLE', 'calls', 'billable'],
    ['calls.status', 'REFUNDED', 'calls', 'refunded_calls'],
    ['claims.state', 'REFUNDED', 'claims', 'refunds'],
  ])('maps filter %s = %s from %s to %s', (field, equals, table, source) => {
    const spec = checkSpec(JSON.stringify({ type: 'column-chart-stacked', title: 'Filtered calls', category: `${table}.agent`, value: `${table}.call`, split: `${table}.${table === 'calls' ? 'status' : 'state'}`, aggregation: 'count', filter: { field, equals } }))
    expect(spec).toMatchObject({ category: `${source}.agent`, value: `${source}.call`, split: `${source}.${table === 'calls' ? 'status' : 'state'}` })
  })

  it.each([
    { field: 'calls.status', equals: 'UNKNOWN' },
    { field: 'calls.agent', equals: 'Someone' },
    { field: 'claims.state', equals: 'WAITING_SELLER' },
    { field: 'calls.status', equals: ['STRUCK'] },
    { field: 'calls.status', equals: 'STRUCK', extra: true },
    null,
  ])('refuses an unsupported filter with plain words %#', async filter => {
    const text = JSON.stringify({ type: 'pie-chart', category: 'calls.agent', value: 'calls.call', aggregation: 'count', filter })
    const refusal = { ok: false, reason: 'I can filter calls by billable, refunded or struck status, or claims by refunded state. Try struck calls by agent.' }
    expect(checkSpec(text)).toEqual(refusal)
    expect(await askDesk(gate(text) as any, 'filtered calls')).toEqual(refusal)
  })

  it('refuses a filter on a different source and describes the supported sources', () => {
    expect(checkSpec(JSON.stringify({ type: 'value', value: 'tabs.total', aggregation: 'sum', filter: { field: 'calls.status', equals: 'STRUCK' } }))).toMatchObject({ ok: false })
    for (const word of ['struck', 'billed', 'claims', 'refunds', 'filter', 'history']) expect(ASK_SYSTEM).toContain(word)
  })
})
