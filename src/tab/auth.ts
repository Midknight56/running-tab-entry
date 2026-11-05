// The agent behind a request: "Authorization: Bearer <key>", looked up by the key's sha256. Keys are never stored.
import { agentByKeyHash, type Agent } from './ledger'

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function agentFromRequest(db: D1Database, request: Request): Promise<Agent> {
  const auth = request.headers.get('Authorization') ?? ''
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  const agent = key ? await agentByKeyHash(db, await sha256Hex(key)) : null
  if (!agent) throw new Error('Unknown agent key.')
  return agent
}
