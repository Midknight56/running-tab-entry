// Independent calendar conversion checks for convert time
import type { ToolResult } from 'mcp-on-workers'

function readOffset(instant: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(instant)
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? ''
  const m = tz.match(/^GMT([+-])(\d{2}):(\d{2})$/)
  if (!m) {
    if (tz === 'GMT' || tz === 'UTC') return 0
    throw new Error('Unknown offset: ' + tz)
  }
  const sign = m[1] === '+' ? 1 : -1
  const hours = parseInt(m[2], 10)
  const minutes = parseInt(m[3], 10)
  return sign * (hours * 60 + minutes) * 60 * 1000
}

function validDate(val: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return false
  const d = new Date(`${val}T00:00:00.000Z`)
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === val
}

const HOUR = 3600 * 1000

/** Every destination wall time the source wall time can mean. On a clock change day a wall time can happen twice (fall
 *  back: two answers are both right) or not at all (spring forward: no answer can be checked, so an empty list). */
function computeDestinations(date: string, time: string, from: string, to: string): { date: string; time: string }[] {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const wallMs = Date.UTC(year, month - 1, day, hour, minute)
  // A zone's offset changes at most once in a day, so the offsets a day before and after cover every candidate.
  const offsets = new Set([readOffset(new Date(wallMs - 24 * HOUR), from), readOffset(new Date(wallMs), from), readOffset(new Date(wallMs + 24 * HOUR), from)])
  const instants = [...offsets].map((off) => wallMs - off).filter((instant) => readOffset(new Date(instant), from) === wallMs - instant)
  return [...new Set(instants)].map((instant) => {
    const destWall = new Date(instant + readOffset(new Date(instant), to))
    return { date: destWall.toISOString().slice(0, 10), time: destWall.toISOString().slice(11, 16) }
  })
}

function textOf(r: ToolResult): string {
  return (r.content ?? []).map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n')
}

/** WRONG when the stated destination time, date or zone is wrong; null when it is right; HOLD when the request
 *  itself cannot be checked; UNCHECKED when the answer states no time in the form the check reads. An UNCHECKED call
 *  may still be struck by the model review, but the model alone cannot bill it. */
export function checkConvertTime(args: Record<string, unknown>, result: ToolResult): { reason_code: string; evidence: string } | 'HOLD' | 'UNCHECKED' | null {
  const time = typeof args?.time === 'string' ? args.time : ''
  const date = typeof args?.date === 'string' ? args.date : ''
  const from = typeof args?.from === 'string' ? args.from : ''
  const to = typeof args?.to === 'string' ? args.to : ''

  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) || !validDate(date) || !from || !to) return 'HOLD'

  let expected: { date: string; time: string }[]
  try {
    expected = computeDestinations(date, time, from, to)
  } catch {
    return 'HOLD'
  }
  if (!expected.length) return 'HOLD'

  // Every "HH:MM on YYYY-MM-DD in Zone" in the answer. The first one usually repeats the request; the stated
  // destination is the last one that is not that echo.
  const text = textOf(result)
  const stated = [...text.matchAll(/\b(\d{2}:\d{2})\s+on\s+(\d{4}-\d{2}-\d{2})\s+in\s+([A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*)/g)]
  const echo = (m: RegExpMatchArray) => m[1] === time && m[2] === date && m[3] === from
  const candidates = stated.length > 1 ? stated.filter((m, i) => !(i === 0 && echo(m))) : stated.filter((m) => from === to || !echo(m))
  const match = candidates.at(-1)
  if (!match) return 'UNCHECKED'

  const [phrase, statedTime, statedDate, statedZone] = match

  if (statedZone !== to || !expected.some((e) => e.time === statedTime && e.date === statedDate)) {
    return { reason_code: 'WRONG', evidence: phrase }
  }

  if (result.structuredContent && typeof result.structuredContent === 'object') {
    const sc = result.structuredContent as Record<string, unknown>
    if (sc.time !== statedTime || sc.date !== statedDate || sc.zone !== to) {
      return { reason_code: 'WRONG', evidence: phrase }
    }
  }

  return null
}
