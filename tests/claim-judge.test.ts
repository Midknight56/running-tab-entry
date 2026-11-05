import { describe, expect, it } from 'vitest'
import { makeClaimJudge } from '../src/claims/judge'
import type { Call } from '../src/tab/ledger'

const call = (seq: number, args: string): Call => ({
  id: 'c' + seq, seq, ws_id: 'ws1', agent_id: 'a1', tab_id: 't1', tool: 'convert_time', args_json: args,
  result_json: JSON.stringify({ content: [{ type: 'text', text: `answer ${seq}` }] }), price_cents: 25, status: 'BILLABLE',
  reason_code: null, evidence: null, judged_by: null, duration_ms: 100, created_at: seq * 1000,
})

describe('claim judge', () => {
  it('shows billing status and price to the judge', async () => {
    const claimed = call(2, '{"time":"09:00"}')
    let shown: any[] = []
    const judge = makeClaimJudge({ ask: async (_job: string, messages: { content: string }[]) => {
      shown = JSON.parse(messages[1].content).calls
      return { text: '{"verdict":"reject"}' }
    } } as never)
    await judge('billed twice', claimed, [{ ...call(1, claimed.args_json), status: 'STRUCK' }, claimed])
    expect(shown).toMatchObject([{ status: 'STRUCK', price_cents: 25 }, { status: 'BILLABLE', price_cents: 25 }])
  })

  it('shows the model an earlier call with the same request even when it is far from the claimed call', async () => {
    const twin = '{"time":"09:00","from":"America/Halifax"}'
    const calls = [call(1, twin), ...[2, 3, 4, 5, 6, 7].map((n) => call(n, `{"time":"1${n}:00"}`)), call(8, twin)]
    let shown: number[] = []
    const gate = {
      async ask(_job: string, messages: { content: string }[]) {
        shown = JSON.parse(messages[1].content).calls.map((c: { call_id: number }) => c.call_id)
        return { text: JSON.stringify({ verdict: 'approve', reason_code: 'DUPLICATE', evidence: '"time":"09:00"', cited_call_ids: [1, 8] }), source: 'live', neurons: 1 }
      },
    }
    const v = await makeClaimJudge(gate as never)('billed twice', calls[7], calls)
    expect(shown).toContain(1)
    expect(shown).toContain(8)
    expect(v).toMatchObject({ approve: true, reason_code: 'DUPLICATE', cited_seqs: [1, 8] })
  })
})
