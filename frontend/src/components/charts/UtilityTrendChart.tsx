import { useState } from 'react'
import type { UtilitySeriesPoint } from '../../contracts/dashboard'
import { FutureRangeTint, TodayMarkerLine, buildTicks, formatCurrency, formatNumber, getPointTodayMarkerX, numericValue, seriesColors, smoothBimonthlySeries, tooltipLeftPercent, utilityDisplayLabel, utilityLegendItems, utilityLegendKey, utilitySeriesColor, utilitySeriesForSelection } from './shared'

export function UtilityTrendChart({
  points,
  categories,
  categoryLabels = {},
  categoryColors = {},
  selectedCategory,
  metric,
  currency,
  onCategorySelect,
  showTodayMarker = false,
}: {
  points: UtilitySeriesPoint[]
  categories: string[]
  categoryLabels?: Record<string, string>
  categoryColors?: Record<string, string>
  selectedCategory: string
  metric: 'money' | 'usage' | 'rate'
  currency: string
  onCategorySelect: (category: string) => void
  showTodayMarker?: boolean
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  if (points.length === 0) {
    return <div className="chart-empty">No data yet</div>
  }

  // Both usage and unit-price (rate) require recorded usage, so categories
  // without any usage data are hidden from the legend in those modes.
  const needsUsage = metric === 'usage' || metric === 'rate'
  const categoriesWithUsage = needsUsage
    ? new Set(categories.filter((cat) => points.some((point) => numericValue(point.usage[cat]) !== 0)))
    : null

  const baseLegend = utilityLegendItems(categories, metric)
  const legendItems = [...baseLegend, ...categories.filter((label) => categoryColors[label] && !baseLegend.includes(label))].filter((item) => {
    if (!categoriesWithUsage) return true
    if (item === 'All') return categoriesWithUsage.size > 0
    if (item === 'Water') return ['Cold water', 'Hot water'].some((cat) => categoriesWithUsage.has(cat))
    return categoriesWithUsage.has(item)
  })
  const selectedSeries = utilitySeriesForSelection(categories, selectedCategory, metric)
  const colorForLabel = (label: string) => utilitySeriesColor(label, categoryColors) ?? utilitySeriesColor(categoryLabels[label] ?? label)
    ?? seriesColors[Math.max(0, categories.indexOf(label)) % seriesColors.length]
  const rateForPoint = (point: UtilitySeriesPoint, label: string) => {
    const usage = numericValue(point.usage[label])
    return usage !== 0 ? numericValue(point.values[label]) / usage : 0
  }
  const series = selectedSeries
    .map((label) => {
      const rawValues = points.map((point) =>
        metric === 'money'
          ? label === 'Total'
            ? point.total
            : numericValue(point.values[label])
          : label === 'Total'
            ? 0
            : metric === 'usage'
              ? numericValue(point.usage[label])
              : rateForPoint(point, label),
      )
      return {
        label,
        color: colorForLabel(label),
        values: metric === 'money' ? smoothBimonthlySeries(rawValues) : rawValues,
      }
    })
    .filter((item) => item.values.some((value) => value !== 0))

  if (series.length === 0) {
    return <div className="chart-empty">No data yet</div>
  }

  const usageUnits = needsUsage
    ? Array.from(
        new Set(
          selectedSeries
            .flatMap((label) => points.map((point) => point.units[label]).filter(Boolean)),
        ),
      )
    : []
  const rateUnit = usageUnits.length === 1 ? usageUnits[0] : 'unit'
  const axisUnit =
    metric === 'usage'
      ? usageUnits.length === 1 ? usageUnits[0] : 'units'
      : metric === 'rate'
        ? `${currency}/${rateUnit}`
        : ''
  const width = 860
  const height = 320
  const margin = { top: 20, right: 24, bottom: 46, left: metric === 'money' ? 70 : 92 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  const rawMax = Math.max(...series.flatMap((item) => item.values), 1)
  const max = rawMax * 1.12
  const min = 0
  const span = max - min || 1
  const xStep = points.length > 1 ? plotWidth / (points.length - 1) : 0
  const xForIndex = (index: number) => margin.left + (points.length > 1 ? index * xStep : plotWidth / 2)
  const yForValue = (value: number) => margin.top + plotHeight - ((value - min) / span) * plotHeight
  const ticks = buildTicks(min, max)
  const xLabelEvery = Math.max(1, Math.ceil(points.length / 6))
  const activePoint = activeIndex !== null ? points[activeIndex] : null
  const activeX = activeIndex !== null ? xForIndex(activeIndex) : 0
  const activeY = activePoint ? yForValue(series[0]?.values[activeIndex ?? 0] ?? 0) : 0
  const hitWidth = Math.max(10, xStep || plotWidth)
  const todayMarkerX = showTodayMarker
    ? getPointTodayMarkerX(points.map((point) => point.period), xForIndex, margin.left, width - margin.right)
    : null

  const pathForValues = (values: number[]) =>
    values
      .map((value, index) => `${index === 0 ? 'M' : 'L'} ${xForIndex(index).toFixed(2)} ${yForValue(value).toFixed(2)}`)
      .join(' ')

  return (
    <div className="utility-trend-chart">
      <div className="chart-stage">
        <svg className="chart-axis" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Monthly utility costs" onMouseLeave={() => setActiveIndex(null)}>
          {ticks.map((tick) => {
            const y = yForValue(tick)
            return (
              <g key={tick} className="chart-tick">
                <line x1={margin.left} x2={width - margin.right} y1={y} y2={y} />
                <text x={margin.left - 10} y={y + 4} textAnchor="end">
                  {metric === 'money' ? formatCurrency(tick, currency, true) : `${formatNumber(tick)} ${axisUnit}`}
                </text>
              </g>
            )
          })}
          <FutureRangeTint bottom={margin.top + plotHeight} left={margin.left} right={width - margin.right} top={margin.top} x={todayMarkerX} />
          {series.map((item) => (
            <path
              className="utility-trend-chart__line"
              d={pathForValues(item.values)}
              key={item.label}
              style={{ stroke: item.color }}
            />
          ))}
          <TodayMarkerLine bottom={margin.top + plotHeight} left={margin.left} right={width - margin.right} top={margin.top} x={todayMarkerX} />
          {points.map((point, index) => {
            const x = xForIndex(index)
            const showLabel = index === 0 || index === points.length - 1 || index % xLabelEvery === 0
            return (
              <g key={`${point.period}-${index}`}>
                <rect
                  className="chart__hit"
                  x={x - hitWidth / 2}
                  y={margin.top}
                  width={hitWidth}
                  height={plotHeight}
                  onMouseEnter={() => setActiveIndex(index)}
                  onFocus={() => setActiveIndex(index)}
                />
                {showLabel ? (
                  <text className="chart-x-label" x={x} y={height - 14} textAnchor="middle">
                    {point.period}
                  </text>
                ) : null}
              </g>
            )
          })}
        </svg>
        {activePoint ? (
          <div
            className="chart-tooltip utility-trend-chart__tooltip"
            style={{
              left: `${tooltipLeftPercent(activeX, width)}%`,
              top: `${(activeY / height) * 100}%`,
            }}
          >
            <span>{activePoint.period}</span>
            {series.map((item) => {
              const value = item.label === 'Total' ? activePoint.total : numericValue(activePoint.values[item.label])
              const rawUsage = item.label === 'Total' ? 0 : numericValue(activePoint.usage[item.label])
              const unit = activePoint.units[item.label]
              let displayValue: string
              let secondary = ''
              if (metric === 'money') {
                displayValue = formatCurrency(value, currency)
                secondary = rawUsage && unit ? ` · ${formatNumber(rawUsage)} ${unit}` : ''
              } else if (metric === 'usage') {
                displayValue = `${formatNumber(rawUsage)} ${unit || ''}`
              } else {
                const rate = rawUsage !== 0 ? value / rawUsage : 0
                displayValue = `${rate.toFixed(2)} ${currency}/${unit || 'unit'}`
                secondary = rawUsage && unit ? ` · ${formatCurrency(value, currency)} / ${formatNumber(rawUsage)} ${unit}` : ''
              }
              return (
                <strong key={item.label}>
                  {categoryLabels[item.label] ?? item.label} {displayValue}{secondary}
                </strong>
              )
            })}
          </div>
        ) : null}
      </div>
      <div className="utility-trend-chart__legend" aria-label="Utility chart filters">
        {legendItems.map((item) => (
          <button
            className={selectedCategory === utilityLegendKey(item) || selectedCategory === item ? 'is-active' : ''}
            key={item}
            onClick={() => onCategorySelect(utilityLegendKey(item))}
            type="button"
          >
            <i style={{ background: item === 'All' ? '#64748b' : colorForLabel(item) }} />
            {categoryLabels[item] ?? utilityDisplayLabel(item)}
          </button>
        ))}
      </div>
    </div>
  )
}

