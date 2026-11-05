// The code rules: plainly broken answers are struck without asking anyone. ERROR, EMPTY, SHAPE.
import { validate, type JsonSchema, type ToolResult } from 'mcp-on-workers'

export interface RuleVerdict { reason_code: 'ERROR' | 'EMPTY' | 'SHAPE'; evidence: string }

export function codeRules(result: ToolResult, outputSchema?: JsonSchema): RuleVerdict | null {
  const text = (result.content ?? []).map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n')
  if (result.isError) return { reason_code: 'ERROR', evidence: text.slice(0, 200) || 'isError' }
  const hasStructured = result.structuredContent && Object.keys(result.structuredContent).length > 0
  if (!text.trim() && !hasStructured) return { reason_code: 'EMPTY', evidence: '' }
  if (outputSchema) {
    if (!hasStructured) return { reason_code: 'SHAPE', evidence: 'no structuredContent' }
    const problems = validate(outputSchema, result.structuredContent)
    if (problems.length) return { reason_code: 'SHAPE', evidence: problems.join('; ').slice(0, 200) }
  }
  return null
}
