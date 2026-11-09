import { describe, expect, it } from 'vitest'
import type { UtilityBoardMonth } from '../../contracts/utilities'
import { calculateRunningCosts } from './runningCosts'

const record = (month: string, amount?: number | null): UtilityBoardMonth => ({
  month,
  values: { electricity: { amount } },
  total: amount ?? 0,
})

const series = (amounts: number[]) => amounts.map((amount, index) =>
  record(`2025-${String(index + 1).padStart(2, '0')}-01`, amount),
)

describe('calculateRunningCosts', () => {
  it('uses six completed calendar months across year boundaries', () => {
    const result = calculateRunningCosts([
      record('2024-06-01', 900),
      record('2024-07-01', 10),
      record('2024-12-01', 30),
      record('2025-01-01', 900),
      record('2025-02-01', 900),
    ], '2025-01-31')
    expect(result.windowStart).toBe('2024-07-01')
    expect(result.windowEnd).toBe('2024-12-31')
    expect(result.observedMonths).toEqual(['2024-07', '2024-12'])
    expect(result.average?.toString()).toBe('20')
  })

  it('keeps the same completed window on the first and last days of a month', () => {
    const records = [record('2024-02-01', 10), record('2024-03-01', 50)]
    const first = calculateRunningCosts(records, '2024-03-01')
    const last = calculateRunningCosts(records, '2024-03-31')
    expect(first.windowStart).toBe('2023-09-01')
    expect(first.windowEnd).toBe('2024-02-29')
    expect(last).toEqual(first)
    expect(first.average?.toString()).toBe('10')
    expect(calculateRunningCosts([], '2025-03-01').windowEnd).toBe('2025-02-28')
  })

  it('ignores missing amounts and board totals but preserves explicit zero', () => {
    const result = calculateRunningCosts([
      record('2025-01-01', null),
      record('2025-02-01'),
      { month: '2025-03-01', values: { water: { meter_reading: 12, usage_amount: 3 } }, total: 900 },
      record('2025-04-01', 0),
      record('2025-06-01', 20),
    ], '2025-07-15')
    expect(result.observedMonths).toEqual(['2025-04', '2025-06'])
    expect(result.average?.toString()).toBe('10')
  })

  it('sums and averages decimal amounts without binary floating-point arithmetic', () => {
    const result = calculateRunningCosts([
      { month: '2025-01-01', values: { water: { amount: 0.1 }, power: { amount: 0.2 } }, total: 99 },
      record('2025-02-01', 0.1),
    ], '2025-07-01')
    expect(result.average?.toString()).toBe('0.2')
  })

  it('returns no estimate without recorded amounts, not a misleading zero', () => {
    expect(calculateRunningCosts([], '2025-07-01').average).toBeNull()
    expect(calculateRunningCosts([record('2025-01-01')], '2025-07-01').average).toBeNull()
    expect(calculateRunningCosts(series([0, 0, 0, 0]), '2025-07-01').average?.toString()).toBe('0')
  })

  it('does not filter sparse observations even when one is a spike', () => {
    const result = calculateRunningCosts(series([100, 100, 1000]), '2025-07-01')
    expect(result.excludedMonths).toEqual([])
    expect(result.average?.toString()).toBe('400')
  })

  it('filters spikes starting at four observations even when MAD is zero', () => {
    const result = calculateRunningCosts(series([100, 100, 100, 1000]), '2025-07-01')
    expect(result.excludedMonths).toEqual(['2025-04'])
    expect(result.includedMonths).toEqual(['2025-01', '2025-02', '2025-03'])
    expect(result.average?.toString()).toBe('100')
  })

  it('keeps amounts exactly on the threshold but excludes amounts beyond it', () => {
    const boundary = calculateRunningCosts(series([100, 100, 100, 150]), '2025-07-01')
    expect(boundary.excludedMonths).toEqual([])
    expect(boundary.average?.toString()).toBe('112.5')
    expect(calculateRunningCosts(series([100, 100, 100, 150.01]), '2025-07-01').excludedMonths).toEqual(['2025-04'])
  })

  it('uses three times MAD when it exceeds half the median', () => {
    const result = calculateRunningCosts(series([50, 75, 100, 125, 200]), '2025-07-01')
    expect(result.excludedMonths).toEqual(['2025-05'])
    expect(result.average?.toString()).toBe('87.5')
    const onThreshold = calculateRunningCosts(series([50, 75, 100, 125, 175]), '2025-07-01')
    expect(onThreshold.excludedMonths).toEqual([])
  })

  it('uses the absolute median for negative adjustments and excludes low outliers', () => {
    expect(calculateRunningCosts(series([-100, -100, -100, -151]), '2025-07-01').excludedMonths).toEqual(['2025-04'])
    expect(calculateRunningCosts(series([100, 100, 100, 0]), '2025-07-01').excludedMonths).toEqual(['2025-04'])
  })

  it('retains observed zero months when the median is zero', () => {
    const result = calculateRunningCosts(series([0, 0, 0, 10]), '2025-07-01')
    expect(result.observedMonths).toHaveLength(4)
    expect(result.includedMonths).toHaveLength(3)
    expect(result.average?.toString()).toBe('0')
  })
})
