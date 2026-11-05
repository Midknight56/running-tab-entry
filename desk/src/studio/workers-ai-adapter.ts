// AG Studio's agent on Workers AI. Studio hands one turn (the conversation, instructions and tool schemas); this
// adapter turns it into plain chat messages for our Worker's /api/studio/llm proxy, which calls Workers AI behind the
// caps. The model is asked to answer either in words or with a JSON list of tool calls, and the reply is turned back
// into Studio's output items and events.
import type { AgLlmAdapter, AgLlmRequest } from 'ag-studio'

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export const PROXY = '/api/studio/llm'
const MAX_TOOL_DESC = 160
const MAX_TOOL_RESULT = 1500

const TOOL_RULE = 'To use tools, reply with only this JSON and nothing else: {"tool_calls":[{"name":"<tool name>","arguments":{...}}]}. Otherwise reply in plain words.'

/** A parameter schema without its long descriptions and examples: the names and types are what the model needs. */
export function slim(schema: unknown, depth = 0): unknown {
  if (Array.isArray(schema)) return schema.map((x) => slim(x, depth + 1))
  if (!schema || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === 'examples' || k === 'example' || k === '$schema') continue
    if (k === 'description' && depth > 0) continue
    out[k] = slim(v, depth + 1)
  }
  return out
}

/** Studio's request as chat messages. Tool schemas are shortened so a turn stays inside the proxy's input cap. */
export function toMessages(req: AgLlmRequest): ChatMessage[] {
  const tools = (req.tools ?? []).map((t: any) => ({
    name: t.name, description: String(t.description ?? '').slice(0, MAX_TOOL_DESC), parameters: slim(t.parameters ?? t.inputSchema ?? {}, 1),
  }))
  const parts = [req.instructions ?? 'You help a seller read their billing desk.']
  if (tools.length && req.toolChoice !== 'none') parts.push('Tools: ' + JSON.stringify(tools), TOOL_RULE)
  if (req.responseFormat?.type === 'json') parts.push(`Reply with only JSON that fits this schema: ${JSON.stringify(req.responseFormat.schema)}`)
  const out: ChatMessage[] = [{ role: 'system', content: parts.join('\n') }]
  for (const item of req.input as any[]) {
    if (item.type === 'message') {
      const text = (item.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
      if (text) out.push({ role: item.role === 'assistant' ? 'assistant' : item.role === 'system' ? 'system' : 'user', content: text })
    } else if (item.type === 'function_call') {
      out.push({ role: 'assistant', content: JSON.stringify({ tool_calls: [{ name: item.name, arguments: safe(item.arguments) }] }) })
    } else if (item.type === 'function_call_output') {
      out.push({ role: 'user', content: `Tool result (${item.callId}): ${String(item.output).slice(0, MAX_TOOL_RESULT)}` })
    }
  }
  return out
}

function safe(s: string): unknown {
  try { return JSON.parse(s) } catch { return {} }
}

/** The model's words, or the tool calls it asked for. */
export function parseReply(text: string): { kind: 'text'; text: string } | { kind: 'tools'; calls: { name: string; arguments: string }[] } {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const o = JSON.parse(text.slice(start, end + 1)) as { tool_calls?: { name?: unknown; arguments?: unknown }[] }
      const calls = (o.tool_calls ?? []).filter((c) => typeof c.name === 'string')
        .map((c) => ({ name: c.name as string, arguments: JSON.stringify(c.arguments ?? {}) }))
      if (calls.length) return { kind: 'tools', calls }
    } catch { /* words, not JSON */ }
  }
  return { kind: 'text', text }
}

let counter = 0
const nextId = (p: string) => `${p}_${Date.now().toString(36)}_${(counter++).toString(36)}`

export function workersAiAdapter(fetcher: typeof fetch = (...a) => fetch(...a)): AgLlmAdapter {
  let round = 0
  return {
    executeTurn(request, options) {
      const lastIsUser = (request.input as any[]).at(-1)?.type === 'message'
      round = lastIsUser ? 0 : round + 1
      const body = { messages: toMessages(request), round }
      const complete = (async () => {
        const r = await fetcher(PROXY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: options?.signal })
        const j = (await r.json().catch(() => ({ text: '' }))) as { text?: string; busy?: boolean }
        return parseReply(j.text ?? '')
      })()
      const events: any[] = []
      const response = complete.then((reply) => {
        const id = nextId('resp')
        if (reply.kind === 'tools') {
          const output = reply.calls.map((c) => {
            const callId = nextId('call')
            events.push({ type: 'TOOL_CALL_START', toolCallId: callId, toolCallName: c.name }, { type: 'TOOL_CALL_ARGS', toolCallId: callId, delta: c.arguments }, { type: 'TOOL_CALL_END', toolCallId: callId })
            return { id: nextId('item'), kind: 'output', type: 'function_call', callId, name: c.name, arguments: c.arguments, status: 'completed' }
          })
          return { id, createdAt: Date.now(), status: 'completed', output }
        }
        const messageId = nextId('msg')
        events.push({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: reply.text }, { type: 'TEXT_MESSAGE_END', messageId })
        return { id, createdAt: Date.now(), status: 'completed', output: [{ id: messageId, kind: 'output', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'text', text: reply.text, annotations: [] }] }] }
      })
      return {
        stream: {
          async *[Symbol.asyncIterator]() {
            await response
            for (const e of events) yield e
          },
        },
        complete: response,
      } as never
    },
  }
}
