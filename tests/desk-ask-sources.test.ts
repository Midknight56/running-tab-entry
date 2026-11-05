import { describe, expect, it, vi } from 'vitest'
import { FIELDS, checkSpec } from '../src/desk-ask'
import type { DeskData } from '../desk/src/types'

const data: DeskData = {
  ws_id: 'ws1', agents: [], tabs: [], claims: [], events: [], trace: [],
  money: { captured_cents: 0, refunded_cents: 0, struck_cents: 0, pending_cents: 0, net_cents: 0, plain_meter_cents: 0, kept_cents: 0, kept_out_cents: 0 },
  calls: (['BILLABLE', 'REFUNDED'] as const).map((status, i) => ({
    id: `c${i}`, seq: i + 1, agent_id: 'a1', tab_id: 't1', tool: 'convert_time', args: {}, answer: '',
    price_cents: 25, status, reason_code: null, evidence: null, judged_by: null, duration_ms: 20, created_at: 1,
  })),
}

const { studioSources } = await vi.importActual<{ studioSources(data: DeskData): { id: string; fields: { id: string }[]; data: unknown[] }[] }>('../desk/src/data')

describe('desk chart source contract', () => {
  it.each([['BILLABLE', 1], ['REFUNDED', 1], [null, 2]])('counts the exact requested call scope %s', (status, count) => {
    const spec = checkSpec(JSON.stringify({ type: 'value', value: status ? 'calls.call' : 'billed.call', aggregation: 'count', ...(status ? { filter: { field: 'calls.status', equals: status } } : {}) }))
    expect(spec).not.toBeNull()
    expect(spec).not.toHaveProperty('ok')
    const source = (spec as { value: string }).value.split('.')[0]
    expect(studioSources(data).find(s => s.id === source)?.data).toHaveLength(count)
  })

  it('declares the same sources and fields on the server and desk', () => {
    const sources = studioSources(data)
    expect(sources.map(s => s.id).sort()).toEqual(Object.keys(FIELDS).sort())
    for (const source of sources) {
      expect(source.fields.map(f => f.id).sort()).toEqual([...FIELDS[source.id].category, ...FIELDS[source.id].number].sort())
    }
  })
})
