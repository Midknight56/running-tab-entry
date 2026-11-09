import { describe, expect, it } from 'vitest'
import type { ToolResult } from 'mcp-on-workers'
import { checkConvertTime } from '../src/demo/calendar-checks'
import { convertTime } from '../src/demo/seller'

function res(txt: string, sc?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text' as const, text: txt }],
    ...(sc ? { structuredContent: sc } : {}),
  }
}

describe('calendar checks', () => {
  it('ordinary: 08:00 on 2026-05-01 America/Halifax to Europe/London is 12:00 on 2026-05-01', () => {
    const args = { time: '08:00', date: '2026-05-01', from: 'America/Halifax', to: 'Europe/London' }
    const result = res(
      '08:00 on 2026-05-01 in America/Halifax is 12:00 on 2026-05-01 in Europe/London.',
      { time: '12:00', date: '2026-05-01', zone: 'Europe/London' },
    )
    expect(checkConvertTime(args, result)).toBeNull()
  })

  it('midnight rollover: 22:30 on 2026-03-10 America/New_York to Asia/Tokyo is 11:30 on 2026-03-11', () => {
    const args = { time: '22:30', date: '2026-03-10', from: 'America/New_York', to: 'Asia/Tokyo' }
    const result = res(
      '22:30 on 2026-03-10 in America/New_York is 11:30 on 2026-03-11 in Asia/Tokyo.',
      { time: '11:30', date: '2026-03-11', zone: 'Asia/Tokyo' },
    )
    expect(checkConvertTime(args, result)).toBeNull()
  })

  it('midnight rollover: stated 12:30 on 2026-03-11 for 22:30 America/New_York is struck as WRONG when DST applies', () => {
    const args = { time: '22:30', date: '2026-03-10', from: 'America/New_York', to: 'Asia/Tokyo' }
    const result = res(
      '22:30 on 2026-03-10 in America/New_York is 12:30 on 2026-03-11 in Asia/Tokyo.',
      { time: '12:30', date: '2026-03-11', zone: 'Asia/Tokyo' },
    )
    expect(checkConvertTime(args, result)).toEqual({
      reason_code: 'WRONG',
      evidence: '12:30 on 2026-03-11 in Asia/Tokyo',
    })
  })

  it('midnight rollover in standard time: 22:30 on 2026-03-01 America/New_York to Asia/Tokyo is 12:30 on 2026-03-02', () => {
    const args = { time: '22:30', date: '2026-03-01', from: 'America/New_York', to: 'Asia/Tokyo' }
    const result = res(
      '22:30 on 2026-03-01 in America/New_York is 12:30 on 2026-03-02 in Asia/Tokyo.',
      { time: '12:30', date: '2026-03-02', zone: 'Asia/Tokyo' },
    )
    expect(checkConvertTime(args, result)).toBeNull()
  })

  it('daylight saving boundary: 01:30 on 2026-03-08 America/New_York to UTC is 06:30 on 2026-03-08', () => {
    const args = { time: '01:30', date: '2026-03-08', from: 'America/New_York', to: 'UTC' }
    const result = res(
      '01:30 on 2026-03-08 in America/New_York is 06:30 on 2026-03-08 in UTC.',
      { time: '06:30', date: '2026-03-08', zone: 'UTC' },
    )
    expect(checkConvertTime(args, result)).toBeNull()
  })

  it('daylight saving boundary: 03:30 on 2026-03-08 America/New_York to UTC is 07:30 on 2026-03-08', () => {
    const args = { time: '03:30', date: '2026-03-08', from: 'America/New_York', to: 'UTC' }
    const result = res(
      '03:30 on 2026-03-08 in America/New_York is 07:30 on 2026-03-08 in UTC.',
      { time: '07:30', date: '2026-03-08', zone: 'UTC' },
    )
    expect(checkConvertTime(args, result)).toBeNull()
  })

  it('daylight saving boundary: 2026-11-01 01:30 Europe/London to UTC is 01:30 on 2026-11-01', () => {
    const args = { time: '01:30', date: '2026-11-01', from: 'Europe/London', to: 'UTC' }
    const result = res(
      '01:30 on 2026-11-01 in Europe/London is 01:30 on 2026-11-01 in UTC.',
      { time: '01:30', date: '2026-11-01', zone: 'UTC' },
    )
    expect(checkConvertTime(args, result)).toBeNull()
  })

  it('a wall time that does not exist (02:30 on 2026-03-08 in New York, clocks jump 02:00 to 03:00) gives HOLD', () => {
    const args = { time: '02:30', date: '2026-03-08', from: 'America/New_York', to: 'UTC' }
    expect(checkConvertTime(args, res('02:30 on 2026-03-08 in America/New_York is 07:30 on 2026-03-08 in UTC.'))).toBe('HOLD')
  })

  it('a wall time that happens twice (01:30 on 2026-11-01 in New York) accepts 05:30 UTC and 06:30 UTC, and strikes 04:30', () => {
    const args = { time: '01:30', date: '2026-11-01', from: 'America/New_York', to: 'UTC' }
    expect(checkConvertTime(args, res('01:30 on 2026-11-01 in America/New_York is 05:30 on 2026-11-01 in UTC.'))).toBeNull()
    expect(checkConvertTime(args, res('01:30 on 2026-11-01 in America/New_York is 06:30 on 2026-11-01 in UTC.'))).toBeNull()
    expect(checkConvertTime(args, res('01:30 on 2026-11-01 in America/New_York is 04:30 on 2026-11-01 in UTC.'))).toEqual({
      reason_code: 'WRONG', evidence: '04:30 on 2026-11-01 in UTC',
    })
  })

  it('invalid zone gives HOLD', () => {
    const badFrom = { time: '08:00', date: '2026-05-01', from: 'Bad/Zone', to: 'Europe/London' }
    const badTo = { time: '08:00', date: '2026-05-01', from: 'America/Halifax', to: 'Bad/Zone' }
    const response = res('08:00 on 2026-05-01 in America/Halifax is 12:00 on 2026-05-01 in Europe/London.')
    expect(checkConvertTime(badFrom, response)).toBe('HOLD')
    expect(checkConvertTime(badTo, response)).toBe('HOLD')
  })

  it('seller wrong fault answer gives WRONG with exact phrase as evidence', async () => {
    const args = { time: '09:00', date: '2026-10-23', from: 'America/Halifax', to: 'Europe/London' }
    const result = await convertTime.run(args, { fault: 'wrong' })
    expect(result.content[0].text).toContain('16:00 on 2026-10-23 in Europe/London')
    const verdict = checkConvertTime(args, result)
    expect(verdict).toEqual({
      reason_code: 'WRONG',
      evidence: '16:00 on 2026-10-23 in Europe/London',
    })
  })

  it('correct answer gives null', async () => {
    const args = { time: '09:00', date: '2026-10-23', from: 'America/Halifax', to: 'Europe/London' }
    const result = await convertTime.run(args, {})
    expect(checkConvertTime(args, result)).toBeNull()
  })

  it('text and structuredContent that disagree give WRONG', () => {
    const args = { time: '09:00', date: '2026-10-23', from: 'America/Halifax', to: 'Europe/London' }
    const text = '09:00 on 2026-10-23 in America/Halifax is 13:00 on 2026-10-23 in Europe/London.'
    const badTime = res(text, { time: '14:00', date: '2026-10-23', zone: 'Europe/London' })
    const badDate = res(text, { time: '13:00', date: '2026-10-24', zone: 'Europe/London' })
    const badZone = res(text, { time: '13:00', date: '2026-10-23', zone: 'UTC' })

    expect(checkConvertTime(args, badTime)).toEqual({ reason_code: 'WRONG', evidence: '13:00 on 2026-10-23 in Europe/London' })
    expect(checkConvertTime(args, badDate)).toEqual({ reason_code: 'WRONG', evidence: '13:00 on 2026-10-23 in Europe/London' })
    expect(checkConvertTime(args, badZone)).toEqual({ reason_code: 'WRONG', evidence: '13:00 on 2026-10-23 in Europe/London' })
  })

  it('answer states no destination time at all gives UNCHECKED: the model may strike it but cannot approve it', () => {
    const args = { time: '09:00', date: '2026-10-23', from: 'America/Halifax', to: 'Europe/London' }
    const offTopic = res('London has mild weather this week, with light rain on Thursday.')
    const vague = res('It depends on daylight saving, likely around the afternoon.')
    expect(checkConvertTime(args, offTopic)).toBe('UNCHECKED')
    expect(checkConvertTime(args, vague)).toBe('UNCHECKED')
  })

  it('a wrong destination zone gives WRONG, even when the clock time is right for that zone', () => {
    const args = { time: '09:00', date: '2026-10-23', from: 'America/Halifax', to: 'Europe/London' }
    const paris = res('09:00 on 2026-10-23 in America/Halifax is 14:00 on 2026-10-23 in Europe/Paris.')
    const londonTimeParisZone = res('09:00 on 2026-10-23 in America/Halifax is 13:00 on 2026-10-23 in Europe/Paris.')
    expect(checkConvertTime(args, paris)).toEqual({ reason_code: 'WRONG', evidence: '14:00 on 2026-10-23 in Europe/Paris' })
    expect(checkConvertTime(args, londonTimeParisZone)).toEqual({ reason_code: 'WRONG', evidence: '13:00 on 2026-10-23 in Europe/Paris' })
  })

  it('a time stated in a sentence form the check cannot read gives UNCHECKED, right or wrong', () => {
    const args = { time: '09:00', date: '2026-10-23', from: 'America/Halifax', to: 'Europe/London' }
    expect(checkConvertTime(args, res('In London it will be 16:00 that day.'))).toBe('UNCHECKED')
    expect(checkConvertTime(args, res('In London it will be 13:00 that day.'))).toBe('UNCHECKED')
  })

  it('a conversion inside one zone is read from the last stated time', () => {
    const args = { time: '09:00', date: '2026-10-23', from: 'Europe/London', to: 'Europe/London' }
    expect(checkConvertTime(args, res('09:00 on 2026-10-23 in Europe/London is 09:00 on 2026-10-23 in Europe/London.'))).toBeNull()
    expect(checkConvertTime(args, res('09:00 on 2026-10-23 in Europe/London is 10:00 on 2026-10-23 in Europe/London.'))).toEqual({
      reason_code: 'WRONG', evidence: '10:00 on 2026-10-23 in Europe/London',
    })
  })
})
