import { describe, expect, it } from 'vitest'
import { isClean, writeTrace } from '../src/trace'
import { fakeD1 } from './helpers/d1'

describe('trace rows', () => {
  it('refuses any row that holds Bearer, a client id, or the word secret', async () => {
    const db = fakeD1()
    expect(await writeTrace(db, { kind: 'paypal', method_path: 'POST /v2/checkout/orders', http: 201, ids: { id: 'ORD1' } }, ['client_ABCDEF'])).toBe(true)
    expect(await writeTrace(db, { kind: 'paypal', method_path: 'GET /x', ids: { h: 'Bearer abc' } })).toBe(false)
    expect(await writeTrace(db, { kind: 'paypal', method_path: 'GET /x?client_ABCDEF' }, ['client_ABCDEF'])).toBe(false)
    expect(await writeTrace(db, { kind: 'model', verdict: 'my secret' })).toBe(false)
    expect(isClean({ kind: 'paypal', ids: { access_token: 'x' } })).toBe(false)
    const rows = (await db.prepare('SELECT * FROM trace').all()).results
    expect(rows).toHaveLength(1)
  })
})
