import { describe, expect, it } from 'vitest'
import { addWidget, widgetState } from '../studio/add-widget'
import { initialReport } from '../studio/report'

describe('ask the desk, on the desk', () => {
  it('adds a stacked chart at the top of the page and moves every other widget down, with its title and mappings', () => {
    const spec = { type: 'column-chart-stacked', title: 'Struck calls by agent', category: 'calls.agent', value: 'calls.call', aggregation: 'count', split: 'calls.status' }
    const next = addWidget(initialReport as any, spec, 'ask-1')
    const page = next.pages[0] as any
    expect(page.widgets['ask-1']).toEqual({
      type: 'column-chart-stacked',
      dataMapping: { categoryKey: [{ id: 'calls.agent' }], valueKey: [{ id: 'calls.call', aggregation: 'count' }], legendKey: [{ id: 'calls.status' }] },
      format: { title: { enabled: true, text: 'Struck calls by agent' } },
    })
    expect(page.widgetLayout['ask-1']).toMatchObject({ xTrack: 0, yTrack: 0, xSpan: 24 })
    const before = (initialReport as any).pages[0].widgetLayout
    for (const [k, l] of Object.entries(before) as [string, any][]) expect(page.widgetLayout[k].yTrack).toBe(l.yTrack + page.widgetLayout['ask-1'].ySpan)
    expect(Object.keys((initialReport as any).pages[0].widgets)).not.toContain('ask-1')
  })

  it('a value widget maps only its value', () => {
    expect(widgetState({ type: 'value', title: 'Refunded', value: 'tabs.refunded', aggregation: 'sum' }).dataMapping).toEqual({ value: [{ id: 'tabs.refunded', aggregation: 'sum' }] })
  })

  it('shows the scope in widget format subtitle', () => {
    const spec = { type: 'column-chart-stacked', title: 'Struck calls by agent', scope: 'Counts only calls with status STRUCK.', category: 'struck.agent', value: 'struck.call', aggregation: 'count' }
    const state = widgetState(spec)
    expect(state.format).toEqual({
      title: { enabled: true, text: 'Struck calls by agent' },
      subtitle: { enabled: true, text: 'Counts only calls with status STRUCK.' },
    })
  })
})
