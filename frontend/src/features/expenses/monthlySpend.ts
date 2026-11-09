import Decimal from 'decimal.js'
import type { ExpenseCategoryMonthlyPoint, ExpenseCategorySummary } from '../../types'

export function monthlyExpenseCategories(
  categories: ExpenseCategorySummary[],
  monthlyTotals: ExpenseCategoryMonthlyPoint[],
  currentMonth: boolean,
  today: Date,
): ExpenseCategorySummary[] {
  const month = new Date(today.getFullYear(), today.getMonth(), 1).toLocaleDateString('sv-SE').slice(0, 7)
  const firstMonth = new Date(today.getFullYear(), today.getMonth() - 3, 1).toLocaleDateString('sv-SE').slice(0, 7)
  const totals = new Map<string, Decimal>()
  for (const point of monthlyTotals) {
    const period = point.period.slice(0, 7)
    if (!point.category_id || (currentMonth ? period !== month : period < firstMonth || period >= month)) continue
    totals.set(point.category_id, (totals.get(point.category_id) ?? new Decimal(0)).plus(point.value))
  }
  return categories.map((category) => ({
    ...category,
    monthly_average: (totals.get(category.id) ?? new Decimal(0)).div(currentMonth ? 1 : 3).toNumber(),
  })).sort((left, right) => new Decimal(right.monthly_average).comparedTo(left.monthly_average) || left.name.localeCompare(right.name))
}
