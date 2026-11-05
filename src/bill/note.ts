// The bill note: line items are code; the model writes only a note of at most 280 characters for the order's
// description and the statement. A note naming a call outside the struck set, or any money figure, is
// replaced by the plain template. Code adds the amount before the reason and caps the whole note.
import { OUTPUT_CAP } from '../ai/budget'
import { sha256, type ModelGate } from '../ai/model'
import { checkNote } from '../audit/checks'
import { dollars } from '../tab/pricing'
import type { TabFacts } from './facts'

export const NOTE_SYSTEM = [
  'You write a short, plain note for a bill sent to an AI agent\'s owner. At most 280 characters.',
  'Say which calls were billed and why struck calls were not billed. Use only the call numbers you are given. Never write dollar amounts, cents amounts or other money figures. Code supplies the amount.',
  'Reply with the note only.',
].join('\n')

export async function billNote(gate: ModelGate | null, f: TabFacts): Promise<{ text: string; used_template: boolean }> {
  const facts = {
    total: dollars(f.billed_cents), items: f.items.map((i) => `${i.quantity} x ${i.name} at ${dollars(i.unit_cents)}`),
    struck_calls: f.struck.map((s) => ({ call: s.seq, reason: s.reason_code })),
  }
  const user = JSON.stringify(facts)
  const reply = gate ? await gate.ask('note', [{ role: 'system', content: NOTE_SYSTEM }, { role: 'user', content: user }], OUTPUT_CAP.note, await sha256(user)) : null
  return checkNote(reply?.text, f)
}
