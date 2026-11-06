import { describe, expect, it } from 'vitest'
import { checkAuditVerdict, checkClaimVerdict, parseModelJson, type ClaimCallView } from '../src/audit/checks'

const audit = { call_id: 'c1', request: 'convert 2 miles to km', answer: 'The result is 3.2 km.' }
const call = (seq: number, args_json: string, created_at = 1000): ClaimCallView => ({ seq, tool: 'convert', args_json, result_json: '{"value":"3.2 km"}', created_at, duration_ms: 1000, status: 'BILLABLE', price_cents: 25 })

describe('audit checks', () => {
  it('drops evidence absent from the log', () => expect(checkAuditVerdict('{"call_id":"c1","verdict":"strike","reason_code":"NONSENSE","evidence":"invented text"}', audit)).toBeNull())
  it('drops a foreign call id', () => expect(checkAuditVerdict('{"call_id":"other","verdict":"keep"}', audit)).toBeNull())
  it('drops an unknown reason', () => expect(checkAuditVerdict('{"call_id":"c1","verdict":"strike","reason_code":"PRICE","evidence":"2 miles"}', audit)).toBeNull())
  it('keeps without evidence', () => expect(checkAuditVerdict('{"call_id":"c1","verdict":"keep"}', audit)).toEqual({ status: 'BILLABLE', judged_by: 'model' }))
  it('never copies extra refund fields', () => {
    const result = checkAuditVerdict('{"call_id":"c1","verdict":"strike","reason_code":"OFF_REQUEST","evidence":"2 miles","refund_cents":999}', audit)
    expect(result).toEqual({ status: 'STRUCK', reason_code: 'OFF_REQUEST', evidence: '2 miles', judged_by: 'model' })
    expect(JSON.stringify(result)).not.toContain('999')
  })
  it('parses JSON wrapped in prose, fences, and think blocks', () => {
    expect(parseModelJson('<think>{"bad":true}</think>\nHere: ```json\n{"ok":true}\n```')).toEqual({ ok: true })
  })
})

describe('claim checks', () => {
  const claimed = { ...call(24, '{"q":"same"}', 3900), duration_ms: 12000 }
  const expects = (otherArgs = claimed.args_json) => ({ claimed, tab_calls: [call(23, otherArgs, 1000), claimed] })
  const approve = '{"verdict":"approve","claim_names":"DUPLICATE","reason_code":"DUPLICATE","evidence":"same","cited_call_ids":[23,24]}'
  it('does not approve a fault the claim did not name', () => {
    expect(checkClaimVerdict(approve.replace('"claim_names":"DUPLICATE"', '"claim_names":"NONE"'), expects())).toEqual({ approve: false })
  })
  it('does not approve when the claim names are missing', () => {
    expect(checkClaimVerdict(approve.replace('"claim_names":"DUPLICATE",', ''), expects())).toEqual({ approve: false })
  })
  it('approves a duplicate within the time window', () => expect(checkClaimVerdict(approve, expects())).toEqual({ approve: true, reason_code: 'DUPLICATE', evidence: 'same', cited_seqs: [23, 24] }))
  it.each([{ status: 'STRUCK' }, { status: 'PENDING_AUDIT' }, { status: 'REFUNDED' }, { price_cents: 0 }])('drops an ineligible claimed duplicate: %j', change => {
    const invalid = { ...claimed, ...change }
    expect(checkClaimVerdict(approve, { claimed: invalid, tab_calls: [call(23, claimed.args_json), invalid] })).toBeNull()
  })
  it('rejects a duplicate claim when no matching twin exists', () => {
    const unrelated = [call(21, '{"q":"other"}', 2000), call(22, '{"q":"another"}', 2500)]
    const text = '{"verdict":"approve","claim_names":"DUPLICATE","reason_code":"DUPLICATE","evidence":"same","cited_call_ids":[21,22]}'
    expect(checkClaimVerdict(text, { claimed, tab_calls: [...unrelated, claimed] })).toEqual({ approve: false, reason_code: 'DUPLICATE' })
  })
  it('leaves a duplicate claim for the seller when its matching call is pending audit', () => {
    const pendingTwin = { ...call(23, claimed.args_json, 1000), status: 'PENDING_AUDIT' }
    expect(checkClaimVerdict(approve, { claimed, tab_calls: [pendingTwin, claimed] })).toBeNull()
  })
  it('leaves a duplicate claim for the seller when its twin is not cited', () => {
    const twin = call(23, claimed.args_json, 1000)
    const other = call(22, '{"q":"other"}', 1200)
    const text = '{"verdict":"approve","claim_names":"DUPLICATE","reason_code":"DUPLICATE","evidence":"same","cited_call_ids":[22,24]}'
    expect(checkClaimVerdict(text, { claimed, tab_calls: [other, twin, claimed] })).toBeNull()
  })
  it('drops a cited seq outside the tab', () => expect(checkClaimVerdict(approve.replace('[23,24]', '[23,99]'), expects())).toBeNull())
  it('drops LATE when duration is too short', () => expect(checkClaimVerdict('{"verdict":"approve","claim_names":"LATE","reason_code":"LATE","evidence":"same","cited_call_ids":[24]}', { ...expects(), claimed: { ...claimed, duration_ms: 3000 } })).toBeNull())
  it('returns a minimal rejection', () => expect(checkClaimVerdict('{"verdict":"reject","reason_code":"nonsense"}', expects())).toEqual({ approve: false }))
})
