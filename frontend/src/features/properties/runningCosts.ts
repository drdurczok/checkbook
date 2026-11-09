import Decimal from 'decimal.js'
import type { UtilityBoardMonth } from '../../contracts/utilities'
import { addMonths, isoDate } from '../../lib/format'

export interface RunningCostsSummary {
  windowStart: string
  windowEnd: string
  observedMonths: string[]
  includedMonths: string[]
  excludedMonths: string[]
  average: Decimal | null
}

function median(values: Decimal[]): Decimal {
  const sorted = [...values].sort((left, right) => left.comparedTo(right))
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? sorted[middle - 1].plus(sorted[middle]).dividedBy(2)
    : sorted[middle]
}

/** Only recorded utility amounts count; board totals also contain empty-month zeros. */
export function calculateRunningCosts(
  months: readonly UtilityBoardMonth[],
  today: string,
): RunningCostsSummary {
  const [year, month] = today.split('-').map(Number)
  const currentMonth = new Date(year, month - 1, 1)
  const windowStart = isoDate(addMonths(currentMonth, -6))
  const windowEnd = isoDate(new Date(year, month - 1, 0))
  const observations = months.flatMap((entry) => {
    const monthKey = entry.month.slice(0, 7)
    if (monthKey < windowStart.slice(0, 7) || monthKey > windowEnd.slice(0, 7)) return []
    const amounts = Object.values(entry.values).flatMap(({ amount }) =>
      amount === null || amount === undefined || !Number.isFinite(amount)
        ? []
        : [new Decimal(amount)],
    )
    if (amounts.length === 0) return []
    return [{ month: monthKey, total: amounts.reduce((sum, amount) => sum.plus(amount), new Decimal(0)) }]
  }).sort((left, right) => left.month.localeCompare(right.month))

  const excludedMonths: string[] = []
  let included = observations
  if (observations.length >= 4) {
    const midpoint = median(observations.map(({ total }) => total))
    const mad = median(observations.map(({ total }) => total.minus(midpoint).abs()))
    const threshold = Decimal.max(mad.times(3), midpoint.abs().times('0.5'))
    included = observations.filter(({ month, total }) => {
      if (total.minus(midpoint).abs().greaterThan(threshold)) {
        excludedMonths.push(month)
        return false
      }
      return true
    })
  }

  return {
    windowStart,
    windowEnd,
    observedMonths: observations.map(({ month }) => month),
    includedMonths: included.map(({ month }) => month),
    excludedMonths,
    average: included.length === 0
      ? null
      : included.reduce((sum, { total }) => sum.plus(total), new Decimal(0)).dividedBy(included.length),
  }
}
