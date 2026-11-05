import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
vi.mock('ag-studio-react', () => ({ AgStudio: () => null, AgStudioProvider: ({ children }: { children: React.ReactNode }) => children, createWidgets: () => ({}) }))
vi.mock('ag-studio', () => ({ AgStudioAiModule: {}, createDataEngine: () => ({}), studioTheme: { withParams: () => ({}) } }))
import { App } from '../App'
import { setDesk } from '../store'
import type { DeskData } from '../types'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const desk: DeskData = {
  ws_id: 'ws_one', agents: [{ id: 'agt_one', name: 'Agent', created_at: 1 }], tabs: [], calls: [], claims: [], events: [], trace: [],
  money: { captured_cents: 0, refunded_cents: 0, struck_cents: 0, pending_cents: 0, net_cents: 0, plain_meter_cents: 0, kept_cents: 0, kept_out_cents: 0 },
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); setDesk({ ...desk, ws_id: '' }) })

describe('ledger verification controls', () => {
  it('limits answer paragraphs and ledger status width', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(css).toMatch(/\.rt-answer\s+p\s*\{[^}]*max-width:\s*72ch/)
    expect(css).toMatch(/\.rt-note\[role="status"\]\s*\{[^}]*max-width:\s*72ch/)
  })
  it('shows the verified result returned by the workspace route', async () => {
    setDesk(desk)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/session') return { ok: true, json: async () => ({ ws_id: 'ws_one', agents: [] }) }
      if (url === '/api/ledger/verify/agt_one') return { ok: true, json: async () => ({ ok: true, entries: 3 }) }
      return { ok: true, json: async () => desk }
    }))
    render(<App license={null} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Verify ledger' }))
    expect(await screen.findByText('Ledger verified: 3 entries')).toBeTruthy()
  })

  it('shows the first changed call number', async () => {
    setDesk(desk)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/session') return { ok: true, json: async () => ({ ws_id: 'ws_one', agents: [] }) }
      if (url === '/api/ledger/verify/agt_one') return { ok: true, json: async () => ({ ok: false, first_bad_seq: 2 }) }
      return { ok: true, json: async () => desk }
    }))
    render(<App license={null} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Verify ledger' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Changed at call 2'))
  })

  it('says an intact chain with no signature check is intact, not changed', async () => {
    setDesk(desk)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/session') return { ok: true, json: async () => ({ ws_id: 'ws_one', agents: [] }) }
      if (url === '/api/ledger/verify/agt_one') return { ok: true, json: async () => ({ ok: false, entries: 3, signature_ok: false, first_bad_seq: null }) }
      return { ok: true, json: async () => desk }
    }))
    render(<App license={null} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Verify ledger' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Chain intact: 3 entries. Signature not checked.'))
  })
})


it.each([true, false])('appends the PayPal order comparison %s', async matches => {
  setDesk(desk)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === '/api/session') return { ok: true, json: async () => ({ ws_id: 'ws_one', agents: [] }) }
    if (url === '/api/ledger/verify/agt_one') return { ok: true, json: async () => ({ ok: true, entries: 3, order: { id: 'ORDER1', matches } }) }
    return { ok: true, json: async () => desk }
  }))
  render(<App license={null} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Verify ledger' }))
  const tail = matches ? 'carries the same hash.' : 'does not match the ledger.'
  expect(await screen.findByText(`Ledger verified: 3 entries PayPal order ORDER1 ${tail}`)).toBeTruthy()
})
