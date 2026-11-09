// Turns an "Ask the desk" spec into a Studio widget at the top of the desk page.
import type { AgStudioApi } from 'ag-studio'
export interface WidgetSpec { type: string; title: string; scope?: string; category?: string; value: string; aggregation: string; split?: string }

interface Layout { xTrack: number; yTrack: number; xSpan: number; ySpan: number }
interface Page { id: string; widgets?: Record<string, unknown>; widgetLayout?: Record<string, Layout> }
interface State { pages: Page[]; selectedPageId: string }

/** A shared handle on Studio's api, set when Studio is ready. */
export const studioApi: { current: Pick<AgStudioApi, 'getState' | 'setState'> | null } = { current: null }

export function widgetState(spec: WidgetSpec) {
  const value = [{ id: spec.value, aggregation: spec.aggregation }]
  const dataMapping = spec.type === 'value'
    ? { value }
    : { categoryKey: [{ id: spec.category }], valueKey: value, ...(spec.split ? { legendKey: [{ id: spec.split }] } : {}) }
  return {
    type: spec.type,
    dataMapping,
    format: {
      title: { enabled: true, text: spec.title },
      ...(spec.scope ? { subtitle: { enabled: true, text: spec.scope } } : {}),
    },
  }
}

export function addWidget(state: State, spec: WidgetSpec, id: string): State {
  const pageId = state.selectedPageId
  return {
    ...state,
    pages: state.pages.map((p) => {
      if (p.id !== pageId) return p
      // The new chart goes on top, full width, where the seller is looking; everything else moves down by its height.
      const size = spec.type === 'value' ? { xSpan: 24, ySpan: 5 } : { xSpan: 24, ySpan: 10 }
      const moved = Object.fromEntries(Object.entries(p.widgetLayout ?? {}).map(([k, l]) => [k, { ...l, yTrack: l.yTrack + size.ySpan }]))
      return {
        ...p,
        widgets: { ...(p.widgets ?? {}), [id]: widgetState(spec) },
        widgetLayout: { ...moved, [id]: { xTrack: 0, yTrack: 0, ...size } },
      }
    }),
  }
}
