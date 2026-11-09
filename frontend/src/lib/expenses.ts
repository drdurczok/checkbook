import Decimal from 'decimal.js'
import type { BreakdownPoint, ExpenseGroup, ExpensesBoard, MonthlyBreakdownPoint } from '../types'

export const UNGROUPED_EXPENSE_LABEL = 'Uncategorized'

/** Expenses include read-only loan schedules; Overview retains actual-only cash flow. */
export function expenseBoardMix(board: ExpensesBoard, showRetired = false) {
  const categories = new Map(board.categories.map((category) => [category.id, category]))
  const groups = new Map(board.groups.map((group) => [group.id, group]))
  const byMonth = new Map<string, Record<string, Decimal>>()
  const totals = new Map<string, Decimal>()
  for (const point of board.monthly_totals) {
    const category = point.category_id ? categories.get(point.category_id) : undefined
    const group = category?.expense_group_id ? groups.get(category.expense_group_id) : undefined
    if (!showRetired && (category?.is_retired || group?.is_retired)) continue
    const label = group?.name ?? UNGROUPED_EXPENSE_LABEL
    const values = byMonth.get(point.period) ?? {}
    values[label] = (values[label] ?? new Decimal(0)).plus(point.value)
    byMonth.set(point.period, values)
    totals.set(label, (totals.get(label) ?? new Decimal(0)).plus(point.value))
  }
  const grandTotal = [...totals.values()].reduce((sum, value) => sum.plus(value), new Decimal(0))
  return {
    breakdown: [...totals].map(([label, value]) => ({
      label, value: value.toNumber(), share: grandTotal.gt(0) ? value.div(grandTotal).toNumber() : 0,
    })).sort((left, right) => right.value - left.value),
    trend: [...byMonth].sort(([left], [right]) => left.localeCompare(right))
      .map(([period, values]) => ({
        period, values: Object.fromEntries(Object.entries(values).map(([label, value]) => [label, value.toNumber()])),
      })),
  }
}

/** The dashboard's `expense_breakdown`/`expense_trend_by_category` already
 * roll each category up under its group's name, but uncategorized groups
 * fall back to their own name — mixing individual expense groups in
 * among real category totals. Re-bucket anything that isn't an actual
 * category name into one "Uncategorized" series, so a chart driven by this
 * only ever shows category-level totals for Overview's actual cash flow.
 * (UI naming: the top level
 * is called a "category", its children "groups".) */
export function groupedExpenseMix(
  breakdown: BreakdownPoint[],
  trend: MonthlyBreakdownPoint[],
  groups: ExpenseGroup[],
): { breakdown: BreakdownPoint[]; trend: MonthlyBreakdownPoint[] } {
  const groupNames = new Set(groups.map((group) => group.name))
  const mergeLabel = (label: string) => (groupNames.has(label) ? label : UNGROUPED_EXPENSE_LABEL)

  const totalsByLabel = new Map<string, number>()
  for (const point of breakdown) {
    const label = mergeLabel(point.label)
    totalsByLabel.set(label, (totalsByLabel.get(label) ?? 0) + point.value)
  }
  const grandTotal = [...totalsByLabel.values()].reduce((sum, value) => sum + value, 0)
  const mergedBreakdown: BreakdownPoint[] = [...totalsByLabel.entries()]
    .map(([label, value]) => ({ label, value, share: grandTotal > 0 ? value / grandTotal : 0 }))
    .sort((left, right) => right.value - left.value)

  const mergedTrend: MonthlyBreakdownPoint[] = trend.map((point) => {
    const values: Record<string, number> = {}
    for (const [label, value] of Object.entries(point.values)) {
      const merged = mergeLabel(label)
      values[merged] = (values[merged] ?? 0) + value
    }
    return { period: point.period, values }
  })

  return { breakdown: mergedBreakdown, trend: mergedTrend }
}
