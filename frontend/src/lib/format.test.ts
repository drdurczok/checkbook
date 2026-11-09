import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  currencySymbol,
  formatAmountDraft,
  parseAmountDraft,
  resolveDateRange,
  rangeLabel,
} from './format'

describe('date ranges', () => {
  afterEach(() => vi.useRealTimers())

  const freezeToday = (year = 2026, month = 9, day = 15) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(year, month, day, 12))
  }

  it.each([
    ['month', '2026-10-01'],
    ['6m', '2026-05-01'],
    ['12m', '2025-11-01'],
    ['ytd', '2026-01-01'],
  ] as const)('caps %s at today by default', (range, start) => {
    freezeToday()
    expect(resolveDateRange(range)).toEqual({ start_date: start, end_date: '2026-10-15' })
  })

  it.each([
    ['month', '2026-10-01', '2026-10-31'],
    ['6m', '2026-05-01', '2027-04-30'],
    ['12m', '2025-11-01', '2027-10-31'],
    ['ytd', '2026-01-01', '2026-12-31'],
  ] as const)('extends %s without changing its historical start', (range, start, end) => {
    freezeToday()
    expect(resolveDateRange(range, true)).toEqual({ start_date: start, end_date: end, include_planned: true })
  })

  it('includes all history through today, and all future dates only with forecast', () => {
    freezeToday()
    expect(resolveDateRange('all')).toEqual({ end_date: '2026-10-15' })
    expect(resolveDateRange('all', true)).toEqual({ include_planned: true })
    expect(rangeLabel('all')).toContain('15')
    expect(rangeLabel('all', true)).toBe('All available records, including future dates')
  })

  it('handles leap-day and year boundaries in local calendar dates', () => {
    freezeToday(2024, 1, 29)
    expect(resolveDateRange('month')).toEqual({ start_date: '2024-02-01', end_date: '2024-02-29' })
    expect(resolveDateRange('month', true).end_date).toBe('2024-02-29')
    expect(resolveDateRange('12m', true).end_date).toBe('2025-02-28')
    freezeToday(2026, 11, 31)
    expect(resolveDateRange('ytd', true).end_date).toBe('2026-12-31')
    expect(resolveDateRange('6m', true).end_date).toBe('2027-06-30')
  })
})

describe('parseAmountDraft', () => {
  it('keeps plain digits and a single decimal point', () => {
    expect(parseAmountDraft('12')).toBe('12')
    expect(parseAmountDraft('12.5')).toBe('12.5')
    expect(parseAmountDraft('1.')).toBe('1.')
  })

  it('accepts comma decimals and pasted currency text', () => {
    expect(parseAmountDraft('12,5')).toBe('12.5')
    expect(parseAmountDraft('1 234,56 zł')).toBe('1234.56')
  })

  it('drops stray characters instead of losing digits', () => {
    expect(parseAmountDraft('12a5')).toBe('125')
    expect(parseAmountDraft('1.2.3')).toBe('1.23')
  })

  it('normalizes leading separators and collapses empty drafts', () => {
    expect(parseAmountDraft('.5')).toBe('0.5')
    expect(parseAmountDraft('.')).toBe('')
    expect(parseAmountDraft('')).toBe('')
    expect(parseAmountDraft('   ')).toBe('')
  })
})

describe('formatAmountDraft', () => {
  it('returns an empty string for empty drafts', () => {
    expect(formatAmountDraft('')).toBe('')
    expect(formatAmountDraft('  ')).toBe('')
  })

  it('groups thousands without touching the typed decimals', () => {
    expect(formatAmountDraft('1234567.89')).toBe('1\u2009234\u2009567.89')
    expect(formatAmountDraft('1234567.89')).not.toMatch(/\d{4}/)
  })

  it('preserves an in-progress decimal separator', () => {
    expect(formatAmountDraft('12.')).toBe('12.')
  })

  it('round-trips through parseAmountDraft', () => {
    const raw = '9876543.21'
    expect(parseAmountDraft(formatAmountDraft(raw))).toBe(raw)
  })
})

describe('currencySymbol', () => {
  it('resolves a display symbol or code for the household currency', () => {
    expect(currencySymbol('PLN').length).toBeGreaterThan(0)
    expect(currencySymbol('USD').length).toBeGreaterThan(0)
    expect(currencySymbol(null).length).toBeGreaterThan(0)
  })

  it('normalizes the EURO alias before formatting', () => {
    expect(currencySymbol('EURO')).toBe(currencySymbol('EUR'))
  })
})
