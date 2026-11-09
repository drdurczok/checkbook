import { describe, expect, it } from 'vitest'
import type { ExpenseCategoryMonthlyPoint, ExpenseCategorySummary } from '../../contracts/expenses'
import { monthlyExpenseCategories } from './monthlySpend'

function category(id: string): ExpenseCategorySummary {
  return {
    id, name: id, is_system: false, is_retired: false, can_delete: true,
    is_source_linked: false, sort_order: 0, total_amount: 9999,
    monthly_average: 999, entry_count: 12,
  }
}

const point = (category_id: string | null, period: string, value: number): ExpenseCategoryMonthlyPoint => ({ category_id, period, value })

describe('monthlyExpenseCategories', () => {
  it('averages exactly the previous three completed calendar months across a year boundary', () => {
    const categories = [category('food'), category('empty')]
    const totals = [
      point('food', '2025-09', 9000),
      point('food', '2025-10', 30),
      point('food', '2025-12', 60),
      point('food', '2026-01', 900),
      point('food', '2026-02', 9000),
      point('other', '2025-11', 9000),
      point(null, '2025-11', 9000),
    ]
    const originalCategories = structuredClone(categories)
    const originalTotals = structuredClone(totals)

    const result = monthlyExpenseCategories(categories, totals, false, new Date(2026, 0, 1, 0, 0))

    expect(result).toEqual([
      { ...categories[0], monthly_average: 30 },
      { ...categories[1], monthly_average: 0 },
    ])
    expect(result).not.toBe(categories)
    for (const [index, value] of result.entries()) expect(value).not.toBe(categories[index])
    expect(categories).toEqual(originalCategories)
    expect(totals).toEqual(originalTotals)
  })

  it.each([new Date(2024, 2, 1), new Date(2024, 2, 31, 23, 59)])('uses calendar months rather than a rolling day window on %s', (today) => {
    const result = monthlyExpenseCategories([category('food')], [
      point('food', '2023-11', 9000),
      point('food', '2023-12', 30),
      point('food', '2024-01', 60),
      point('food', '2024-02', 90),
      point('food', '2024-03', 9000),
    ], false, today)

    expect(result[0].monthly_average).toBe(60)
  })

  it('accumulates duplicate points with decimal precision before dividing by three', () => {
    const result = monthlyExpenseCategories([category('food')], [
      point('food', '2026-07', 0.1),
      point('food', '2026-07', 0.2),
    ], false, new Date(2026, 9, 19))

    expect(result[0].monthly_average).toBe(0.1)
  })

  it('uses only the current calendar month without averaging or including future months', () => {
    const result = monthlyExpenseCategories([category('food'), category('empty')], [
      point('food', '2025-12', 999),
      point('food', '2026-01', 0.1),
      point('food', '2026-01', 0.2),
      point('food', '2026-02', 999),
    ], true, new Date(2026, 0, 31, 23, 59))

    expect(result.map((value) => value.monthly_average)).toEqual([0.3, 0])
  })

  it.each([false, true])('returns zero for absent totals and supports no categories (current month: %s)', (currentMonth) => {
    const today = new Date(2026, 9, 19)
    expect(monthlyExpenseCategories([category('empty')], [], currentMonth, today)[0].monthly_average).toBe(0)
    expect(monthlyExpenseCategories([], [point('unknown', '2026-09', 10)], currentMonth, today)).toEqual([])
  })
})
