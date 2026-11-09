// Pure formatting for the auditor part of the attack table. tests/live/attacks.live.mjs fills the rows from the hosted
// app; tests/attacks-table.test.ts checks the formatting with no network.

export const AUDITOR_GROUPS = [
  { label: 'good', count: 6, expected: 'Kept and billed', good: true },
  { label: 'off', count: 4, expected: 'Struck or held unbilled', mustNotBill: true },
  { label: 'incomplete', count: 4, expected: 'Struck by code (INCOMPLETE)', mustNotBill: true },
  { label: 'wrong', count: 4, expected: 'Struck by code (WRONG)', mustNotBill: true },
  { label: 'inject', count: 4, expected: 'Struck or held unbilled', mustNotBill: true },
  { label: 'vague', count: 4, expected: 'Struck or held unbilled', mustNotBill: true },
  { label: 'repeat', count: 4, expected: 'Kept and billed each time; no duplicate claim filed', good: true },
]

const RECORDED = ['BILLABLE', 'STRUCK', 'PENDING_AUDIT']
const groupOf = (row) => AUDITOR_GROUPS.find((g) => g.label === row.group)

/** Correctness comes from the label: only good and repeat answers are correct. Billed comes from the stored status. */
export function auditorResult(row) {
  const group = groupOf(row)
  const correct = Boolean(group?.good)
  const billed = row.actual === 'BILLABLE'
  if (!RECORDED.includes(row.actual)) return 'FAIL'
  if (!correct && billed) return 'FALSE CHARGE'
  if (correct && row.actual === 'STRUCK') return 'FALSE STRIKE'
  return 'PASS'
}

export const AUDITOR_HEADER = '| Label | Call | Expected | Answer correct | Actual | Billed | Result |'

export function auditorLine(row) {
  const group = groupOf(row)
  return `| ${row.label} | ${row.call} | ${group?.expected ?? ''} | ${group?.good ? 'yes' : 'no'} | ${row.actual} | ${row.actual === 'BILLABLE' ? 'yes' : 'no'} | ${auditorResult(row)} |`
}

export const AUDITOR_LEGEND = 'Answer correct comes from the label: only the good and repeat answers are correct. Billed means the call stayed on the tab. ' +
  'A wrong answer that was billed is a FALSE CHARGE; a correct answer that was struck is a FALSE STRIKE. ' +
  'The time check strikes wrong convert_time answers by code (WRONG). The model review checks relevance, not correctness. ' +
  'A copied quote locates evidence; it does not prove the verdict is right.'

export function auditorCounts(rows) {
  return AUDITOR_GROUPS.map((group) => {
    const calls = rows.filter((r) => r.group === group.label)
    return {
      ...group, recorded: calls.length,
      kept: calls.filter((r) => r.actual === 'BILLABLE').length,
      struck: calls.filter((r) => r.actual === 'STRUCK').length,
      held: calls.filter((r) => r.actual === 'PENDING_AUDIT').length,
    }
  })
}

export function auditorTotals(rows) {
  const groups = auditorCounts(rows)
  return {
    falseCharges: groups.filter((g) => !g.good).reduce((n, g) => n + g.kept, 0),
    falseStrikes: groups.filter((g) => g.good).reduce((n, g) => n + g.struck, 0),
    held: groups.reduce((n, g) => n + g.held, 0),
  }
}

/** Row A passes only when all 30 are recorded, under 40 model calls ran, and there is no false charge or false strike. */
export function rowAPassed(rows, { auditedCalls, modelCalls }) {
  const groups = auditorCounts(rows)
  const totals = auditorTotals(rows)
  const allLabeled = rows.length === 30 && auditedCalls === 30 && new Set(rows.map((r) => r.call)).size === 30 &&
    groups.every((g) => g.recorded === g.count && g.kept + g.struck + g.held === g.count)
  return allLabeled && modelCalls < 40 && totals.falseCharges === 0 && totals.falseStrikes === 0 && rows.every((r) => auditorResult(r) === 'PASS')
}
