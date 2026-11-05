import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('the add on stays movable', () => {
  it('only the optional payment barrel imports outside src/tab or the kit', () => {
    const dir = join(import.meta.dirname, '..', 'src', 'tab')
    const bad: string[] = []
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/from\s+'([^']+)'/g)) {
        const payment = ['../paypal/client', '../bill/settle', '../paypal/webhooks', '../claims/claims']
        const allowed = f === 'paypal.ts' ? payment.includes(m[1]) :
          (m[1].startsWith('./') && m[1] !== './paypal') || m[1] === 'mcp-on-workers'
        if (!allowed) bad.push(`${f}: ${m[1]}`)
      }
    }
    expect(bad).toEqual([])
  })
})
