/* eslint-disable react-refresh/only-export-components */
export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

// Tooltips are centered on their anchor point (`translate(-50%, ...)`), so a
// point near either edge pushes half the tooltip outside the chart's plot
// area. Ancestor modals clip overflow, which silently hides it. Clamping the
// left percentage by the tooltip's own (approximate) half-width keeps it
// fully within the chart regardless of container size.
export function tooltipLeftPercent(x: number, width: number, tooltipWidthPx = 168) {
  const halfPercent = (tooltipWidthPx / 2 / width) * 100
  return clamp((x / width) * 100, halfPercent, 100 - halfPercent)
}

// Bi-monthly utilities (billed every other month) alternate between a full
// charge and zero in the monthly trend, which reads as sawtooth spikes. When
// a series' non-zero months line up with a stride of two (every other month
// billed, the rest zero), spread each charge evenly across the month it was
// billed in and the preceding skipped month so the line reflects a steady
// average cost instead of the billing cadence.
export function isBimonthlyPattern(values: number[]) {
  const nonZeroIndices = values.reduce<number[]>((acc, value, index) => {
    if (value !== 0) acc.push(index)
    return acc
  }, [])
  if (nonZeroIndices.length < 3) {
    return false
  }
  const gaps = nonZeroIndices.slice(1).map((index, position) => index - nonZeroIndices[position])
  return gaps.every((gap) => gap === 2)
}

export function smoothBimonthlySeries(values: number[]) {
  if (!isBimonthlyPattern(values)) {
    return values
  }
  return values.map((value, index) => {
    if (value !== 0) {
      const previous = values[index - 1]
      return previous === undefined || previous !== 0 ? value : value / 2
    }
    const next = values[index + 1]
    return next !== undefined && next !== 0 ? next / 2 : 0
  })
}

export function formatCurrency(value: number, currency: string, compact = false) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: compact ? 1 : 0,
    notation: compact ? 'compact' : 'standard',
  }).format(value)
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
  }).format(value)
}

export function numericValue(value: unknown) {
  const next = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(next) ? next : 0
}

export function evenlySpacedIndices(length: number, targetCount: number) {
  if (length <= 0) {
    return new Set<number>()
  }
  if (length <= targetCount) {
    return new Set(Array.from({ length }, (_, index) => index))
  }
  const step = (length - 1) / (targetCount - 1)
  const indices = Array.from({ length: targetCount }, (_, index) => Math.round(index * step))
  return new Set(indices)
}

export function buildTicks(min: number, max: number, count = 5) {
  if (min === max) {
    const padding = Math.max(Math.abs(min) * 0.1, 1)
    min -= padding
    max += padding
  }
  const step = (max - min) / (count - 1)
  return Array.from({ length: count }, (_, index) => min + step * index)
}

export function monthDateFromPeriod(period: string) {
  const [year, month] = period.split('-').map(Number)
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    return null
  }
  return new Date(Date.UTC(year, month - 1, 1))
}

export function formatPeriod(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

export function addMonths(period: string, months: number) {
  const date = monthDateFromPeriod(period)
  if (!date) {
    return period
  }
  date.setUTCMonth(date.getUTCMonth() + months)
  return formatPeriod(date)
}

export function monthIndexFromPeriod(period: string) {
  const [year, month] = period.split('-').map(Number)
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    return null
  }
  return year * 12 + month - 1
}

export function todayMonthPosition() {
  const today = new Date()
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
  return today.getFullYear() * 12 + today.getMonth() + clamp((today.getDate() - 1) / daysInMonth, 0, 1)
}

export function getPointTodayMarkerX(
  periods: string[],
  xForIndex: (index: number) => number,
  plotLeft: number,
  plotRight: number,
) {
  const monthPositions = periods.map(monthIndexFromPeriod)
  if (monthPositions.length === 0 || monthPositions.some((position) => position === null)) {
    return null
  }
  const todayPosition = todayMonthPosition()
  const firstPosition = monthPositions[0] as number
  const lastPosition = monthPositions[monthPositions.length - 1] as number
  if (todayPosition < firstPosition) {
    return plotLeft
  }
  if (todayPosition >= lastPosition) {
    return null
  }
  for (let index = 0; index < monthPositions.length - 1; index += 1) {
    const leftPosition = monthPositions[index] as number
    const rightPosition = monthPositions[index + 1] as number
    if (todayPosition >= leftPosition && todayPosition <= rightPosition) {
      const progress = rightPosition === leftPosition ? 0 : (todayPosition - leftPosition) / (rightPosition - leftPosition)
      return clamp(xForIndex(index) + (xForIndex(index + 1) - xForIndex(index)) * progress, plotLeft, plotRight)
    }
  }
  return null
}

export function getBarTodayMarkerX(
  bars: Array<{ period: string; x: number; width: number }>,
  plotLeft: number,
  plotRight: number,
) {
  const today = new Date()
  const todayMonth = today.getFullYear() * 12 + today.getMonth()
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
  const monthProgress = clamp((today.getDate() - 1) / daysInMonth, 0, 1)
  for (const bar of bars) {
    const monthIndex = monthIndexFromPeriod(bar.period)
    if (monthIndex === todayMonth) {
      return clamp(bar.x + bar.width * monthProgress, plotLeft, plotRight)
    }
    if (monthIndex !== null && monthIndex > todayMonth) {
      return clamp(bar.x, plotLeft, plotRight)
    }
  }
  return null
}

export function FutureRangeTint({
  bottom,
  left,
  right,
  top,
  x,
}: {
  bottom: number
  left: number
  right: number
  top: number
  x: number | null
}) {
  if (x === null) {
    return null
  }
  const tintX = clamp(x, left, right)
  const width = Math.max(0, right - tintX)
  if (width <= 0) {
    return null
  }
  return <rect aria-hidden="true" className="chart__future-tint" height={bottom - top} width={width} x={tintX} y={top} />
}

export function TodayMarkerLine({
  bottom,
  left,
  right,
  top,
  x,
}: {
  bottom: number
  left: number
  right: number
  top: number
  x: number | null
}) {
  if (x === null) {
    return null
  }
  const lineX = clamp(x, left, right)
  return <line aria-hidden="true" className="chart__today-line" x1={lineX} x2={lineX} y1={top} y2={bottom} />
}

export function buildForecast(points: Array<{ period: string; value: number }>, months: number) {
  if (points.length < 2) {
    return []
  }
  const windowedPoints = points.slice(-Math.min(points.length, 36))
  const xValues = windowedPoints.map((_, index) => index)
  const yValues = windowedPoints.map((point) => point.value)
  const xMean = xValues.reduce((sum, value) => sum + value, 0) / xValues.length
  const yMean = yValues.reduce((sum, value) => sum + value, 0) / yValues.length
  const denominator = xValues.reduce((sum, value) => sum + (value - xMean) ** 2, 0)
  const slope = denominator === 0
    ? 0
    : xValues.reduce((sum, value, index) => sum + (value - xMean) * (yValues[index] - yMean), 0) / denominator
  const intercept = yMean - slope * xMean
  const residuals = yValues.map((value, index) => value - (intercept + slope * index))
  const residualVariance =
    residuals.reduce((sum, value) => sum + value ** 2, 0) / Math.max(1, residuals.length - 2)
  const residualStdDev = Math.sqrt(residualVariance)
  const baseline = points.at(-1)
  if (!baseline) {
    return []
  }
  return Array.from({ length: months }, (_, index) => {
    const step = index + 1
    const value = baseline.value + slope * step
    const uncertainty = Math.max(residualStdDev * 1.64 * Math.sqrt(1 + step / 12), Math.abs(value) * 0.03)
    return {
      period: addMonths(baseline.period, step),
      value,
      lower: value - uncertainty,
      upper: value + uncertainty,
      forecast: true,
    }
  })
}

export type SankeyNodeDatum = {
  id: string
  label: string
  kind: 'income' | 'expense' | 'result'
  color: string
}

export type SankeyLinkDatum = {
  color: string
  label: string
}

export const seriesColors = [
  '#1e6fd6',
  '#12946f',
  '#c43f3f',
  '#8b5cf6',
  '#d97706',
  '#0f766e',
  '#be185d',
  '#64748b',
]

/**
 * Utility service labels come straight from user-entered data (imports use
 * Polish names like "Woda Zimna" / "Prąd"; manual entry may use English), so
 * colors and the water grouping are keyed off a normalized category instead
 * of an exact label match.
 */
export function normalizedUtilityCategory(label: string): string | null {
  const lower = label.toLowerCase()
  // NFD strips combining diacritics (\u0105 \u2192 a, \u0107 \u2192 c, ...) but Polish \u0142/\u0141 are
  // standalone letters with no decomposition, so fold those in separately.
  const stripped = lower
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replaceAll('\u0142', 'l')
  if (stripped.includes('zimna') || stripped.includes('cold water')) return 'cold-water'
  if (stripped.includes('ciepl') || stripped.includes('gorac') || stripped.includes('hot water')) return 'hot-water'
  if (stripped.includes('prad') || stripped.includes('electric')) return 'electricity'
  if (stripped === 'c.o.' || stripped.includes('ogrzewanie') || stripped.includes('heating')) return 'heating'
  if (stripped.includes('czynsz') || stripped.includes('rent')) return 'rent'
  if (stripped.includes('internet')) return 'internet'
  if (stripped.includes('telefon') || stripped.includes('phone')) return 'phone'
  return null
}

const UTILITY_CATEGORY_COLORS: Record<string, string> = {
  total: '#111827',
  water: '#1e6fd6',
  'cold-water': '#1e6fd6',
  'hot-water': '#c43f3f',
  electricity: '#eab308',
  heating: '#f97316',
  rent: '#64748b',
  internet: '#12946f',
  phone: '#8b5cf6',
}

export function utilitySeriesColor(label: string, colors: Record<string, string> = {}): string | undefined {
  if (Object.hasOwn(colors, label) && /^#[0-9a-f]{6}$/i.test(colors[label])) return colors[label]
  if (label === 'Total') return UTILITY_CATEGORY_COLORS.total
  if (label === 'Water') return UTILITY_CATEGORY_COLORS.water
  const category = normalizedUtilityCategory(label)
  return category ? UTILITY_CATEGORY_COLORS[category] : undefined
}

const isCategoryWater = (category: string) => {
  const normalized = normalizedUtilityCategory(category)
  return normalized === 'cold-water' || normalized === 'hot-water'
}

export function utilityLegendItems(categories: string[], metric: 'money' | 'usage' | 'rate') {
  const hasWater = categories.some(isCategoryWater)
  const base = [
    ...(metric === 'money' ? ['Total'] : []),
    'All',
    ...(hasWater ? ['Water'] : []),
    ...categories.filter((category) => !isCategoryWater(category)),
  ]
  return Array.from(new Set(base))
}

export function utilitySeriesForSelection(categories: string[], selectedCategory: string, metric: 'money' | 'usage' | 'rate') {
  if (selectedCategory === 'total' && metric === 'money') {
    return ['Total']
  }
  if (selectedCategory === 'all' || selectedCategory === 'total') {
    return categories
  }
  if (selectedCategory === 'Water') {
    return categories.filter(isCategoryWater)
  }
  return [selectedCategory]
}

export function utilityLegendKey(label: string) {
  return label === 'Total' ? 'total' : label === 'All' ? 'all' : label
}

export function utilityDisplayLabel(label: string) {
  return label === 'total' ? 'Total' : label === 'all' ? 'All' : label
}
