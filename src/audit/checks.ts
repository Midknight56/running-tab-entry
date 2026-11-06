import { cents, toCents } from '../tab/pricing'

export const AUDIT_REASONS = ['OFF_REQUEST', 'INCOMPLETE', 'NONSENSE'] as const
export const CLAIM_REASONS = ['OFF_REQUEST', 'INCOMPLETE', 'NONSENSE', 'DUPLICATE', 'LATE'] as const

export function parseModelJson(text: string): Record<string, unknown> | null {
  const source = text.replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, '')
  for (let start = source.indexOf('{'); start >= 0; start = source.indexOf('{', start + 1)) {
    let depth = 0
    let quoted = false
    let escaped = false
    for (let i = start; i < source.length; i++) {
      const c = source[i]
      if (quoted) {
        if (escaped) escaped = false
        else if (c === '\\') escaped = true
        else if (c === '"') quoted = false
        continue
      }
      if (c === '"') quoted = true
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) {
        try {
          const value: unknown = JSON.parse(source.slice(start, i + 1))
          if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype) return value as Record<string, unknown>
        } catch { /* Try the next balanced object. */ }
        break
      }
    }
  }
  return null
}

export interface AuditExpect { call_id: string; request: string; answer: string }
export type AuditVerdict = { status: 'BILLABLE'; judged_by: 'model' } | { status: 'STRUCK'; reason_code: string; evidence: string; judged_by: 'model' }

export function checkAuditVerdict(text: string, x: AuditExpect): AuditVerdict | null {
  const obj = parseModelJson(text)
  if (!obj || String(obj.call_id) !== x.call_id || (obj.verdict !== 'keep' && obj.verdict !== 'strike')) return null
  if (obj.verdict === 'keep') return { status: 'BILLABLE', judged_by: 'model' }
  if (typeof obj.reason_code !== 'string' || !(AUDIT_REASONS as readonly string[]).includes(obj.reason_code) || typeof obj.evidence !== 'string') return null
  const evidence = obj.evidence.trim()
  if (evidence.length < 4 || evidence.length > 300 || (!x.request.includes(evidence) && !x.answer.includes(evidence))) return null
  return { status: 'STRUCK', reason_code: obj.reason_code, evidence, judged_by: 'model' }
}

export interface ClaimCallView { seq: number; tool: string; args_json: string; result_json: string; created_at: number; duration_ms: number; status: string; price_cents: number }
export interface ClaimExpect { claimed: ClaimCallView; tab_calls: ClaimCallView[] }
export type ClaimVerdict = { approve: false; reason_code?: string; evidence?: string } | { approve: true; reason_code: string; evidence: string; cited_seqs: number[] }

export function checkClaimVerdict(text: string, x: ClaimExpect): ClaimVerdict | null {
  const obj = parseModelJson(text)
  if (!obj || (obj.verdict !== 'approve' && obj.verdict !== 'reject')) return null
  if (['amount', 'amount_cents', 'refund_amount', 'refund_cents'].some((key) => Object.hasOwn(obj, key))) return null
  if (obj.verdict === 'reject') {
    if (typeof obj.reason_code === 'string' && (CLAIM_REASONS as readonly string[]).includes(obj.reason_code) &&
      typeof obj.evidence === 'string' && Array.isArray(obj.cited_call_ids) &&
      obj.cited_call_ids.every((n) => Number.isInteger(n) && x.tab_calls.some((c) => c.seq === n))) {
      const cited = [...new Set([...obj.cited_call_ids as number[], x.claimed.seq])]
      const evidence = obj.evidence.trim()
      if (evidence.length >= 4 && evidence.length <= 300 && cited.some((seq) => {
        const call = x.tab_calls.find((c) => c.seq === seq)
        return !!call && (call.args_json.includes(evidence) || call.result_json.includes(evidence))
      })) return { approve: false, reason_code: obj.reason_code, evidence }
    }
    return { approve: false }
  }
  if (obj.claim_names !== obj.reason_code) return { approve: false }
  if (obj.reason_code === 'DUPLICATE' && !x.tab_calls.some((c) => c.seq !== x.claimed.seq && c.status === 'BILLABLE' && c.price_cents > 0 && c.tool === x.claimed.tool && c.args_json === x.claimed.args_json && Math.abs(c.created_at - x.claimed.created_at) <= 600000) && !x.tab_calls.some((c) => c.seq !== x.claimed.seq && c.status === 'PENDING_AUDIT' && c.tool === x.claimed.tool && c.args_json === x.claimed.args_json && Math.abs(c.created_at - x.claimed.created_at) <= 600000)) return { approve: false, reason_code: 'DUPLICATE' }
  if (typeof obj.reason_code !== 'string' || !(CLAIM_REASONS as readonly string[]).includes(obj.reason_code) || !Array.isArray(obj.cited_call_ids)) return null
  if (!obj.cited_call_ids.every((n) => Number.isInteger(n) && x.tab_calls.some((c) => c.seq === n))) return null
  if (typeof obj.evidence !== 'string') return null
  const citedSeqs = [...new Set([...obj.cited_call_ids as number[], x.claimed.seq])].sort((a, b) => a - b)
  const evidence = obj.evidence.trim()
  if (evidence.length < 4 || evidence.length > 300 || !citedSeqs.some((seq) => {
    const call = x.tab_calls.find((c) => c.seq === seq)
    return !!call && (call.args_json.includes(evidence) || call.result_json.includes(evidence))
  })) return null
  if (obj.reason_code === 'DUPLICATE' && (x.claimed.status !== 'BILLABLE' || !(x.claimed.price_cents > 0) || !citedSeqs.some((seq) => {
    const c = x.tab_calls.find((v) => v.seq === seq)
    return !!c && c.status === 'BILLABLE' && c.price_cents > 0 && c.seq !== x.claimed.seq && c.tool === x.claimed.tool && c.args_json === x.claimed.args_json && Math.abs(c.created_at - x.claimed.created_at) <= 600000
  }))) return null
  if (obj.reason_code === 'LATE' && x.claimed.duration_ms < 10000) return null
  return { approve: true, reason_code: obj.reason_code, evidence, cited_seqs: citedSeqs }
}

export interface MoneyFacts { allowed_cents: number[]; tab_seqs: number[]; struck_seqs: number[] }
export function moneyFigures(text: string): number[] {
  const out: number[] = []
  // "$5.10", "5.10", "$5" (whole dollars) and "25 cents" are money; a bare "24" is a call number or a count.
  const re = /\$?\b(\d+\.\d{1,2})\b|\$(\d+)(?![\d.])|\b(\d+)\s+cents\b/gi
  for (const m of text.matchAll(re)) out.push(m[1] ? toCents(m[1]) : m[2] ? Number(m[2]) * 100 : Number(m[3]))
  return out
}
export function callRefs(text: string): number[] {
  const out: number[] = []
  const re = /\bcalls?\s+#?\s*(\d+)(?:(?:\s*,\s*|\s+and\s+)(\d+))*/gi
  for (const m of text.matchAll(re)) {
    out.push(Number(m[1]))
    const tail = m[0].slice(m[0].indexOf(m[1]) + m[1].length)
    for (const n of tail.matchAll(/\d+/g)) out.push(Number(n[0]))
  }
  return out
}

function hasMoney(text: string): boolean {
  return /[$¢]|\b(?:dollars?|cents?|USD)\b|\b\d+\.\d+\b/i.test(text)
}

export function noteTemplate(f: { billed_cents: number; billable_count: number; struck_count: number }): string {
  return `${f.billable_count} calls billed for $${cents(f.billed_cents)}. ${f.struck_count === 0 ? 'No calls were struck.' : `${f.struck_count} calls were struck and not billed.`}`
}

export function checkNote(note: string | null | undefined, f: MoneyFacts & { billed_cents: number; billable_count: number; struck_count: number }): { text: string; used_template: boolean } {
  if (typeof note === 'string') {
    const trimmed = note.trim()
    const text = `${f.billable_count} calls billed for $${cents(f.billed_cents)}. ${trimmed}`
    if (trimmed.length > 0 && text.length <= 280 && !hasMoney(trimmed) && callRefs(trimmed).every((n) => f.struck_seqs.includes(n))) return { text, used_template: false }
  }
  return { text: noteTemplate(f), used_template: true }
}

export function checkExplain(text: string, f: MoneyFacts & { answer: string; cited: unknown }): { answer: string; cited: number[]; used_template: boolean } {
  if (typeof f.answer === 'string' && f.answer.trim().length > 0 && f.answer.length <= 600 && Array.isArray(f.cited) && f.cited.length > 0 && f.cited.every((n) => Number.isInteger(n) && f.tab_seqs.includes(n)) && !hasMoney(f.answer) && callRefs(f.answer).every((n) => f.tab_seqs.includes(n))) return { answer: f.answer.trim(), cited: [...new Set(f.cited as number[])], used_template: false }
  return { answer: text, cited: [], used_template: true }
}
