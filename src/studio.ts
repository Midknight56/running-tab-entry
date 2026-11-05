// POST /api/studio/llm: the desk assistant's proxy to Workers AI, with caps and a cache. Every round is charged against
// the visitor's, the app's and the shared day before it runs (src/ai/budget.ts); a repeat of a round costs nothing.
import type { Env } from './env'
import { gate } from './app'
import { OUTPUT_CAP } from './ai/budget'
import { sha256 } from './ai/model'

/** Rounds in one agent's turn chain; Studio's own agents usually finish in two or three. */
export const MAX_STUDIO_ROUNDS = 6
export const BUSY = "The desk's assistant has used its share for today. The desk and the demo still work."

interface Body { messages?: { role: string; content: string }[]; round?: number; starter?: boolean }

export async function studioProxy(request: Request, env: Env, wsId: string, visitor: string, now: () => number): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as Body
  const messages = (body.messages ?? []).filter((m) => ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .map((m) => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content }))
  const round = Number(body.round ?? 0)
  if (!messages.length || round >= MAX_STUDIO_ROUNDS) return Response.json({ text: BUSY, busy: true })
  const key = await sha256(JSON.stringify(messages))
  const g = gate(env, visitor, wsId, now)
  const r = await g.ask('studio_round', messages, OUTPUT_CAP.studio_round, key)
  if (!r) return Response.json({ text: BUSY, busy: true })
  return Response.json({ text: r.text, source: r.source })
}
