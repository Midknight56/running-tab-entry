import { describe, expect, it, vi } from 'vitest'

const createAiHarnessMock = vi.hoisted(() => vi.fn((_api: unknown, options: unknown) => options))
vi.mock('ag-studio', () => ({ createAiHarness: createAiHarnessMock }))

import { deskAi, PROMPT_STARTERS } from '../studio/ai'

describe('Studio assistant actions', () => {
  it('gets only its chart adapter and chart prompt starters', () => {
    const api = {}
    const options = deskAi({ api }) as unknown as Record<string, unknown>
    expect(createAiHarnessMock).toHaveBeenCalledOnce()
    expect(createAiHarnessMock).toHaveBeenCalledWith(api, expect.any(Object))
    expect(PROMPT_STARTERS.every((starter) => starter.prompt.startsWith('Add a '))).toBe(true)
    expect(options).toHaveProperty('adapter')
    expect(options).toHaveProperty('promptStarters')
    expect(options).not.toHaveProperty('tools')
    expect(options).not.toHaveProperty('routes')
    expect(Object.keys(options).sort()).toEqual(['adapter', 'promptStarters'])
  })
})
