import type { ValueTrendPoint } from '../../components/charts'

const PROJECTION_MONTHS_AHEAD = 24

function parseYearMonth(date: string): [number, number] | null {
  const [year, month] = date.split('-').map(Number)
  return year && month ? [year, month] : null
}

const monthsBetween = (from: [number, number], to: [number, number]) => (to[0] - from[0]) * 12 + (to[1] - from[1])
const periodLabel = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`

export function valueTrendSeries(
  points: Array<{ value: number; date: string }>,
  projectedMonthlyRate: number,
  today = new Date(),
): ValueTrendPoint[] {
  const known = points
    .map((point) => ({ value: point.value, ym: parseYearMonth(point.date) }))
    .filter((point): point is { value: number; ym: [number, number] } => point.ym !== null)
    .toSorted((left, right) => monthsBetween(right.ym, left.ym))
  if (known.length === 0) return []

  const series: ValueTrendPoint[] = []
  const pushPoint = (year: number, month: number, value: number, projected: boolean, rate?: number) => {
    series.push({
      period: periodLabel(year, month),
      value: Math.max(0, Math.round(value * 100) / 100),
      projected,
      monthlyRatePercent: rate === undefined ? undefined : rate * 100,
    })
  }

  for (let index = 0; index < known.length - 1; index += 1) {
    const start = known[index]
    const end = known[index + 1]
    const span = monthsBetween(start.ym, end.ym)
    if (span <= 0) continue
    const impliedRate = (end.value / start.value) ** (1 / span) - 1
    for (let month = 0; month < span; month += 1) {
      const value = start.value * (1 + impliedRate) ** month
      const date = new Date(start.ym[0], start.ym[1] - 1 + month, 1)
      pushPoint(date.getFullYear(), date.getMonth() + 1, value, false, month === 0 ? undefined : impliedRate)
    }
  }

  const last = known[known.length - 1]
  const monthsSinceLast = Math.max(0, monthsBetween(last.ym, [today.getFullYear(), today.getMonth() + 1]))
  const totalMonths = monthsSinceLast + PROJECTION_MONTHS_AHEAD
  for (let month = 0; month <= totalMonths; month += 1) {
    const date = new Date(last.ym[0], last.ym[1] - 1 + month, 1)
    const value = last.value * (1 + projectedMonthlyRate) ** month
    pushPoint(date.getFullYear(), date.getMonth() + 1, value, month > monthsSinceLast, month === 0 ? undefined : projectedMonthlyRate)
  }
  return series
}
