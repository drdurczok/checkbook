import type { BreakdownPoint, MonthlyBreakdownPoint } from '../../contracts/dashboard'
import { FutureRangeTint, TodayMarkerLine, buildTicks, evenlySpacedIndices, formatCurrency, getBarTodayMarkerX, numericValue } from './shared'

export function StackedBarChart({
  points,
  categories,
  currency,
  selectedCategory = null,
  onCategorySelect,
  showTodayMarker = false,
  showLegend = true,
  categoryColors = {},
}: {
  points: MonthlyBreakdownPoint[]
  categories: BreakdownPoint[]
  currency: string
  categoryColors?: Record<string, string>
  selectedCategory?: string | null
  onCategorySelect?: (label: string) => void
  showTodayMarker?: boolean
  /** Render the interactive legend below the chart. Pages that surface their
      own filter controls for the same selection pass false to avoid a
      duplicate control row. */
  showLegend?: boolean
}) {
  const allLabels = categories.map((item) => item.label)
  const labels = selectedCategory && allLabels.includes(selectedCategory) ? [selectedCategory] : allLabels
  const palette = ['#1e6fd6', '#12946f', '#e88936', '#7c5cff', '#d5476a', '#64748b']
  const colorForLabel = (label: string) => {
    const index = Math.max(allLabels.indexOf(label), 0)
    return Object.hasOwn(categoryColors, label) ? categoryColors[label] : palette[index % palette.length]
  }
  const visiblePoints = points.filter((point) => labels.some((label) => numericValue(point.values[label]) > 0))

  if (visiblePoints.length === 0 || labels.length === 0) {
    return <div className="chart-empty">No data yet</div>
  }

  const totals = visiblePoints.map((point) =>
    labels.reduce((sum, label) => sum + numericValue(point.values[label]), 0),
  )
  const max = Math.max(...totals, 1)
  const width = 760
  const height = 300
  const margin = { top: 18, right: 14, bottom: 48, left: 62 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  // All-time forecasts can include decades of loan payments. Scale gaps with
  // the available month slot instead of letting minimum bar widths overflow.
  const barGap = Math.min(5, plotWidth / visiblePoints.length / 2)
  const barWidth = (plotWidth - barGap * (visiblePoints.length - 1)) / visiblePoints.length
  const xLabelIndices = evenlySpacedIndices(visiblePoints.length, 6)
  const ticks = buildTicks(0, max)
  const bars = visiblePoints.map((point, pointIndex) => {
    const x = margin.left + pointIndex * (barWidth + barGap)
    const segments = labels.reduce<{
      cursor: number
      items: Array<{ label: string; value: number; height: number; y: number; color: string }>
    }>(
      (state, label) => {
        const value = numericValue(point.values[label])
        const segmentHeight = (value / max) * plotHeight
        const y = state.cursor - segmentHeight
        return {
          cursor: y,
          items: value > 0
            ? [
                ...state.items,
                {
                  label,
                  value,
                  height: segmentHeight,
                  y,
                  color: colorForLabel(label),
                },
              ]
            : state.items,
        }
      },
      { cursor: margin.top + plotHeight, items: [] },
    ).items
    return { point, total: totals[pointIndex], x, segments }
  })
  const todayMarkerX = showTodayMarker
    ? getBarTodayMarkerX(
      bars.map((bar) => ({ period: bar.point.period, width: barWidth, x: bar.x })),
      margin.left,
      width - margin.right,
    )
    : null

  return (
    <div className="stacked-chart">
      <div className="stacked-chart__stage">
        <svg className="chart-axis" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Monthly expenses by category">
          {ticks.map((tick) => {
            const y = margin.top + plotHeight - (tick / max) * plotHeight
            return (
              <g key={tick} className="chart-tick">
                <line x1={margin.left} x2={width - margin.right} y1={y} y2={y} />
                <text x={margin.left - 10} y={y + 4} textAnchor="end">
                  {formatCurrency(tick, currency, true)}
                </text>
              </g>
            )
          })}
          <FutureRangeTint bottom={margin.top + plotHeight} left={margin.left} right={width - margin.right} top={margin.top} x={todayMarkerX} />
          {bars.map(({ point, total, x, segments }, pointIndex) => {
            return (
              <g key={point.period}>
                {segments.map((segment) => {
                  return (
                    <rect
                      className="stacked-chart__segment"
                      fill={segment.color}
                      height={Math.max(segment.height, 1)}
                      key={segment.label}
                      width={barWidth}
                      x={x}
                      y={segment.y}
                    >
                      <title>{`${point.period} ${segment.label}: ${formatCurrency(segment.value, currency)}`}</title>
                    </rect>
                  )
                })}
                <title>{`${point.period}: ${formatCurrency(total, currency)}`}</title>
                {xLabelIndices.has(pointIndex) ? (
                  <text
                    className="chart-x-label"
                    x={pointIndex === 0 ? x : pointIndex === visiblePoints.length - 1 ? x + barWidth : x + barWidth / 2}
                    y={height - 14}
                    textAnchor={pointIndex === 0 ? 'start' : pointIndex === visiblePoints.length - 1 ? 'end' : 'middle'}
                  >
                    {point.period}
                  </text>
                ) : null}
              </g>
            )
          })}
          <TodayMarkerLine bottom={margin.top + plotHeight} left={margin.left} right={width - margin.right} top={margin.top} x={todayMarkerX} />
        </svg>
      </div>
      {showLegend ? (
        <div className="stacked-chart__legend">
          {allLabels.map((label) => (
            <button
              aria-pressed={selectedCategory === label}
              className={selectedCategory === label ? 'is-active' : ''}
              key={label}
              onClick={() => onCategorySelect?.(label)}
              type="button"
            >
              <i style={{ background: colorForLabel(label) }} />
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

