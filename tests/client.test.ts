import { afterEach, expect, it } from 'vitest'
import { desk } from './helpers/connect'

let d: Awaited<ReturnType<typeof desk>>
afterEach(() => d?.db.raw.close())
async function setup() {
  d = await desk()
  const k = await (await d.connect()).json() as any
  d.env.AI_MODE = 'live'
  d.env.AI = { run: async (_model: unknown, input: any) => {
    const request = JSON.parse(input.messages.at(-1).content)
    return { response: JSON.stringify({ call_id: request.call_id, verdict: 'keep', reason_code: '', evidence: '' }), usage: { neurons: 1 } }
  } } as any
  const lines: string[] = []
  const fetch = (url: string, init: RequestInit) => d.hit(new URL(url).pathname, init)
  const modulePath = '../client/agent.mjs'
  const { run } = await import(modulePath)
  return { k, lines, fetch, run }
}
it('prints calls and stops on the due pay link with success', async () => {
  const { k, lines, fetch, run } = await setup()
  expect(await run(['--url', 'https://rt.example/mcp', '--key', k.key, '--calls', '120'], { fetch, log: (s: string) => lines.push(s), sleep: async () => {} })).toBe(0)
  expect(lines.some(s => /^call 1  convert_time  25c  billed/.test(s))).toBe(true)
  expect(lines.some(s => /tab due:.*Pay at https:\/\/rt.example\/pay\/tab_/.test(s))).toBe(true)
  expect(lines.at(-1)).toContain('Your tab')
})
it('waits for payment and resumes the same call', async () => {
  const { k, lines, fetch, run } = await setup()
  let waits = 0
  expect(await run(['--url', 'https://rt.example/mcp', '--key', k.key, '--calls', '34', '--wait'], { fetch, log: (s: string) => lines.push(s), sleep: async () => {
    waits++
    await d.db.prepare("UPDATE tabs SET state = 'PAID' WHERE agent_id = ? AND state = 'DUE'").bind(k.agent_id).run()
  } })).toBe(0)
  expect(waits).toBe(1)
  expect(lines).toContain('paid. carrying on')
  expect(lines.some(s => s.startsWith('call 34 '))).toBe(true)
})
it('prints the server words and fails for an expired key', async () => {
  const { k, lines, fetch, run } = await setup()
  d.advance()
  expect(await run(['--url', 'https://rt.example/mcp', '--key', k.key], { fetch, log: (s: string) => lines.push(s), sleep: async () => {} })).toBe(1)
  expect(lines).toContain('This agent key has expired. Get a new one from the desk.')
})
