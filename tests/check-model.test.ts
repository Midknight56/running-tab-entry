import { describe, expect, it } from 'vitest'
import { pageHasCurrentModel } from '../tools/check-model.mjs'

const id = '@cf/zai-org/glm-4.7-flash'

describe('model page check', () => {
  it('flags planned deprecation', () => {
    expect(pageHasCurrentModel(`<p>${id}</p><p>Planned Deprecation 11/20/2026</p>`, id)).toBe(false)
  })

  it('flags a page without the full model id', () => {
    expect(pageHasCurrentModel('<p>No deprecation line</p>', id)).toBe(false)
  })

  it('passes a clean page that holds the full model id', () => {
    expect(pageHasCurrentModel(`<p>${id}</p><p>Available now</p>`, id)).toBe(true)
  })

  it('passes the request field note deprecated in favor of max completion tokens', () => {
    expect(pageHasCurrentModel(`<p>${id}</p><p>Deprecated in favor of max_completion_tokens</p>`, id)).toBe(true)
  })

  it('flags a plain deprecated badge', () => {
    expect(pageHasCurrentModel(`<p>${id}</p><span>Deprecated</span>`, id)).toBe(false)
  })
})
