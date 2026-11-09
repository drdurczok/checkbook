import { describe, expect, it, vi } from 'vitest'
import { resolveDateRange } from '../../lib/format'
import type { IncomeSource, IncomeSourceEntry } from '../../types'
import { calculateIncomeSummary, incomeDateInRange, incomeSourcesInDateRange, isActiveSource, monthsBetween, sortIncomeHistory, sourceAnnualValue, sourcePeriodEntries } from './model'

const now = new Date(2026, 5, 15, 12)

function entry(id: string, date: string, amount: number, payslip?: Record<string, unknown>): IncomeSourceEntry {
  return {
    id,
    description: id,
    amount,
    entry_date: date,
    owner_scope: 'joint',
    notes: '',
    extra_payload: payslip ? { payslip } : undefined,
  }
}

function source(overrides: Partial<IncomeSource> = {}): IncomeSource {
  return {
    id: 'source',
    name: 'Source',
    source_type: 'employment',
    owner_scope: 'joint',
    started_on: '2025-01-01',
    ended_on: null,
    notes: '',
    lines: [],
    fields: [],
    milestones: [],
    sort_order: 0,
    annual_total: 0,
    actual_total: 0,
    line_count: 0,
    entries: [],
    ...overrides,
  }
}

describe('income feature model', () => {
  it('filters entry view copies inclusively without hiding sources or changing annual run-rates', () => {
    const original = source({ entries: [
      entry('old', '2026-05-31', 100),
      entry('start', '2026-06-01', 200),
      entry('end', '2026-06-15', 300),
      entry('future', '2026-06-16', 400),
    ] })
    const empty = source({ id: 'configured', annual_total: 24000 })
    const views = incomeSourcesInDateRange([original, empty], { start_date: '2026-06-01', end_date: '2026-06-15' }, now)
    expect(views.map(({ id }) => id)).toEqual(['source', 'configured'])
    expect(views[0].entries?.map(({ id }) => id)).toEqual(['start', 'end'])
    expect(views[0].entries?.[0]).toBe(original.entries?.[1])
    expect(original.entries).toHaveLength(4)
    expect(original.annual_total).toBe(0)
    const summary = calculateIncomeSummary(views, now)
    expect(summary.activeAnnualTotal).toBe(calculateIncomeSummary([original, empty], now).activeAnnualTotal)
    expect(summary.history.lifetime).toBe(500)
    expect(summary.activeNetTakeHome).toBe(500)
    expect(incomeDateInRange(null, {})).toBe(false)
  })

  it('excludes future entries by default and includes them only within the forecast range', () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    try {
      const original = source({ entries: [
        entry('past', '2026-05-31', 100),
        entry('today', '2026-06-15', 200, { grossPay: 300, taxAdvance: 50 }),
        entry('future', '2026-06-30', 400, { grossPay: 600, taxAdvance: 100 }),
        entry('later', '2026-07-01', 800),
      ] })
      const actual = calculateIncomeSummary(incomeSourcesInDateRange([original], resolveDateRange('all'), now), now)
      const forecastSources = incomeSourcesInDateRange([original], resolveDateRange('month', true), now)
      const forecast = calculateIncomeSummary(forecastSources, now)
      expect(actual.history.lifetime).toBe(300)
      expect(actual.tax.withheld).toBe(50)
      expect(forecastSources[0].entries?.map(({ id }) => id)).toEqual(['today', 'future'])
      expect(forecast.history.lifetime).toBe(600)
      expect(forecast.tax.withheld).toBe(150)
      expect(incomeSourcesInDateRange([original], resolveDateRange('all', true), now)[0].entries).toHaveLength(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses inclusive calendar months with an explicit current date', () => {
    expect(monthsBetween('2026-01-31', null, now)).toBe(6)
    expect(monthsBetween('2025-07-01', '2026-06-30', now)).toBe(12)
    expect(monthsBetween('2025-08-01', '2026-06-30', now)).toBe(11)
    expect(monthsBetween('bad-date', null, now)).toBe(0)
    expect(monthsBetween('2027-01-01', null, now)).toBe(0)
  })

  it('includes source bounds and excludes entries outside them', () => {
    const bounded = source({
      started_on: '2026-02-01',
      ended_on: '2026-03-31',
      entries: [
        entry('before', '2026-01-31', 1),
        entry('start', '2026-02-01', 2),
        entry('end', '2026-03-31', 3),
        entry('after', '2026-04-01', 4),
      ],
    })
    expect(sourcePeriodEntries(bounded).map(({ id }) => id)).toEqual(['start', 'end'])
  })

  it('uses raw earnings for short ended work and annualizes active or long sparse work', () => {
    const shortEnded = source({
      started_on: '2026-01-01',
      ended_on: '2026-02-28',
      entries: [entry('jan', '2026-01-31', 1000), entry('feb', '2026-02-28', 1200)],
    })
    const active = source({
      started_on: '2026-05-01',
      entries: [entry('may', '2026-05-31', 1000), entry('jun', '2026-06-15', 1200)],
    })
    const longSparse = source({
      started_on: '2024-01-01',
      ended_on: '2025-12-31',
      entries: [entry('first', '2024-01-31', 1000), entry('last', '2025-12-31', 2000)],
    })
    expect(sourceAnnualValue(shortEnded, now)).toBe(2200)
    expect(sourceAnnualValue(active, now)).toBe(13200)
    expect(sourceAnnualValue(longSparse, now)).toBe(18000)
  })

  it('prefers a positive expected annual value and falls back to actuals otherwise', () => {
    const actual = source({ annual_total: 24000, entries: [entry('one', '2026-05-01', 1)] })
    expect(sourceAnnualValue(actual, now)).toBe(24000)
    expect(sourceAnnualValue({ ...actual, annual_total: -1 }, now)).toBe(12)
  })

  it('anchors active status and rolling actuals to the supplied date', () => {
    expect(isActiveSource(source({ ended_on: '2026-06-15' }), now)).toBe(true)
    expect(isActiveSource(source({ ended_on: '2026-06-14' }), now)).toBe(false)
    const active = source({
      entries: [
        entry('old', '2025-06-14', 100),
        entry('boundary', '2025-06-15', 200),
        entry('recent', '2026-06-15', 300),
      ],
    })
    expect(calculateIncomeSummary([active], now).activeNetTakeHome).toBe(500)
  })

  it('orders income history with active roles first, then closed roles latest-start-first', () => {
    const oldestActive = source({ id: 'oldest-active', started_on: '2015-01-01' })
    const newerActive = source({ id: 'newer-active', started_on: '2024-01-01' })
    const laterClosed = source({ id: 'later-closed', started_on: '2023-01-01', ended_on: '2024-12-31' })
    const earlierClosed = source({ id: 'earlier-closed', started_on: '2016-01-01', ended_on: '2020-12-31' })
    const ordered = sortIncomeHistory([laterClosed, oldestActive, earlierClosed, newerActive], now)
    expect(ordered.map(({ id }) => id)).toEqual(['newer-active', 'oldest-active', 'later-closed', 'earlier-closed'])

    // Closing the leading role drops it back among the closed group.
    const closedAtTop = sortIncomeHistory(
      [laterClosed, source({ id: 'newer-active', started_on: '2024-01-01', ended_on: '2026-06-01' })],
      now,
    )
    expect(closedAtTop.map(({ id }) => id)).toEqual(['newer-active', 'later-closed'])
  })

  it('calculates tax from active in-period payslips and nested numeric payloads', () => {
    const active = source({
      entries: [entry('pay', '2026-05-31', 700, {
        grossPay: '1000', socialInsurance: 50, healthInsurance: '20', ppkContribution: 10, taxAdvance: 40,
      })],
    })
    const inactive = source({ id: 'old', ended_on: '2025-01-01', entries: [entry('ignored', '2025-01-01', 999, { grossPay: 9999, taxAdvance: 999 })] })
    expect(calculateIncomeSummary([active, inactive], now).tax).toEqual({
      withheld: 120,
      due: 240,
      balance: 120,
      paidRatio: 50,
    })
  })

  it('falls back to estimated take-home and tax when there are no actual entries', () => {
    const summary = calculateIncomeSummary([source({ annual_total: 100000 })], now)
    expect(summary.activeAnnualTotal).toBe(100000)
    expect(summary.activeNetTakeHome).toBe(72000)
    expect(summary.tax).toEqual({ withheld: 0, due: 20000, balance: 20000, paidRatio: 0 })
  })

  it('calculates lifetime, tenure, and raises without comparing short ended work', () => {
    const first = source({ id: 'first', started_on: '2023-01-01', ended_on: '2023-12-31', annual_total: 100, entries: [entry('first-pay', '2023-01-01', 10)] })
    const short = source({ id: 'short', started_on: '2024-01-01', ended_on: '2024-02-01', annual_total: 1000, entries: [entry('short-pay', '2024-01-01', 20)] })
    const current = source({ id: 'current', started_on: '2025-01-01', annual_total: 121, entries: [entry('current-pay', '2026-01-01', 30)] })
    const history = calculateIncomeSummary([current, short, first], now).history
    expect(history).toEqual({ longest: 18, lifetime: 60, avgRaise: 0.21 })
  })

  it('returns zeroed aggregates for no sources', () => {
    const summary = calculateIncomeSummary([], now)
    expect(summary.activeSources).toEqual([])
    expect(summary.activeAnnualTotal).toBe(0)
    expect(summary.activeNetTakeHome).toBe(0)
    expect(summary.tax).toEqual({ withheld: 0, due: 0, balance: 0, paidRatio: 0 })
    expect(summary.history).toEqual({ longest: 0, lifetime: 0, avgRaise: 0 })
  })
})
