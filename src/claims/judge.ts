// The claim judge: the claimed call, the calls next to it in the same tab, and the agent's words. Claims bring what an
// audit cannot see, such as a client retry. Code checks the verdict: every named call is in the same tab, the evidence
// is copied from one of them, and a DUPLICATE really is the same tool with the same arguments.
import { OUTPUT_CAP } from '../ai/budget'
import { sha256, type ModelGate } from '../ai/model'
import { checkClaimVerdict, type ClaimCallView, type ClaimVerdict } from '../audit/checks'
import type { Call } from '../tab/ledger'

export const CLAIM_SYSTEM = [
  'You judge a claim from an AI agent that says a paid tool call was bad.',
  'You get the claimed call, the calls next to it in the same bill, and the agent\'s claim.',
  'Uphold the claim only if the log supports it. Reasons: DUPLICATE (the same request was made and billed twice, for example a client retry), LATE (the answer took far too long to be useful), OFF_REQUEST, INCOMPLETE, NONSENSE.',
  'Reply with one JSON object and nothing else:',
  '{"verdict": "approve" or "reject", "reason_code": "<one reason>", "evidence": "<a short phrase copied exactly from the request or answer of a call you cite>", "cited_call_ids": [<call numbers you rely on>]}',
].join('\n')

const NEIGHBOURS = 3
const MAX_TEXT = 600

export function answerText(resultJson: string): string {
  try {
    const r = JSON.parse(resultJson) as { content?: { text?: string }[] }
    return (r.content ?? []).map((c) => c?.text ?? '').join('\n')
  } catch { return '' }
}

export function view(c: Call): ClaimCallView {
  return { seq: c.seq, tool: c.tool, args_json: c.args_json, result_json: answerText(c.result_json).slice(0, MAX_TEXT), created_at: c.created_at, duration_ms: c.duration_ms, status: c.status, price_cents: c.price_cents }
}

export function makeClaimJudge(gate: ModelGate) {
  return async (claimText: string, claimed: Call, tabCalls: Call[]): Promise<ClaimVerdict | null> => {
    // The calls on each side, plus up to three earlier calls with the same request: a retry may be far from its twin.
    const twins = tabCalls.filter((c) => c.seq < claimed.seq - NEIGHBOURS && c.tool === claimed.tool && c.args_json === claimed.args_json).slice(-3)
    const near = [...twins, ...tabCalls.filter((c) => Math.abs(c.seq - claimed.seq) <= NEIGHBOURS)]
    const views = near.map(view)
    const t0 = claimed.created_at
    const shown = views.map((v) => ({
      call_id: v.seq, tool: v.tool, request: v.args_json, answer: v.result_json,
      status: v.status, price_cents: v.price_cents,
      seconds_from_claimed_call: Math.round((v.created_at - t0) / 100) / 10, took_seconds: Math.round(v.duration_ms / 100) / 10,
    }))
    const user = JSON.stringify({ claimed_call_id: claimed.seq, claim: claimText, calls: shown })
    const key = await sha256(user)
    const reply = await gate.ask('claim', [{ role: 'system', content: CLAIM_SYSTEM }, { role: 'user', content: user }], OUTPUT_CAP.claim, key)
    if (!reply) return null
    return checkClaimVerdict(reply.text, { claimed: view(claimed), tab_calls: views })
  }
}
