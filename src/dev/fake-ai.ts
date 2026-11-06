// LOCAL RUNS ONLY. A stand in for Workers AI that judges like a careful auditor, so the desk can be tried with
// `wrangler dev` without any account's model pool. It is used only when DEV_FAKE_AI is "1" AND the request comes to
// localhost; the deployed Worker never has that variable. Trace rows from it are marked "local stand in".
import type { AiBinding } from '../env'

export const LOCAL_STAND_IN = 'local stand in'

export const fakeAi: AiBinding = {
  async run(_model: string, input: any) {
    const system: string = input.messages[0].content
    if (/Tools: \[/.test(system)) return studioReply(input)
    let user: any = {}
    try { user = JSON.parse(String(input.messages.at(-1).content)) } catch { /* words */ }
    const reply = (o: unknown) => ({ response: JSON.stringify(o) })
    if (system.startsWith('You audit')) {
      if (/weather/i.test(String(user.answer))) return reply({ call_id: user.call_id, verdict: 'strike', reason_code: 'OFF_REQUEST', evidence: 'London has mild weather this week' })
      return reply({ call_id: user.call_id, verdict: 'keep', reason_code: '', evidence: '' })
    }
    if (system.startsWith('You judge')) {
      const claimed = (user.calls ?? []).find((c: any) => c.call_id === user.claimed_call_id)
      const twin = (user.calls ?? []).find((c: any) => c.call_id !== user.claimed_call_id && c.request === claimed?.request)
      if (claimed && twin) return reply({ verdict: 'approve', claim_names: 'DUPLICATE', reason_code: 'DUPLICATE', evidence: claimed.request.slice(1, 15), cited_call_ids: [twin.call_id, claimed.call_id] })
      return reply({ verdict: 'reject' })
    }
    if (system.startsWith('You write')) return { response: '' }
    if (system.startsWith('You turn a seller')) {
      return reply({ type: 'column-chart-stacked', title: 'Struck calls by agent', category: 'calls.agent', value: 'calls.call', aggregation: 'count', split: 'calls.status' })
    }
    if (system.startsWith('You explain')) return reply({ answer: '', cited_call_ids: [] })
    return { response: 'The local stand in model has no answer for the desk assistant.' }
  },
}

function studioReply(input: any): { response: string } {
  const system = String(input.messages[0]?.content ?? '')
  const start = system.indexOf('Tools: ')
  let tools: { name: string; parameters?: any }[] = []
  try { tools = JSON.parse(system.slice(start + 7, system.indexOf('\n', start))) } catch { /* no listed tools */ }
  const offered = new Set(tools.map((tool) => tool.name))
  const history = input.messages.slice(1)
  const calls = history.flatMap((message: any) => {
    if (message.role !== 'assistant') return []
    try { return JSON.parse(message.content).tool_calls ?? [] } catch { return [] }
  })
  const called = (name: string) => calls.some((call: any) => call.name === name)
  const toolResults = history.filter((message: any) => message.role === 'user' && /^Tool result/.test(message.content))
  const prompt = String(history.find((message: any) => message.role === 'user' && !/^Tool result/.test(message.content))?.content ?? '')
  const reply = (name: string, args: Record<string, unknown>) => ({ response: JSON.stringify({ tool_calls: [{ name, arguments: args }] }) })

  if (offered.has('delegate_to') && !called('delegate_to')) {
    const schema = tools.find((tool) => tool.name === 'delegate_to')?.parameters
    const choices = schema?.properties?.type?.anyOf ?? []
    const pageTarget = choices.find((choice: any) => choice.properties?.id?.enum?.includes('page'))
    if (pageTarget) {
      const params: Record<string, unknown> = { id: 'page' }
      for (const key of Object.keys(pageTarget.properties ?? {})) {
        if (key === 'id') continue
        params[key] = pageTarget.properties[key].enum?.[0] ?? ''
      }
      return reply('delegate_to', { type: params, instructions: prompt || 'Add a chart of struck calls by agent.' })
    }
    const target = schema?.properties?.targetType?.enum?.[0] ?? 'widget'
    return reply('delegate_to', { targetType: target, instructions: prompt || 'Add a chart of struck calls by agent.', params: {} })
  }
  if (offered.has('delegate_to') && called('delegate_to') && toolResults.length) {
    return { response: 'Added a chart of struck calls by agent.' }
  }
  if (offered.has('view_schema') && !called('view_schema')) {
    if (offered.has('add_widget') && !called('add_widget')) {
      return { response: JSON.stringify({ tool_calls: [
        { name: 'view_schema', arguments: {} },
        { name: 'add_widget', arguments: { widgetId: 'struck-calls-by-agent', type: 'bar-chart-grouped', xTrack: 0, yTrack: 42, xSpan: 12, ySpan: 12 } },
      ] }) }
    }
    return reply('view_schema', {})
  }
  if (offered.has('add_widget') && !called('add_widget')) {
    return reply('add_widget', { widgetId: 'struck-calls-by-agent', type: 'bar-chart-grouped', xTrack: 0, yTrack: 42, xSpan: 12, ySpan: 12 })
  }
  if (offered.has('configure_widget') && !called('configure_widget')) {
    return reply('configure_widget', {
      widgetId: 'struck-calls-by-agent', type: 'bar-chart-grouped',
      dataMapping: { categoryKey: [{ id: 'calls.agent' }], valueKey: [{ id: 'calls.call', aggregation: 'count' }] },
      format: { title: { enabled: true, text: 'Struck calls by agent' } },
    })
  }
  if (offered.has('add_widget_filter') && !called('add_widget_filter')) {
    return reply('add_widget_filter', { widgetId: 'struck-calls-by-agent', field: { id: 'calls.status' }, model: { operator: 'equals', value: 'STRUCK' } })
  }
  if (offered.has('complete_task') && called('add_widget') && !called('complete_task')) {
    return reply('complete_task', {
      summary: 'Added a chart of struck calls by agent.',
      artifacts: [{ id: 'struck-calls-by-agent', type: 'bar-chart-grouped', description: 'Chart requested for calls.agent and calls.call.' }],
    })
  }
  if (toolResults.length && (called('add_widget_filter') || (called('configure_widget') && !offered.has('add_widget_filter')))) {
    return { response: 'Added a chart of struck calls by agent.' }
  }
  return { response: 'Added a chart of struck calls by agent.' }
}

export function useFakeAi(env: { DEV_FAKE_AI?: string }, request: Request): boolean {
  const host = new URL(request.url).hostname
  return env.DEV_FAKE_AI === '1' && (host === '127.0.0.1' || host === 'localhost')
}
