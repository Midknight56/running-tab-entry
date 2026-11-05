import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { initialReport } from '../studio/report'

const layout = initialReport.pages[0].widgetLayout as Record<string, { xTrack: number; yTrack: number; xSpan: number; ySpan: number }>

describe('the saved desk layout', () => {
  it('gives the money widget room for its four figures, the plain meter line and the bars', () => {
    // At 6 rows the content spilled above the box and the title was drawn over "Captured" (film frame, 28 Oct).
    expect(layout.flow.ySpan).toBeGreaterThanOrEqual(10)
  })

  it('tiles each column with no overlap and no gap, to the same height', () => {
    const columns = new Map<number, { yTrack: number; ySpan: number }[]>()
    for (const w of Object.values(layout)) columns.set(w.xTrack, [...(columns.get(w.xTrack) ?? []), w])
    const heights = [...columns.values()].map((items) => {
      let y = 0
      for (const w of [...items].sort((a, b) => a.yTrack - b.yTrack)) {
        expect(w.yTrack).toBe(y)
        y += w.ySpan
      }
      return y
    })
    expect(new Set(heights).size).toBe(1)
  })

  it('starts the money figures at the top, so extra content never runs under the title', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf-8')
    const rule = css.match(/\.rt-flow \{[^}]*\}/)?.[0] ?? ''
    expect(rule).toContain('align-content: start')
  })
})
