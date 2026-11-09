import { expect, it } from 'vitest'
import type { NetWorthComponentRow } from '../../contracts/dashboard'
import { draftNetWorthMonth, emptyNetWorthMonth, fmtGrowthDelta, growthDeltaTone, nextNetWorthMonth } from './model'

it('starts an empty history with the current local month', () => {
  expect(nextNetWorthMonth([], new Date(2026, 9, 29))).toBe('2026-10')
})

it('uses household time at a month boundary', () => {
  expect(nextNetWorthMonth([], new Date('2026-10-31T23:30:00Z'), 'Europe/Warsaw')).toBe('2026-11')
})

it('adds after the latest month regardless of input order, including year rollover', () => {
  expect(nextNetWorthMonth(['2026-12', '2026-02'])).toBe('2027-01')
  expect(nextNetWorthMonth(['2026-02', '2026-01'])).toBe('2026-03')
})

it('creates an editable empty draft without carrying automatic or manual values forward', () => {
  const row = emptyNetWorthMonth('2027-01')
  expect(row.period).toBe('2027-01')
  expect(row.completed).toBe(false)
  expect(row.total).toBe(0)
  expect(row.investing.components).toEqual({})
  expect(row.debt.components).toEqual({})
})

const previousMonth: NetWorthComponentRow = {
  period: '2026-10', completed: true, total: 723,
  investing: { total: 0, components: {} },
  savings: { total: 123, components: { 'Emergency fund': 123 } },
  non_liquid_assets: { total: 1000, components: { Bike: 50 }, automatic_components: { Home: 950 } },
  debt: { total: 400, components: {}, automatic_components: { Mortgage: 400 } },
}

it('inherits the closest earlier month\'s subgroups and pulls debt and fixed-asset automatics', () => {
  const row = draftNetWorthMonth('2026-12', [previousMonth, { ...previousMonth, period: '2027-01' }])
  expect(row.period).toBe('2026-12')
  expect(row.completed).toBe(false)
  expect(row.savings.components).toEqual({ 'Emergency fund': 123 })
  expect(row.non_liquid_assets.components).toEqual({ Bike: 50 })
  expect(row.non_liquid_assets.automatic_components).toEqual({ Home: 950 })
  expect(row.debt.automatic_components).toEqual({ Mortgage: 400 })
  expect(row.investing.automatic_components).toBeUndefined()
  expect(row.total).toBe(0 + 123 + 1000 - 400)
})

it('falls back to an empty draft when no earlier month exists', () => {
  expect(draftNetWorthMonth('2026-10', [previousMonth])).toEqual(emptyNetWorthMonth('2026-10'))
  expect(draftNetWorthMonth('2026-10', [])).toEqual(emptyNetWorthMonth('2026-10'))
})

it('formats growth as a signed delta from the unchanged 100 baseline', () => {
  expect(fmtGrowthDelta(101)).toBe('\u2007+1.00%')
  expect(fmtGrowthDelta(99)).toBe('\u2007-1.00%')
  expect(fmtGrowthDelta(100)).toBe('\u2007+0.00%')
  expect(fmtGrowthDelta(101.234)).toBe('\u2007+1.23%')
  expect(fmtGrowthDelta(111.54)).toBe('+11.54%')
  expect(fmtGrowthDelta(88.46)).toBe('-11.54%')
})

it('tones growth by the sign of its delta from 100', () => {
  expect(growthDeltaTone(101)).toBe('is-positive')
  expect(growthDeltaTone(100)).toBe('is-positive')
  expect(growthDeltaTone(99.99)).toBe('is-negative')
})
