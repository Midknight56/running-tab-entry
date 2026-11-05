// Bindings and secret names only. No values live in the repo.
export interface AiBinding { run(model: string, input: unknown): Promise<unknown> }

export interface Env {
  DB: D1Database
  RT_KV: KVNamespace
  AI: AiBinding
  ASSETS: Fetcher
  /** The shared ledger of every hackathon app's model calls, when bound. */
  LEDGER?: D1Database

  PAYPAL_BASE: string
  /** "live" calls Workers AI within the caps; "replay" answers only from the cache and the recorded replay. */
  AI_MODE: 'live' | 'replay'

  PAYPAL_CLIENT_ID: string
  PAYPAL_CLIENT_SECRET: string
  PAYPAL_WEBHOOK_ID?: string
  /** Signs MCP session ids, derives demo agent keys, salts the daily IP hash. */
  SESSION_SECRET: string
  RT_OWNER_KEY?: string
  LEDGER_SIGNING_KEY?: string
  /** Opens GET /api/debug/events for the webhook checks. */
  DEBUG_SECRET?: string
  AG_STUDIO_LICENSE?: string
  GIT_COMMIT?: string
  /** Local runs only: "1" swaps in the stand in model on localhost (src/dev/fake-ai.ts). */
  DEV_FAKE_AI?: string
}
