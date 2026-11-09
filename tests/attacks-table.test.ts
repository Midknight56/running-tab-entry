// The live attack table shows correctness apart from the verdict: a wrong answer that was billed is a FALSE CHARGE,
// never a plain PASS, and row A passes only with 0 false charges.
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain JavaScript module shared with tests/live/attacks.live.mjs
import { AUDITOR_GROUPS, auditorCounts, auditorLine, auditorResult, auditorTotals, AUDITOR_LEGEND, AUDITOR_HEADER, rowAPassed } from './live/attack-table.mjs'

const row = (group: string, actual: string) => ({ group, label: `${group} 1`, call: 1, actual })

describe('auditor rows', () => {
  it('mark a billed wrong answer as FALSE CHARGE', () => {
    expect(auditorResult(row('wrong', 'BILLABLE'))).toBe('FALSE CHARGE')
    expect(auditorResult(row('vague', 'BILLABLE'))).toBe('FALSE CHARGE')
    expect(auditorLine(row('wrong', 'BILLABLE'))).toBe('| wrong 1 | 1 | Struck by code (WRONG) | no | BILLABLE | yes | FALSE CHARGE |')
  })
  it('mark a struck good answer as FALSE STRIKE', () => {
    expect(auditorResult(row('good', 'STRUCK'))).toBe('FALSE STRIKE')
  })
  it('pass a struck bad answer and a billed good answer', () => {
    expect(auditorLine(row('wrong', 'STRUCK'))).toBe('| wrong 1 | 1 | Struck by code (WRONG) | no | STRUCK | no | PASS |')
    expect(auditorLine(row('repeat', 'BILLABLE'))).toBe('| repeat 1 | 1 | Kept and billed each time; no duplicate claim filed | yes | BILLABLE | yes | PASS |')
  })
  it('never pass a call that was not recorded', () => {
    expect(auditorResult(row('good', 'ERROR'))).toBe('FAIL')
  })
  it('has a header with the correctness and billed columns, and a legend that limits what a quote proves', () => {
    expect(AUDITOR_HEADER).toBe('| Label | Call | Expected | Answer correct | Actual | Billed | Result |')
    expect(AUDITOR_LEGEND).toMatch(/Answer correct/)
    expect(AUDITOR_LEGEND).toMatch(/does not prove the verdict is right/)
    expect(AUDITOR_LEGEND).not.toMatch(/does not check math/)
  })
})

describe('totals and row A', () => {
  const all = (actualFor: (g: string) => string) => AUDITOR_GROUPS.flatMap((g: any) => Array.from({ length: g.count }, (_, i) => ({ group: g.label, label: `${g.label} ${i + 1}`, actual: actualFor(g.label) })))
    .map((r: any, n: number) => ({ ...r, call: n + 1 }))
  it('count false charges, false strikes and held calls', () => {
    const rows = all((g) => (g === 'good' || g === 'repeat' ? 'BILLABLE' : g === 'wrong' ? 'BILLABLE' : 'STRUCK'))
    expect(auditorTotals(rows)).toEqual({ falseCharges: 4, falseStrikes: 0, held: 0 })
    expect(auditorCounts(rows).find((g: any) => g.label === 'wrong')).toMatchObject({ recorded: 4, kept: 4, struck: 0, held: 0 })
  })
  it('fail row A when any wrong answer is billed, and pass it when none is', () => {
    const before = all((g) => (g === 'good' || g === 'repeat' || g === 'wrong' ? 'BILLABLE' : 'STRUCK'))
    const after = all((g) => (g === 'good' || g === 'repeat' ? 'BILLABLE' : 'STRUCK'))
    expect(rowAPassed(before, { auditedCalls: 30, modelCalls: 16 })).toBe(false)
    expect(rowAPassed(after, { auditedCalls: 30, modelCalls: 16 })).toBe(true)
    expect(rowAPassed(after, { auditedCalls: 30, modelCalls: 40 })).toBe(false)
  })
})
