// The saved layout: the desk as a judge first sees it. Studio keeps it as one JSON object.
const f = (id: string, aggregation?: string) => (aggregation ? { id, aggregation } : { id })
const title = (text: string) => ({ title: { enabled: true, text } })

export const initialReport = {
  selectedPageId: 'desk',
  // The filters panel starts closed: the desk opens on the widgets.
  panels: { filters: { collapsed: true } },
  pages: [{
    id: 'desk',
    widgets: {
      meter: { type: 'rt-tab-meter', dataMapping: {}, format: title('Tabs') },
      flow: { type: 'rt-money-flow', dataMapping: {}, format: title('Money') },
      struck: { type: 'rt-struck-ledger', dataMapping: {}, format: title('Struck and refunded') },
      reasons: {
        type: 'column-chart-grouped',
        dataMapping: { categoryKey: [f('calls.status')], valueKey: [f('calls.price', 'sum')] },
        format: title('Dollars by call status'),
      },
      calls: {
        type: 'grid',
        dataMapping: { cols: [f('calls.call'), f('calls.agent'), f('calls.tool'), f('calls.status'), f('calls.reason'), f('calls.judged_by'), f('calls.price'), f('calls.seconds')] },
        format: title('Calls'),
      },
    },
    widgetLayout: {
      meter: { xTrack: 0, yTrack: 0, xSpan: 10, ySpan: 10 },
      flow: { xTrack: 10, yTrack: 0, xSpan: 14, ySpan: 10 },
      reasons: { xTrack: 10, yTrack: 10, xSpan: 14, ySpan: 10 },
      struck: { xTrack: 0, yTrack: 10, xSpan: 10, ySpan: 26 },
      calls: { xTrack: 10, yTrack: 20, xSpan: 14, ySpan: 16 },
    },
  }],
}
