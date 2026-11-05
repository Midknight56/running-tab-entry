import { describe, it, expect } from 'vitest'
import { validate } from 'mcp-on-workers'
import { businessDays, convertTime, CONVERT_TIME_SHAPE, SLOW_MS, type SellerCtx } from '../src/demo/seller'

describe('seller demo tools', () => {
  it('counts weekdays in a half-open range and validates the structured result', async () => {
    const result = await businessDays.run({ start: '2026-10-20', end: '2026-10-27' }, {})
    expect(result.structuredContent).toEqual({ business_days: 5, start: '2026-10-20', end: '2026-10-27' })
    expect(validate(businessDays.outputSchema!, result.structuredContent)).toEqual([])
  })

  it('returns zero for a weekend-only range', async () => {
    const result = await businessDays.run({ start: '2026-10-24', end: '2026-10-26' }, {})
    expect(result.structuredContent).toEqual({ business_days: 0, start: '2026-10-24', end: '2026-10-26' })
    expect(validate(businessDays.outputSchema!, result.structuredContent)).toEqual([])
  })

  it('rejects an end date before the start date', async () => {
    const result = await businessDays.run({ start: '2026-10-27', end: '2026-10-20' }, {})
    expect(result.isError).toBe(true)
  })

  it('converts Halifax time to London time', async () => {
    const result = await convertTime.run({ time: '09:00', date: '2026-10-23', from: 'America/Halifax', to: 'Europe/London' }, {})
    expect(result.structuredContent).toEqual({ time: '13:00', date: '2026-10-23', zone: 'Europe/London' })
    expect(validate(CONVERT_TIME_SHAPE as any, result.structuredContent)).toEqual([])
  })

  it('converts across the date line', async () => {
    const result = await convertTime.run({ time: '23:30', date: '2026-10-23', from: 'America/Los_Angeles', to: 'Asia/Tokyo' }, {})
    expect(result.structuredContent).toEqual({ time: '15:30', date: '2026-10-24', zone: 'Asia/Tokyo' })
    expect(validate(CONVERT_TIME_SHAPE as any, result.structuredContent)).toEqual([])
  })

  it('reports unknown time zones as errors', async () => {
    const result = await convertTime.run({ time: '09:00', date: '2026-10-23', from: 'Bad/Zone', to: 'Europe/London' }, {})
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('Unknown time zone: Bad/Zone')
  })

  it('returns each labelled fault shape from both tools', async () => {
    const cases: [SellerCtx, (result: Awaited<ReturnType<typeof businessDays.run>>) => void][] = [
      [{ fault: 'empty' }, (result) => { expect(result).toEqual({ content: [{ type: 'text', text: '' }] }) }],
      [{ fault: 'error' }, (result) => { expect(result).toEqual({ content: [{ type: 'text', text: 'Upstream timed out.' }], isError: true }) }],
      [{ fault: 'off' }, (result) => { expect(result.content[0].text).toBe('Most offices close early on Fridays in summer.'); expect(result.structuredContent).toBeUndefined() }],
    ]
    for (const [ctx, check] of cases) {
      check(await businessDays.run({ start: '2026-10-20', end: '2026-10-27' }, ctx))
      const converted = await convertTime.run({ time: '09:00', date: '2026-10-23', from: 'America/Halifax', to: 'Europe/London' }, ctx)
      if (ctx.fault === 'empty') expect(converted).toEqual({ content: [{ type: 'text', text: '' }] })
      if (ctx.fault === 'error') expect(converted).toEqual({ content: [{ type: 'text', text: 'Upstream timed out.' }], isError: true })
      if (ctx.fault === 'off') { expect(converted.content[0].text).toBe('London has mild weather this week, with light rain on Thursday.'); expect(converted.structuredContent).toBeUndefined() }
    }
  })

  it('waits for an injected slow delay and then answers normally', async () => {
    const calls: number[] = []
    const sleep = async (ms: number) => { calls.push(ms) }
    const result = await businessDays.run({ start: '2026-10-20', end: '2026-10-27' }, { fault: 'slow', sleep })
    expect(calls).toEqual([SLOW_MS])
    expect(result.structuredContent).toEqual({ business_days: 5, start: '2026-10-20', end: '2026-10-27' })
    expect(validate(businessDays.outputSchema!, result.structuredContent)).toEqual([])
  })
})
