import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import worker from '../examples/minimal-worker'
import { createAgent, sha256Hex } from '../src/tab'
import { fakeD1 } from './helpers/d1'

const key = 'rt_agent_example_key'
const env = (DB: D1Database) => ({ DB, SESSION_SECRET: 'example-secret' })
const url = 'https://example.test/mcp'

function request(method: string, params: Record<string, unknown>, sid = '', authKey = key) {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authKey}`,
      ...(sid ? { 'MCP-Session-Id': sid } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

async function initialize(db: D1Database) {
  const response = await worker.fetch(request('initialize', { protocolVersion: '2025-11-25' }), env(db))
  return response.headers.get('MCP-Session-Id')!
}

async function call(db: D1Database, sid: string, name: string, args: Record<string, unknown> = {}, authKey = key) {
  const response = await worker.fetch(request('tools/call', { name, arguments: args }, sid, authKey), env(db))
  return (await response.json() as { result: any }).result
}

describe('minimal worker example', () => {
  it('the add on takes under 15 lines in a kit server', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../examples/minimal-worker.ts'), 'utf8')
    const lines = source.split(/\r?\n/)
    const start = lines.findIndex((line) => line.trim() === 'export default {')
    const example = (start >= 0 ? lines.slice(start) : lines)
      .filter((line) => line.trim() !== '' && !line.trim().startsWith('//'))
    expect(example.length).toBeLessThan(15)
  })

  it('bills calls and blocks the call after the tab is due', async () => {
    const db = fakeD1()
    await createAgent(db, 'ws1', 'Example agent', await sha256Hex(key))
    const sid = await initialize(db)
    let answer: any
    for (let i = 0; i < 250; i++) answer = await call(db, sid, 'hello', { name: 'Ada' })

    expect(answer.isError).not.toBe(true)
    expect(answer._meta['running-tab/call'].tab_state).toBe('DUE')
    const due = await call(db, sid, 'hello', { name: 'Ada' })
    expect(due.isError).toBe(true)
    expect(due.structuredContent.code).toBe('TAB_DUE')
    expect(due.structuredContent.pay_url).toMatch(new RegExp(`/pay/${due.structuredContent.tab_id}$`))

    const tab = await call(db, sid, 'my_tab')
    expect(tab.structuredContent.state).toBe('DUE')
    expect(tab.structuredContent.total).toBe('5.00')
  })

  it('returns an unknown key tool error without recording a call', async () => {
    const db = fakeD1()
    const sid = await initialize(db)
    const result = await call(db, sid, 'my_tab', {}, 'not-a-known-key')
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('Unknown agent key.')
    expect((await db.prepare('SELECT COUNT(*) AS count FROM calls').first<{ count: number }>())?.count).toBe(0)
  })
})
