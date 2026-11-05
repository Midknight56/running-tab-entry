import { describe, expect, it } from 'vitest'
import { fakeAi } from '../src/dev/fake-ai'

const prompt = 'Add a bar chart of struck calls by agent'
const tools = (items: { name: string; parameters?: unknown }[]) => `Studio instructions\nTools: ${JSON.stringify(items)}\nUse the listed tools.`
const tool = (name: string, args: Record<string, unknown>) => ({ role: 'assistant', content: JSON.stringify({ tool_calls: [{ name, arguments: args }] }) })
const result = (name: string) => ({ role: 'user', content: `Tool result (call-1): ${name} completed` })
const run = async (messages: { role: string; content: string }[]) => ((await fakeAi.run('local', { messages })) as { response: string }).response
const runTools = async (messages: { role: string; content: string }[]) => JSON.parse(await run(messages))

describe('local Studio replies', () => {
  it('delegates when the orchestrator offers delegation', async () => {
    const reply = await runTools([
      { role: 'system', content: tools([{ name: 'delegate_to', parameters: { properties: { type: { anyOf: [
        { properties: { id: { enum: ['data'] } } }, { properties: { id: { enum: ['page'] }, pageId: { enum: ['desk'] } } },
      ] } } } }]) },
      { role: 'user', content: prompt },
    ])
    expect(reply.tool_calls[0]).toEqual({ name: 'delegate_to', arguments: { type: { id: 'page', pageId: 'desk' }, instructions: prompt } })
  })

  it('looks at the schema once after delegation', async () => {
    const reply = await runTools([
      { role: 'system', content: tools([{ name: 'view_schema' }, { name: 'add_widget' }]) },
      { role: 'user', content: prompt },
      tool('delegate_to', { targetType: 'widget_agent', instructions: prompt }),
      result('delegate_to'),
    ])
    expect(reply.tool_calls).toEqual([
      { name: 'view_schema', arguments: {} },
      { name: 'add_widget', arguments: { widgetId: 'struck-calls-by-agent', type: 'bar-chart-grouped', xTrack: 0, yTrack: 42, xSpan: 12, ySpan: 12 } },
    ])
  })

  it('adds a chart using the desk call fields', async () => {
    const reply = await runTools([
      { role: 'system', content: tools([{ name: 'view_schema' }, { name: 'add_widget' }]) },
      { role: 'user', content: prompt },
      tool('view_schema', {}),
      result('view_schema'),
    ])
    expect(reply.tool_calls[0]).toEqual({ name: 'add_widget', arguments: {
      widgetId: 'struck-calls-by-agent', type: 'bar-chart-grouped', xTrack: 0, yTrack: 42, xSpan: 12, ySpan: 12,
    } })
  })

  it('summarizes the added widget for its delegating agent', async () => {
    const reply = await runTools([
      { role: 'system', content: tools([{ name: 'add_widget' }, { name: 'complete_task' }]) },
      { role: 'user', content: prompt },
      tool('add_widget', { widgetId: 'struck-calls-by-agent' }),
      result('add_widget'),
    ])
    expect(reply.tool_calls[0]).toEqual({ name: 'complete_task', arguments: {
      summary: 'Added a chart of struck calls by agent.',
      artifacts: [{ id: 'struck-calls-by-agent', type: 'bar-chart-grouped', description: 'Chart requested for calls.agent and calls.call.' }],
    } })
  })

  it('answers in words after the delegated result', async () => {
    const reply = await run([
      { role: 'system', content: tools([{ name: 'delegate_to' }, { name: 'view_schema' }]) },
      { role: 'user', content: prompt },
      tool('delegate_to', { type: { id: 'page', pageId: 'desk' }, instructions: prompt }),
      result('delegate_to'),
    ])
    expect(reply).toBe('Added a chart of struck calls by agent.')
  })
})
