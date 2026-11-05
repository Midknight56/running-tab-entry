import { describe, expect, it } from 'vitest'
import { PROXY, parseReply, slim, toMessages, workersAiAdapter } from '../studio/workers-ai-adapter'

const userTurn = {
  input: [{ kind: 'input', type: 'message', role: 'user', status: 'completed', id: 'm1', content: [{ type: 'text', text: 'Which agent had the most struck calls?' }] }],
  instructions: 'Help the seller.',
  tools: [{ name: 'add_widget', description: 'Adds a widget', parameters: { type: 'object', properties: { type: { type: 'string' } } } }],
  responseFormat: { type: 'text' },
} as any

describe('Studio adapter', () => {
  it("maps Studio's request to the proxy body: a system message with the tools, then the user's words", async () => {
    const sent: any[] = []
    const fake = (async (url: string, init: RequestInit) => { sent.push({ url, body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify({ text: 'Travel desk agent.' })) }) as any
    const r = workersAiAdapter(fake).executeTurn(userTurn)
    const done = await r.complete
    expect(sent[0].url).toBe(PROXY)
    expect(sent[0].body.round).toBe(0)
    expect(sent[0].body.messages[0].role).toBe('system')
    expect(sent[0].body.messages[0].content).toContain('add_widget')
    expect(sent[0].body.messages[1]).toEqual({ role: 'user', content: 'Which agent had the most struck calls?' })
    expect(done.output[0]).toMatchObject({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Travel desk agent.' }] })
    const events = []
    for await (const e of r.stream) events.push((e as any).type)
    expect(events).toEqual(['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END'])
  })

  it('turns a JSON tool call reply into a function_call output item', async () => {
    const fake = (async () => new Response(JSON.stringify({ text: '{"tool_calls":[{"name":"add_widget","arguments":{"type":"grid"}}]}' }))) as any
    const done = await workersAiAdapter(fake).executeTurn(userTurn).complete
    expect(done.output[0]).toMatchObject({ type: 'function_call', name: 'add_widget', arguments: '{"type":"grid"}' })
  })

  it('shows the busy message when the proxy is over its cap', async () => {
    const fake = (async () => new Response(JSON.stringify({ text: "The desk's assistant has used its share for today. The desk and the demo still work.", busy: true }))) as any
    const done = await workersAiAdapter(fake).executeTurn(userTurn).complete
    expect((done.output[0] as any).content[0].text).toMatch(/used its share/)
  })

  it('sends tool results back as words, and counts the round', () => {
    const msgs = toMessages({ ...userTurn, input: [...userTurn.input, { type: 'function_call', callId: 'c1', name: 'add_widget', arguments: '{"type":"grid"}' }, { type: 'function_call_output', callId: 'c1', output: 'added', status: 'completed' }] })
    expect(msgs.at(-1)).toEqual({ role: 'user', content: 'Tool result (c1): added' })
    expect(parseReply('plain words')).toEqual({ kind: 'text', text: 'plain words' })
  })

  it('drops nested descriptions and examples from tool schemas, keeping names and types', () => {
    const big = { type: 'object', description: 'top', properties: { a: { type: 'string', description: 'x'.repeat(500), examples: ['q'] } } }
    expect(slim(big, 1)).toEqual({ type: 'object', properties: { a: { type: 'string' } } })
  })
})
