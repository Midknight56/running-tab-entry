import { beforeEach, describe, expect, it } from 'vitest'
import { studioProxy, BUSY, MAX_STUDIO_ROUNDS } from '../src/studio'
import { RT_DAILY_NEURONS, VISITOR_DAILY_NEURONS } from '../src/ai/budget'
import type { Env } from '../src/env'
import { fakeD1, fakeKV, type FakeD1 } from './helpers/d1'

const DAY = '2026-10-23'
const NOW = Date.parse(`${DAY}T12:00:00Z`)
let db: FakeD1
let env: Env
let calls: unknown[]

function request(messages: { role: string; content: string }[], round = 0) {
  return new Request('https://x/api/studio/llm', { method: 'POST', body: JSON.stringify({ messages, round }) })
}

async function answer(messages: { role: string; content: string }[], visitor = 'v1', round = 0) {
  return (await studioProxy(request(messages, round), env, 'ws1', visitor, () => NOW)).json() as Promise<Record<string, unknown>>
}

beforeEach(() => {
  db = fakeD1()
  calls = []
  env = {
    DB: db,
    RT_KV: fakeKV(),
    AI: { async run(_model, input) { calls.push(input); return { response: 'ok text', usage: { neurons: 3 } } } },
    ASSETS: { fetch: async () => new Response('desk') } as unknown as Fetcher,
    AI_MODE: 'live',
    PAYPAL_BASE: 'https://api-m.sandbox.paypal.com',
    PAYPAL_CLIENT_ID: 'cid',
    PAYPAL_CLIENT_SECRET: 'secret',
    SESSION_SECRET: 'session-secret',
  }
})

describe('studio proxy', () => {
  it('refuses rounds at the limit without calling AI', async () => {
    expect(await answer([{ role: 'user', content: 'question' }], 'v1', MAX_STUDIO_ROUNDS)).toEqual({ text: BUSY, busy: true })
    expect(calls).toHaveLength(0)
  })

  it('refuses an empty messages list without calling AI', async () => {
    expect(await answer([])).toEqual({ text: BUSY, busy: true })
    expect(calls).toHaveLength(0)
  })

  it('serves a live answer and caches the same messages', async () => {
    const messages = [{ role: 'user', content: 'question' }]
    expect(await answer(messages)).toEqual({ text: 'ok text', source: 'live' })
    expect(await answer(messages)).toEqual({ text: 'ok text', source: 'cache' })
    expect(calls).toHaveLength(1)
  })

  it('refuses a new question when the app daily counter is full', async () => {
    await db.prepare('INSERT INTO counters (key, n) VALUES (?, ?)').bind(`neurons:${DAY}`, RT_DAILY_NEURONS).run()
    expect(await answer([{ role: 'user', content: 'new app cap question' }])).toEqual({ text: BUSY, busy: true })
    expect(calls).toHaveLength(0)
  })

  it('limits one visitor while still serving another visitor', async () => {
    await db.prepare('INSERT INTO counters (key, n) VALUES (?, ?)').bind(`visitor:v1:${DAY}`, VISITOR_DAILY_NEURONS).run()
    expect(await answer([{ role: 'user', content: 'visitor one question' }])).toEqual({ text: BUSY, busy: true })
    expect(await answer([{ role: 'user', content: 'visitor two question' }], 'v2')).toEqual({ text: 'ok text', source: 'live' })
    expect(calls).toHaveLength(1)
  })
})
