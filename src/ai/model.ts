// Every model call goes through ModelGate.ask: the cache first, then (in live mode only) the budget, then Workers AI.
// A null answer means "no model output": callers fall back to code (PENDING_AUDIT, a template, the seller's click).
import { INPUT_CAP, MODEL_ID, OUTPUT_CAP, WORST, measured, settle, take, type Job, type Ticket } from './budget'
import { REPLAY } from './replay'
import { writeTrace } from '../trace'
import type { AiBinding } from '../env'

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface ModelAnswer { text: string; source: 'live' | 'cache' | 'replay'; neurons: number }

export interface GateDeps {
  db: D1Database
  ai: AiBinding
  mode: 'live' | 'replay'
  key?: string
  visitor: string
  wsId: string
  day: () => string
  ledger?: D1Database
  now?: () => number
}

export class ModelGate {
  constructor(private d: GateDeps) {}

  async ask(job: Job, messages: ChatMessage[], maxTokens: number, cacheKey: string): Promise<ModelAnswer | null> {
    const key = `${job}:${cacheKey}`
    const now = this.d.now ?? Date.now
    const hit = await this.d.db.prepare('SELECT value_json FROM cache WHERE key = ?').bind(key).first<string>('value_json')
    if (hit !== null) {
      await this.trace(job, 0, true)
      return { text: JSON.parse(hit) as string, source: 'cache', neurons: 0 }
    }
    if (REPLAY[key] !== undefined) {
      await this.trace(job, 0, true)
      return { text: REPLAY[key], source: 'replay', neurons: 0 }
    }
    if (this.d.mode !== 'live') return null

    const chars = messages.reduce((n, m) => n + m.content.length, 0)
    if (chars > INPUT_CAP[job]) return null
    const out = Math.min(maxTokens, OUTPUT_CAP[job])
    const ticket: Ticket = {}
    const day = this.d.day()
    if (!(await take(this.d.db, { day, visitor: this.d.visitor, key: this.d.key, neurons: WORST[job], ledger: this.d.ledger, now: now(), ticket }))) {
      await this.trace(job, 0, false, 'over cap')
      return null
    }
    // Qwen3 thinks aloud before answering unless the last user turn says /no_think.
    const sent = messages.map((m, i) => (i === messages.length - 1 && m.role === 'user' ? { ...m, content: m.content + ' /no_think' } : m))
    let raw: any
    try {
      raw = await this.d.ai.run(MODEL_ID, { messages: sent, max_tokens: out, temperature: 0 })
    } catch {
      await this.trace(job, WORST[job], false, 'error')
      return null
    }
    const text = clean(asText(raw?.response ?? raw?.choices?.[0]?.message?.content ?? ''))
    const usage = raw?.usage
    // Workers AI's own count when the reply carries it, else the price table applied to the token counts.
    const spent = usage && Number.isFinite(usage.neurons) ? Number(usage.neurons)
      : usage && Number.isFinite(usage.prompt_tokens) ? measured(usage.prompt_tokens, usage.completion_tokens ?? 0) : WORST[job]
    await settle(this.d.db, { day, visitor: this.d.visitor, key: this.d.key, charged: WORST[job], actual: spent, ledger: this.d.ledger, ticket })
    await this.d.db.prepare('INSERT OR REPLACE INTO cache (key, value_json, at) VALUES (?, ?, ?)').bind(key, JSON.stringify(text), now()).run()
    await this.trace(job, spent, false)
    return { text, source: 'live', neurons: spent }
  }

  private trace(job: Job, neurons: number, cached: boolean, verdict?: string) {
    return writeTrace(this.d.db, { kind: 'model', ws_id: this.d.wsId, method_path: job, model: MODEL_ID, neurons: Math.round(neurons * 100) / 100, cached, verdict }, [], (this.d.now ?? Date.now)())
  }
}

/** Workers AI hands back a parsed object when the reply looks like JSON. */
function asText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  return JSON.stringify(v)
}

function clean(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^[\s\S]*<\/think>/, '').trim()
}

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}
