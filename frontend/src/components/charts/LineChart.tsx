import { useState } from 'react'
import { FutureRangeTint, TodayMarkerLine, buildForecast, buildTicks, evenlySpacedIndices, formatCurrency, formatNumber, getPointTodayMarkerX, tooltipLeftPercent } from './shared'

export function LineChart({
  points,
  currency,
  showForecast = false,
  showTodayMarker = false,
  showStats = true,
  floatingBaseline = false,
  lineColor,
}: {
  points: Array<{ period: string; value: number }>
  currency: string
  showForecast?: boolean
  showTodayMarker?: boolean
  showStats?: boolean
  /** Anchor the axis near the data instead of zero: the baseline starts
   *  just below the first entry (or the lowest dip), so long-horizon growth
   *  is not squashed by a wasted run-up from zero. */
  floatingBaseline?: boolean
  /** Override the default accent line/area color, e.g. to match a category
   *  filter driving the chart. */
  lineColor?: string
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  if (points.length === 0) {
    return <div className="chart-empty">No data yet</div>
  }

  const width = 760
  const height = 320
  const margin = { top: 20, right: 18, bottom: 46, left: 66 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  const forecastPoints = showForecast ? buildForecast(points, 24) : []
  const chartPoints = showForecast ? [...points, ...forecastPoints] : points
  const values = [
    ...points.map((point) => point.value),
    ...forecastPoints.flatMap((point) => [point.value, point.lower, point.upper]),
  ]
  const rawMin = Math.min(...values)
  const rawMax = Math.max(...values)
  const padding = Math.max((rawMax - rawMin) * 0.12, Math.max(Math.abs(rawMax), 1) * 0.04)
  const firstPoint = points[0]
  // When nothing dips below zero, anchor the axis at 0 instead of padding
  // below the lowest value — a floating baseline overstates small dips —
  // unless the caller asks for one, in which case the axis starts just
  // below the first entry (or the lowest dip, if the series fell further).
  const min = floatingBaseline
    ? Math.min(firstPoint.value, rawMin) - padding
    : rawMin >= 0
      ? 0
      : rawMin - padding
  const max = rawMin === rawMax ? rawMax + padding : rawMax + padding
  const span = max - min || 1
  const lastPoint = points.at(-1) ?? firstPoint
  const change = lastPoint.value - firstPoint.value
  const averageChange = points.length > 1 ? change / (points.length - 1) : 0
  // Compound per-period growth rate — dividing by the first point's value
  // would explode when tracking started near zero.
  const averageChangePct =
    firstPoint.value > 0 && lastPoint.value > 0 && points.length > 1
      ? Math.pow(lastPoint.value / firstPoint.value, 1 / (points.length - 1)) - 1
      : null
  const ticks = buildTicks(min, max)
  const xStep = chartPoints.length > 1 ? plotWidth / (chartPoints.length - 1) : 0
  const xForIndex = (index: number) => margin.left + (chartPoints.length > 1 ? index * xStep : plotWidth / 2)
  const coordinates = chartPoints.map((point, index) => {
    const x = xForIndex(index)
    const y = margin.top + plotHeight - ((point.value - min) / span) * plotHeight
    return { ...point, x, y }
  })
  const historicalCoordinates = coordinates.slice(0, points.length)
  const forecastCoordinates = coordinates.slice(Math.max(points.length - 1, 0))
  const linePath = historicalCoordinates
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ')
  const forecastLinePath = forecastCoordinates
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ')
  const forecastBandCoordinates = [
    {
      period: lastPoint.period,
      value: lastPoint.value,
      lower: lastPoint.value,
      upper: lastPoint.value,
      forecast: true,
    },
    ...forecastPoints,
  ].map((point, index) => {
    const x = margin.left + (points.length - 1 + index) * xStep
    return {
      ...point,
      x,
      upperY: margin.top + plotHeight - ((point.upper - min) / span) * plotHeight,
      lowerY: margin.top + plotHeight - ((point.lower - min) / span) * plotHeight,
    }
  })
  const forecastBandPath = forecastBandCoordinates.length
    ? [
      ...forecastBandCoordinates.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.upperY.toFixed(2)}`),
      ...[...forecastBandCoordinates].reverse().map((point) => `L ${point.x.toFixed(2)} ${point.lowerY.toFixed(2)}`),
      'Z',
    ].join(' ')
    : ''
  const areaPath =
    historicalCoordinates.length > 1
      ? `${linePath} L ${historicalCoordinates.at(-1)?.x.toFixed(2)} ${margin.top + plotHeight} L ${historicalCoordinates[0].x.toFixed(2)} ${margin.top + plotHeight} Z`
      : ''
  const labelIndices = evenlySpacedIndices(chartPoints.length, 6)
  const activePoint = activeIndex !== null ? coordinates[activeIndex] : null
  const todayMarkerX = showTodayMarker
    ? getPointTodayMarkerX(chartPoints.map((point) => point.period), xForIndex, margin.left, width - margin.right)
    : null

  return (
    <div className="chart chart--line">
      {showStats ? (
        <div className="chart-stat-grid chart-stat-grid--compact" aria-label="Chart summary">
          <div>
            <span>Current</span>
            <strong>{formatCurrency(lastPoint.value, currency)}</strong>
          </div>
          <div>
            <span>Average change</span>
            <strong className={averageChange >= 0 ? 'is-positive' : 'is-negative'}>
              {formatCurrency(averageChange, currency)}
              {averageChangePct !== null ? ` (${formatNumber(averageChangePct * 100)}%)` : ''}
            </strong>
          </div>
        </div>
      ) : null}

      <div className="chart-stage">
      <svg className="chart-axis" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Trend from ${firstPoint.period} to ${chartPoints.at(-1)?.period ?? lastPoint.period}`} onMouseLeave={() => setActiveIndex(null)}>
        {ticks.map((tick) => {
          const y = margin.top + plotHeight - ((tick - min) / span) * plotHeight
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
        {forecastBandPath ? <path className="chart__forecast-band" d={forecastBandPath} /> : null}
        {points.length > 1 && areaPath ? <path className="chart__area" d={areaPath} fill="#1e6fd6" fillOpacity="0.08" style={lineColor ? { fill: lineColor } : undefined} /> : null}
        {points.length > 1 ? <path className="chart__line" d={linePath} style={lineColor ? { stroke: lineColor } : undefined} /> : null}
        {forecastLinePath ? <path className="chart__line chart__line--forecast" d={forecastLinePath} /> : null}
        <TodayMarkerLine bottom={margin.top + plotHeight} left={margin.left} right={width - margin.right} top={margin.top} x={todayMarkerX} />
        {coordinates.map((point, index) => {
          const showLabel = labelIndices.has(index)
          return (
            <g key={`${point.period}-${index}`}>
              <circle
                className="chart__hit"
                cx={point.x}
                cy={point.y}
                r={12}
                onMouseEnter={() => setActiveIndex(index)}
                onFocus={() => setActiveIndex(index)}
              />
              {showLabel ? (
                <text className="chart-x-label" x={point.x} y={height - 14} textAnchor="middle">
                  {point.period}
                </text>
              ) : null}
            </g>
          )
        })}
      </svg>
      {activePoint ? (
        <div
          className="chart-tooltip"
          style={{
            left: `${tooltipLeftPercent(activePoint.x, width)}%`,
            top: `${(activePoint.y / height) * 100}%`,
          }}
        >
          <span>{activePoint.period}{'forecast' in activePoint ? ' estimate' : ''}</span>
          <strong>{formatCurrency(activePoint.value, currency)}</strong>
          {'lower' in activePoint && 'upper' in activePoint && typeof activePoint.lower === 'number' && typeof activePoint.upper === 'number' ? (
            <small>
              {formatCurrency(activePoint.lower, currency)} - {formatCurrency(activePoint.upper, currency)}
            </small>
          ) : null}
        </div>
      ) : null}
      </div>
    </div>
  )
}

