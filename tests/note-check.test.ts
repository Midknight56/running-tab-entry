import { describe, expect, it } from 'vitest'
import { callRefs, checkExplain, checkNote, moneyFigures } from '../src/audit/checks'

const facts = { allowed_cents: [515, 25, 5], tab_seqs: [9, 14, 21, 24], struck_seqs: [9, 14], billed_cents: 515, billable_count: 3, struck_count: 2 }
const template = '3 calls billed for $5.15. 2 calls were struck and not billed.'

describe('note checks', () => {
  it('uses the template for a call outside the struck set', () => expect(checkNote('Call 24 was refunded.', facts)).toEqual({ text: template, used_template: true }))
  it('uses the template for an uncomputed money figure', () => expect(checkNote('We billed $5.16.', facts)).toEqual({ text: template, used_template: true }))
  it('keeps a valid trimmed note after the code amount', () => expect(checkNote('  Calls 9 and 14 were struck.  ', facts)).toEqual({ text: '3 calls billed for $5.15. Calls 9 and 14 were struck.', used_template: false }))
  it.each(['We billed $5.15.', 'Call 9 cost 25 cents.', 'It cost 5 dollars.', 'It cost 25¢.', 'It cost USD 5.', 'It cost twenty five cents.'])('rejects money even when the ledger holds it: %s', note => expect(checkNote(note, facts).used_template).toBe(true))
  it('caps the whole note including the code sentence', () => expect(checkNote('x'.repeat(270), facts)).toEqual({ text: template, used_template: true }))
  it('uses the template for 281 characters', () => expect(checkNote('x'.repeat(281), facts)).toEqual({ text: template, used_template: true }))
  it('extracts all money figures in cents', () => expect(moneyFigures('Total $5.15, refund 0.25 and 5 cents')).toEqual([515, 25, 5]))
  it('extracts every call reference', () => expect(callRefs('calls 9, 14 and 21 were struck; call #24 refunded')).toEqual([9, 14, 21, 24]))
})

describe('explanation checks', () => {
  const base = { ...facts, answer: 'Calls 9 and 14 were struck.', cited: [9] }
  it.each(['Call 9 cost $0.25.', 'Call 9 cost 25 cents.'])('rejects a money figure: %s', answer => expect(checkExplain('Fallback answer', { ...base, answer }).used_template).toBe(true))
  it('uses template when cited is empty', () => expect(checkExplain('Fallback answer', { ...base, cited: [] })).toEqual({ answer: 'Fallback answer', cited: [], used_template: true }))
  it('uses template for a citation outside the tab', () => expect(checkExplain('Fallback answer', { ...base, cited: [99] })).toEqual({ answer: 'Fallback answer', cited: [], used_template: true }))
  it('keeps a valid answer and citations', () => expect(checkExplain('Fallback answer', base)).toEqual({ answer: base.answer, cited: [9], used_template: false }))
})

describe('whole dollars', () => {
  it('counts "$5" as money and a bare number as not money', () => {
    expect(moneyFigures('You owe $5 today, not 24 calls')).toEqual([500])
  })
})
