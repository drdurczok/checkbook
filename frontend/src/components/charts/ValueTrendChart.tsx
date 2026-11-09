import { useState } from 'react'
import { buildTicks, evenlySpacedIndices, formatCurrency, tooltipLeftPercent } from './shared'

export type ValueTrendPoint = {
  period: string
  value: number
  projected: boolean
  /** Signed monthly rate driving this point forward — the implied rate
   * between two known value entries, or the projected rate past the last
   * known one. Shown in the tooltip; omitted at segment start points. */
  monthlyRatePercent?: number
}

/** Same visual language as LoanPayoffChart (single line, grey "projected"
 * tint, hover tooltip, legend) applied to a property/vehicle's
 * appreciation/depreciation curve instead of a loan balance. */
export function ValueTrendChart({
  points,
  currency,
}: {
  points: ValueTrendPoint[]
  currency: string
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  if (points.length === 0) {
    return <div className="chart-empty">No data yet</div>
  }

  const width = 900
  const height = 320
  const margin = { top: 20, right: 24, bottom: 46, left: 72 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  const values = points.map((point) => point.value)
  const rawMin = Math.min(...values, 0)
  const rawMax = Math.max(...values, 1)
  const min = rawMin < 0 ? rawMin * 1.08 : 0
  const max = rawMax * 1.08
  const span = max - min || 1
  const xStep = points.length > 1 ? plotWidth / (points.length - 1) : 0
  const xForIndex = (index: number) => margin.left + (points.length > 1 ? index * xStep : plotWidth / 2)
  const yForValue = (value: number) => margin.top + plotHeight - ((value - min) / span) * plotHeight
  const coordinates = points.map((point, index) => ({
    ...point,
    x: xForIndex(index),
    y: yForValue(point.value),
  }))
  const valuePath = coordinates
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ')
  const valueArea =
    coordinates.length > 1
      ? `${valuePath} L ${coordinates.at(-1)?.x.toFixed(2)} ${margin.top + plotHeight} L ${coordinates[0].x.toFixed(2)} ${margin.top + plotHeight} Z`
      : ''
  const ticks = buildTicks(min, max)
  const labelIndices = evenlySpacedIndices(points.length, 6)
  const activePoint = activeIndex !== null ? coordinates[activeIndex] : null
  const hitWidth = Math.max(10, xStep || plotWidth)
  const firstProjectedIndex = coordinates.findIndex((point) => point.projected)
  const futureX = firstProjectedIndex >= 0 ? coordinates[firstProjectedIndex].x : null

  return (
    <div className="loan-payoff-chart">
      <div className="chart-stage">
        <svg className="chart-axis" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Value appreciation and depreciation outlook" onMouseLeave={() => setActiveIndex(null)}>
          <defs>
            <linearGradient id="value-trend-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#1e6fd6" stopOpacity="0.24" />
              <stop offset="100%" stopColor="#1e6fd6" stopOpacity="0.04" />
            </linearGradient>
          </defs>
          {ticks.map((tick) => {
            const y = yForValue(tick)
            return (
              <g key={tick} className="chart-tick">
                <line x1={margin.left} x2={width - margin.right} y1={y} y2={y} />
                <text x={margin.left - 10} y={y + 4} textAnchor="end">
                  {formatCurrency(tick, currency, true)}
                </text>
              </g>
            )
          })}
          {futureX !== null ? (
            <rect
              className="loan-payoff-chart__future"
              x={futureX}
              y={margin.top}
              width={Math.max(0, width - margin.right - futureX)}
              height={plotHeight}
            />
          ) : null}
          {coordinates.length > 1 ? (
            <>
              <path className="loan-payoff-chart__area" d={valueArea} style={{ fill: 'url(#value-trend-fill)' }} />
              <path className="loan-payoff-chart__balance" d={valuePath} />
            </>
          ) : null}
          {coordinates.map((point, index) => {
            const showLabel = labelIndices.has(index)
            return (
              <g key={`${point.period}-${index}`}>
                <rect
                  className="chart__hit"
                  x={point.x - hitWidth / 2}
                  y={margin.top}
                  width={hitWidth}
                  height={plotHeight}
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
            className="chart-tooltip loan-payoff-chart__tooltip"
            style={{
              left: `${tooltipLeftPercent(activePoint.x, width, 190)}%`,
              top: `${(activePoint.y / height) * 100}%`,
            }}
          >
            <span>{activePoint.period}</span>
            <strong>Value {formatCurrency(activePoint.value, currency)}</strong>
            {activePoint.monthlyRatePercent !== undefined ? (
              <strong>{activePoint.monthlyRatePercent > 0 ? '+' : ''}{activePoint.monthlyRatePercent.toFixed(2)}%/mo</strong>
            ) : null}
            {activePoint.projected ? <strong>Projected</strong> : null}
          </div>
        ) : null}
      </div>

      <div className="loan-payoff-chart__legend" aria-hidden="true">
        <span><i className="loan-payoff-chart__legend-balance" />Value</span>
        {futureX !== null ? <span><i className="loan-payoff-chart__legend-future" />Projected</span> : null}
      </div>
    </div>
  )
}

