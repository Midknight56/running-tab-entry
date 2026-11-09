// "Ask the desk": a seller's question becomes one AG Studio widget. One small model call writes a widget spec; code
// keeps it only if its type is one the desk offers and every field is a real field of one table with the right role.
// The desk then adds the widget through Studio's public api. Studio's own agents (edit mode) do the same work in many
// rounds; this path costs one round.
import { OUTPUT_CAP } from './ai/budget'
import { sha256, type ModelGate } from './ai/model'
import { parseModelJson } from './audit/checks'

export const WIDGET_TYPES = ['column-chart-grouped', 'column-chart-stacked', 'bar-chart-grouped', 'pie-chart', 'donut-chart', 'value'] as const
export type WidgetType = (typeof WIDGET_TYPES)[number]
const AGGREGATIONS = ['sum', 'count', 'avg', 'min', 'max'] as const

/** The desk's data sources (desk/src/data.ts): category fields and number fields per table. */
const callFields = { category: ['agent', 'tool', 'status', 'reason', 'judged_by', 'day', 'history'], number: ['call', 'price', 'seconds'] }
const claimFields = { category: ['agent', 'reason', 'state', 'refund', 'claim'], number: ['call', 'amount'] }
export const FIELDS: Record<string, { category: string[]; number: string[] }> = {
  calls: callFields,
  struck: callFields,
  billed: callFields,
  billable: callFields,
  refunded_calls: callFields,
  tabs: { category: ['tab', 'agent', 'state', 'order', 'capture'], number: ['total', 'captured', 'refunded'] },
  refunds: claimFields,
  claims: claimFields,
}

export interface WidgetSpec { type: WidgetType; title: string; scope: string; category?: string; value: string; aggregation: (typeof AGGREGATIONS)[number]; split?: string }

const SOURCE_LABELS: Record<string, string> = {
  calls: 'All calls',
  struck: 'Struck calls',
  billable: 'Billable calls',
  billed: 'Billed calls, refunded included',
  refunded_calls: 'Refunded calls',
  tabs: 'Tabs',
  claims: 'All claims',
  refunds: 'Refunded claims',
}

const SOURCE_SCOPES: Record<string, string> = {
  calls: 'Counts every call, any status.',
  struck: 'Counts only calls with status STRUCK.',
  billable: 'Counts only calls with status BILLABLE.',
  billed: 'Counts only calls with status BILLABLE or REFUNDED.',
  refunded_calls: 'Counts only calls with status REFUNDED.',
  tabs: 'Counts every tab, any state.',
  claims: 'Counts every claim, any state.',
  refunds: 'Counts only claims with state REFUNDED.',
}

const AGG_LABELS: Record<string, string> = {
  sum: 'Sum',
  count: 'Count',
  avg: 'Average',
  min: 'Lowest',
  max: 'Highest',
}

function buildTitleAndScope(source: string, aggregation: string, valueName: string, categoryName?: string, splitName?: string): { title: string; scope: string } {
  const sourceLabel = SOURCE_LABELS[source] ?? source
  const isCountOfCall = aggregation === 'count' && valueName === 'call'
  const aggName = AGG_LABELS[aggregation] ?? aggregation
  let title: string
  if (categoryName) {
    const splitPart = splitName ? ` and ${splitName}` : ''
    if (isCountOfCall) {
      title = `${sourceLabel} by ${categoryName}${splitPart}`
    } else {
      title = `${aggName} of ${valueName}: ${sourceLabel.toLowerCase()} by ${categoryName}${splitPart}`
    }
  } else {
    if (isCountOfCall) {
      title = sourceLabel
    } else {
      title = `${aggName} of ${valueName}: ${sourceLabel.toLowerCase()}`
    }
  }
  const scope = SOURCE_SCOPES[source] ?? `Counts every row from ${source}.`
  return { title, scope }
}

function field(id: unknown): { table: string; name: string } | null {
  if (typeof id !== 'string') return null
  const [table, name, extra] = id.split('.')
  if (extra !== undefined || !FIELDS[table] || !name) return null
  return { table, name }
}

const FILTER_REFUSAL = { ok: false as const, reason: 'I can filter calls by billable, refunded or struck status, or claims by refunded state. Try struck calls by agent.' }

export function checkSpec(text: string): WidgetSpec | typeof FILTER_REFUSAL | null {
  const o = parseModelJson(text)
  if (!o) return null
  let filtered: { table: string; source: string } | undefined
  if ('filter' in o) {
    const f = o.filter
    if (!f || typeof f !== 'object' || Array.isArray(f) || Object.keys(f).some(k => k !== 'field' && k !== 'equals')) return FILTER_REFUSAL
    const { field: id, equals } = f as Record<string, unknown>
    const source = id === 'calls.status' ? equals === 'STRUCK' ? 'struck' : equals === 'BILLABLE' ? 'billable' : equals === 'REFUNDED' ? 'refunded_calls' : null
      : id === 'claims.state' && equals === 'REFUNDED' ? 'refunds' : null
    if (!source) return FILTER_REFUSAL
    filtered = { table: String(id).split('.')[0], source }
  }
  if (!(WIDGET_TYPES as readonly string[]).includes(String(o.type))) return null
  if (!(AGGREGATIONS as readonly string[]).includes(String(o.aggregation))) return null
  // A common slip (seen live, 23 Oct): "value": "count". Counting rows means the category table's `call` field.
  if ((o.value === 'count' || o.value === 'rows') && o.aggregation === 'count') {
    const cat = field(o.category)
    if (cat && FIELDS[cat.table].number.includes('call')) o.value = `${cat.table}.call`
  }
  const value = field(o.value)
  if (filtered && (!value || value.table !== filtered.table)) return FILTER_REFUSAL
  if (!value || !FIELDS[value.table].number.includes(value.name)) return null
  const type = o.type as WidgetType
  const spec: WidgetSpec = { type, title: '', scope: '', value: `${value.table}.${value.name}`, aggregation: o.aggregation as WidgetSpec['aggregation'] }
  if (type !== 'value') {
    const cat = field(o.category)
    if (!cat || cat.table !== value.table || !FIELDS[cat.table].category.includes(cat.name)) return null
    spec.category = `${cat.table}.${cat.name}`
    if (o.split !== undefined && o.split !== null && o.split !== '') {
      const split = field(o.split)
      if (!split || split.table !== value.table || !FIELDS[split.table].category.includes(split.name)) return null
      // A split on the category's own field says nothing more and doubles the title ("by agent and agent"): drop it.
      if (split.name !== cat.name) spec.split = `${split.table}.${split.name}`
    }
  }
  if (filtered) {
    const rewrite = (id: string) => `${filtered.source}.${id.split('.')[1]}`
    spec.value = rewrite(spec.value)
    if (spec.category) spec.category = rewrite(spec.category)
    if (spec.split) spec.split = rewrite(spec.split)
  }
  const finalSource = spec.value.split('.')[0]
  const valName = spec.value.split('.')[1]
  const catName = spec.category ? spec.category.split('.')[1] : undefined
  const splitName = spec.split ? spec.split.split('.')[1] : undefined
  const { title, scope } = buildTitleAndScope(finalSource, spec.aggregation, valName, catName, splitName)
  spec.title = title
  spec.scope = scope
  return spec
}

export const ASK_SYSTEM = [
  'You turn a seller\'s question about their billing desk into one chart. Reply with one JSON object and nothing else:',
  '{"type": one of ' + WIDGET_TYPES.join(', ') + ', "title": "<short title>", "category": "<table.field to group by>", "value": "<table.field to measure>", "aggregation": "sum" or "count" or "avg" or "min" or "max", "split": "<optional table.field to colour by>", "filter": {"field": "<table.field>", "equals": "<value>"}}',
  'Tables and fields. calls: agent, tool, status (BILLABLE, STRUCK, REFUNDED, PENDING_AUDIT), reason, judged_by, day, history; numbers call (count it), price, seconds.',
  'struck: only calls with status STRUCK. billable: only calls with status BILLABLE. refunded_calls: only calls with status REFUNDED. billed is named Billed calls, refunded included: calls with status BILLABLE or REFUNDED. These sources have the same fields as calls. Use billed only when the seller names that combined source.',
  'tabs: tab, agent, state (OPEN, DUE, PAID), order, capture; numbers total, captured, refunded. claims: every claim, including waiting and rejected; agent, reason, state, refund, claim; numbers call (count it), amount (dollars). refunds: only completed claims with state REFUNDED, with the same fields as claims.',
  'The filter is optional. Only calls.status equals STRUCK, BILLABLE or REFUNDED, or claims.state equals REFUNDED is supported. For those filters use fields from calls or claims; the desk maps them to struck, billable, refunded_calls or refunds respectively. A status filter never maps to billed. Use the filtered source directly when possible. Never name a filtered scope in the title without using its source or a supported filter.',
  'All fields of one chart come from one table. Every field is written table.field. To count calls, use value "calls.call" with aggregation "count". To show something per status, use split "calls.status" with a stacked chart.',
].join('\n')

export async function askDesk(gate: Pick<ModelGate, 'ask'> | null, question: string): Promise<{ ok: true; spec: WidgetSpec } | { ok: false; busy?: boolean; reason: string }> {
  const q = question.trim().slice(0, 200)
  if (!q) return { ok: false, reason: 'Ask for a chart, for example struck calls by agent.' }
  const reply = gate ? await gate.ask('widget', [{ role: 'system', content: ASK_SYSTEM }, { role: 'user', content: q }], OUTPUT_CAP.widget, await sha256(q.toLowerCase())) : null
  if (!reply) return { ok: false, busy: true, reason: "The desk's assistant has used its share for today. The desk and the demo still work." }
  const spec = checkSpec(reply.text)
  if (!spec) return { ok: false, reason: 'I could not turn that into a chart. Try naming what to group by and what to count.' }
  if ('ok' in spec) return spec

  const statusMatches = Array.from(new Set((q.match(/\b(struck|billable|refunded)\b/gi) ?? []).map(w => w.toLowerCase())))
  if (statusMatches.length === 1) {
    const status = statusMatches[0]
    const namesClaims = /\bclaims?\b/i.test(q)
    const isClaimsRefund = namesClaims && status === 'refunded'
    const targetSource = isClaimsRefund ? 'refunds' : status === 'struck' ? 'struck' : status === 'billable' ? 'billable' : 'refunded_calls'
    const unfilteredTable = isClaimsRefund ? 'claims' : 'calls'
    const splitField = isClaimsRefund ? 'state' : 'status'
    const FILTERED_SOURCES = new Set(['struck', 'billable', 'billed', 'refunded_calls', 'refunds'])
    const specSource = spec.value.split('.')[0]

    if (FILTERED_SOURCES.has(specSource) && specSource !== targetSource) {
      return FILTER_REFUSAL
    }

    if (specSource === unfilteredTable) {
      const rewrite = (id: string) => `${targetSource}.${id.split('.')[1]}`
      spec.value = rewrite(spec.value)
      if (spec.category) spec.category = rewrite(spec.category)
      if (spec.split) {
        if (spec.split.split('.')[1] === splitField) {
          delete spec.split
        } else {
          spec.split = rewrite(spec.split)
        }
      }
      const finalSource = spec.value.split('.')[0]
      const valName = spec.value.split('.')[1]
      const catName = spec.category ? spec.category.split('.')[1] : undefined
      const splitName = spec.split ? spec.split.split('.')[1] : undefined
      const { title, scope } = buildTitleAndScope(finalSource, spec.aggregation, valName, catName, splitName)
      spec.title = title
      spec.scope = scope
    } else if (specSource === targetSource && spec.split && spec.split.split('.')[1] === splitField) {
      delete spec.split
      const finalSource = spec.value.split('.')[0]
      const valName = spec.value.split('.')[1]
      const catName = spec.category ? spec.category.split('.')[1] : undefined
      const { title, scope } = buildTitleAndScope(finalSource, spec.aggregation, valName, catName)
      spec.title = title
      spec.scope = scope
    }
  }

  return { ok: true, spec }
}
