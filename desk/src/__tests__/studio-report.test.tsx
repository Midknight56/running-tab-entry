import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AgReportState, AgStudioApi, AgStudioProperties } from 'ag-studio'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const studio = vi.hoisted(() => ({ props: null as AgStudioProperties | null, state: null as AgReportState | null, mounts: [] as AgReportState[], crash: false }))
vi.mock('ag-studio-react', async () => {
  const { useEffect } = await import('react')
  return {
    AgStudioProvider: ({ children }: { children: React.ReactNode }) => children,
    createWidgets: () => ({}),
    AgStudio: (props: AgStudioProperties) => {
      if (studio.crash) throw new Error('Studio render failed')
      studio.props = props
      useEffect(() => {
        studio.state = props.initialState!
        studio.mounts.push(studio.state)
        const api = {
          getState: () => studio.state!,
          setState: (state: AgReportState) => { studio.state = state; studio.props?.onStateUpdated?.({ state, api } as never) },
          reload() {},
        } as AgStudioApi
        props.onApiReady?.({ api } as never)
      }, [])
      return null
    },
  }
})
vi.mock('ag-studio', () => ({ AgStudioAiModule: {}, createDataEngine: () => ({}), studioTheme: { withParams: () => ({}) } }))

import { App } from '../App'
import { initialReport } from '../studio/report'
import { setDesk } from '../store'
import { studioApi } from '../studio/add-widget'
import type { DeskData } from '../types'

const data: DeskData = { ws_id: 'demo', agents: [], tabs: [], calls: [], claims: [], events: [], trace: [], money: { captured_cents: 0, refunded_cents: 0, struck_cents: 0, pending_cents: 0, net_cents: 0, plain_meter_cents: 0, kept_cents: 0, kept_out_cents: 0 } }
const saved: AgReportState = { selectedPageId: 'seller', pages: [{ id: 'seller', widgets: {}, widgetLayout: {} }] }
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

function setup(report: AgReportState | null = saved, desk = data) {
  vi.useFakeTimers()
  const writes: AgReportState[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/session') return response({ ws_id: 'demo', agents: [] })
    if (url === '/api/claims/try') return response({ tries_left: 5 })
    if (url === '/api/desk/data') return response(desk)
    if (url === '/api/desk/report') {
      if (init?.method === 'PUT') { writes.push(JSON.parse(String(init.body))); return response({ ok: true }) }
      return response(report, report ? 200 : 204)
    }
    if (url === '/api/desk/ask') return response({ ok: true, spec: { type: 'value', title: 'Struck calls', value: 'struck.call', aggregation: 'count' } })
    throw new Error(`Unexpected request ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  setDesk(desk)
  return { writes, fetch }
}

async function mount() {
  const view = render(<App license={null} />)
  await act(async () => {})
  return view
}

function change(state: AgReportState) {
  act(() => studio.props?.onStateUpdated?.({ state } as never))
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  studio.props = null; studio.state = null; studio.mounts = []; studio.crash = false; studioApi.current = null
  setDesk({ ...data, ws_id: '' })
})

it.each([saved, null])('mounts with the saved report or the default when absent %#', async report => {
  setup(report)
  await mount()
  expect(studio.mounts).toEqual([report ?? initialReport])
})

it('waits for the saved report before mounting', async () => {
  const { fetch } = setup()
  const base = fetch.getMockImplementation()!
  let finish!: (value: ReturnType<typeof response>) => void
  fetch.mockImplementation((input, init) => String(input) === '/api/desk/report' ? new Promise(resolve => { finish = resolve }) : base(input, init))
  await mount()
  expect(studio.mounts).toHaveLength(0)
  await act(async () => finish(response(saved)))
  expect(studio.mounts).toEqual([saved])
})

it('saves only the latest state two seconds after the last change', async () => {
  const { writes } = setup()
  await mount()
  change({ ...saved, selectedPageId: 'first' })
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  const moved = { ...saved, pages: [{ ...saved.pages[0], widgetLayout: { chart: { xTrack: 1, yTrack: 2, xSpan: 4, ySpan: 5 } } }] }
  change(moved)
  await act(async () => { await vi.advanceTimersByTimeAsync(1999) })
  expect(writes).toEqual([])
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(writes).toEqual([moved])
})

it('keeps edits and their pending save across a narrow screen remount', async () => {
  const media = { matches: false, addEventListener: (_: string, fn: () => void) => { resize = fn }, removeEventListener() {} }
  let resize = () => {}
  vi.stubGlobal('matchMedia', () => media)
  const { writes } = setup()
  await mount()
  const moved = { ...saved, selectedPageId: 'moved' }
  change(moved)
  act(() => { media.matches = true; resize() })
  expect(studioApi.current).toBeNull()
  act(() => { media.matches = false; resize() })
  expect(studio.mounts).toEqual([saved, moved])
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(writes).toEqual([moved])
})

it('offers reset in edit mode and restores and saves the initial report', async () => {
  const { writes } = setup()
  await mount()
  expect(screen.queryByRole('button', { name: 'Reset layout' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Edit desk' }))
  fireEvent.click(screen.getByRole('button', { name: 'Reset layout' }))
  expect(studio.state).toEqual(initialReport)
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(writes).toEqual([initialReport])
})

it('saves reset even when the current layout already matches the default', async () => {
  const { writes } = setup(null)
  await mount()
  fireEvent.click(screen.getByRole('button', { name: 'Edit desk' }))
  fireEvent.click(screen.getByRole('button', { name: 'Reset layout' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(writes).toEqual([initialReport])
})

it('mounts with the initial report and shows the error after a rejected report read', async () => {
  const { fetch, writes } = setup()
  const base = fetch.getMockImplementation()!
  fetch.mockImplementation((input, init) => String(input) === '/api/desk/report' && init?.method !== 'PUT' ? Promise.reject(new Error('offline')) : base(input, init))
  await mount()
  expect(studio.mounts).toEqual([initialReport])
  expect(screen.getByRole('alert').textContent).toContain('Could not load the layout.')
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(writes).toEqual([])
})

it('resets the layout from the Studio crash view and mounts Studio again', async () => {
  const { writes } = setup()
  studio.crash = true
  await mount()
  expect(screen.getByTestId('studio-error').textContent).toContain('Studio render failed')
  studio.crash = false
  fireEvent.click(screen.getByRole('button', { name: 'Reset layout' }))
  expect(screen.queryByTestId('studio-error')).toBeNull()
  expect(studio.mounts).toEqual([initialReport])
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(writes).toEqual([initialReport])
})

it('saves a chart added through the ask form', async () => {
  const { writes } = setup()
  await mount()
  fireEvent.change(screen.getByLabelText('Ask the desk'), { target: { value: 'struck calls' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add chart' }))
  await act(async () => {})
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(writes).toHaveLength(1)
  expect(Object.values(writes[0].pages[0].widgets ?? {})).toContainEqual(expect.objectContaining({ type: 'value', dataMapping: { value: [{ id: 'struck.call', aggregation: 'count' }] } }))
})

it.each([0, 2100])('shows chart scope and truncation only when needed for total %s', async calls_total => {
  setup(null, { ...data, calls_total } as DeskData)
  const view = await mount()
  const scope = screen.getByText('Charts show this session only. Money totals never include the seeded tab.')
  expect(view.container.querySelector('.rt-ask')?.compareDocumentPosition(scope)! & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(!!screen.queryByText('Charts use the newest 0 of 2100 calls.')).toBe(calls_total > 0)
})

it('shows a report save failure', async () => {
  const { fetch } = setup()
  await mount()
  const base = fetch.getMockImplementation()!
  fetch.mockImplementation((input, init) => init?.method === 'PUT' ? Promise.resolve(response({}, 500)) : base(input, init))
  change({ ...saved, selectedPageId: 'changed' })
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(screen.getByRole('alert').textContent).toContain('Could not save the layout.')
})

it('gives the money widget room for its three parts, and lets it scroll rather than clip', async () => {
  const layout = (initialReport as any).pages[0].widgetLayout
  expect(layout.flow.ySpan).toBeGreaterThanOrEqual(26)
  const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
  expect(css).toMatch(/\.rt-widget-money \{[^}]*overflow: auto/)
  const widgets = readFileSync(resolve(process.cwd(), 'src/studio/widgets.tsx'), 'utf8')
  expect(widgets).toContain('rt-widget rt-widget-money')
})
