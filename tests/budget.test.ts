import { beforeEach, describe, expect, it } from 'vitest'
import { INPUT_CAP, OUTPUT_CAP, MODEL_ID, RT_DAILY_NEURONS, VISITOR_DAILY_NEURONS, WORST, take, worstCase } from '../src/ai/budget'
import { ModelGate } from '../src/ai/model'
import { fakeD1, type FakeD1 } from './helpers/d1'

let db: FakeD1
beforeEach(() => { db = fakeD1() })

describe('budget', () => {
  it('writes the worst case of each job from the price table', () => {
    expect(MODEL_ID).toBe('@cf/zai-org/glm-4.7-flash')
    for (const job of Object.keys(INPUT_CAP) as (keyof typeof INPUT_CAP)[]) {
      expect(WORST[job]).toBeCloseTo(worstCase(INPUT_CAP[job], OUTPUT_CAP[job]), 8)
    }
    expect(WORST.studio_round).toBeCloseTo(78.7, 5)
    expect(WORST.audit).toBeCloseTo(12.618, 5)
    expect(WORST.explain_round).toBeCloseTo(18.28, 5)
  })

  it('refuses a call past the visitor share before anything runs', async () => {
    const n = Math.floor(VISITOR_DAILY_NEURONS / WORST.audit)
    for (let i = 0; i < n; i++) expect(await take(db, { day: '2026-10-25', visitor: 'v1', neurons: WORST.audit })).toBe(true)
    expect(await take(db, { day: '2026-10-25', visitor: 'v1', neurons: WORST.audit })).toBe(false)
    expect(await take(db, { day: '2026-10-25', visitor: 'v2', neurons: WORST.audit })).toBe(true)
  })

  it('refuses a call past RT_DAILY_NEURONS for the whole app, and gives back the visitor share it took', async () => {
    let v = 0
    while (await take(db, { day: '2026-10-25', visitor: 'v' + v++, neurons: 100 })) { /* fill the day */ }
    const spent = await db.prepare("SELECT n FROM counters WHERE key = 'neurons:2026-10-25'").first<number>('n')
    expect(spent).toBeLessThanOrEqual(RT_DAILY_NEURONS)
    const last = await db.prepare('SELECT n FROM counters WHERE key = ?').bind(`visitor:v${v - 1}:2026-10-25`).first<number>('n')
    expect(last ?? 0).toBe(0)
  })

  it('a new day starts at zero', async () => {
    while (await take(db, { day: '2026-10-25', visitor: 'x' + Math.random(), neurons: 100 })) { /* fill */ }
    expect(await take(db, { day: '2026-10-26', visitor: 'y', neurons: 100 })).toBe(true)
  })

  it('counts into the shared ledger when one is bound, and stops at the joint cap', async () => {
    const ledger = fakeD1()
    ledger.raw.exec('CREATE TABLE ai_calls (app TEXT, day TEXT, neurons REAL, at INTEGER)')
    ledger.raw.exec("INSERT INTO ai_calls VALUES ('other-app', '2026-10-25', 99999, 1)")
    expect(await take(db, { day: '2026-10-25', visitor: 'v', neurons: 10, ledger })).toBe(false)
    expect(await db.prepare("SELECT n FROM counters WHERE key = 'neurons:2026-10-25'").first<number>('n')).toBe(0)
  })
})

describe('model gate', () => {
  const ai = (reply: string) => {
    const seen: unknown[] = []
    return { seen, async run(_m: string, input: unknown) { seen.push(input); return { response: reply, usage: { prompt_tokens: 100, completion_tokens: 20 } } } }
  }

  it('never calls the model in replay mode, and answers from the cache when it can', async () => {
    const a = ai('{"x":1}')
    const g = new ModelGate({ db, ai: a, mode: 'replay', visitor: 'v', wsId: 'ws1', day: () => '2026-10-25' })
    expect(await g.ask('audit', [{ role: 'user', content: 'hi' }], 120, 'k1')).toBeNull()
    expect(a.seen).toHaveLength(0)
    await db.prepare("INSERT INTO cache (key, value_json, at) VALUES ('audit:@cf/zai-org/glm-4.7-flash:none:k1', '\"cached text\"', 1)").run()
    expect(await g.ask('audit', [{ role: 'user', content: 'hi' }], 120, 'k1')).toMatchObject({ text: 'cached text', source: 'cache' })
  })

  it('in live mode charges the worst case first, calls once, caches, and traces the real neurons', async () => {
    const a = ai('<think>hmm</think>{"verdict":"keep"}')
    const g = new ModelGate({ db, ai: a, mode: 'live', visitor: 'v', wsId: 'ws1', day: () => '2026-10-25' })
    const r1 = await g.ask('audit', [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], 120, 'k2')
    const r2 = await g.ask('audit', [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], 120, 'k2')
    expect(r1).toMatchObject({ text: '{"verdict":"keep"}', source: 'live' })
    expect(r2).toMatchObject({ source: 'cache' })
    expect(a.seen).toHaveLength(1)
    expect(a.seen[0]).toMatchObject({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] })
    expect(a.seen[0]).toMatchObject({ chat_template_kwargs: { enable_thinking: false } })
    const tr = (await db.prepare("SELECT neurons, cached, model FROM trace WHERE kind = 'model' ORDER BY id").all<any>()).results
    expect(tr[0]).toMatchObject({ cached: 0, model: '@cf/zai-org/glm-4.7-flash' })
    expect(tr[0].neurons).toBeCloseTo(1.282, 2)
    expect(tr[1]).toMatchObject({ cached: 1, neurons: 0 })
  })

  it('answers null without calling the model once the budget is spent', async () => {
    const a = ai('{}')
    await db.prepare("INSERT INTO counters (key, n) VALUES ('neurons:2026-10-25', ?)").bind(RT_DAILY_NEURONS).run()
    const g = new ModelGate({ db, ai: a, mode: 'live', visitor: 'v', wsId: 'ws1', day: () => '2026-10-25' })
    expect(await g.ask('audit', [{ role: 'user', content: 'u' }], 120, 'k3')).toBeNull()
    expect(a.seen).toHaveLength(0)
  })
})

describe('settling a charge to the real cost', () => {
  it('gives back the worst case less the real cost on the app, visitor and ledger counters', async () => {
    const ledger = fakeD1()
    ledger.raw.exec('CREATE TABLE ai_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, app TEXT, day TEXT, neurons REAL, at TEXT)')
    const a = {
      seen: [] as unknown[],
      async run() { return { response: '{"ok":1}', usage: { prompt_tokens: 900, completion_tokens: 30, neurons: 2.5 } } },
    }
    const g = new ModelGate({ db, ai: a, mode: 'live', visitor: 'v', wsId: 'ws1', day: () => '2026-10-25', ledger })
    await g.ask('audit', [{ role: 'user', content: 'u' }], 120, 'k-settle')
    const app = await db.prepare("SELECT n FROM counters WHERE key = 'neurons:2026-10-25'").first<number>('n')
    const vis = await db.prepare("SELECT n FROM counters WHERE key = 'visitor:v:2026-10-25'").first<number>('n')
    expect(app).toBeCloseTo(2.5, 5)
    expect(vis).toBeCloseTo(2.5, 5)
    expect(await ledger.prepare("SELECT neurons FROM ai_calls WHERE app = 'running-tab'").first<number>('neurons')).toBeCloseTo(2.5, 5)
    const tr = await db.prepare("SELECT neurons FROM trace WHERE kind = 'model'").first<number>('neurons')
    expect(tr).toBe(2.5)
  })
})
