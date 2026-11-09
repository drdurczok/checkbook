import { useState } from 'react'
import type { CashFlowPoint } from '../../contracts/dashboard'
import { FutureRangeTint, TodayMarkerLine, buildTicks, formatCurrency, getPointTodayMarkerX, tooltipLeftPercent } from './shared'

export function CashFlowChart({
  points,
  currency,
  showTodayMarker = false,
}: {
  points: CashFlowPoint[]
  currency: string
  showTodayMarker?: boolean
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
  const values = points.flatMap((point) => [point.income, -point.expenses, point.net])
  const maxAbs = Math.max(...values.map((value) => Math.abs(value)), 1)
  const max = maxAbs * 1.12
  const min = -max
  const span = max - min
  const zeroY = margin.top + plotHeight - ((0 - min) / span) * plotHeight
  const xStep = points.length > 1 ? plotWidth / (points.length - 1) : 0
  const xForIndex = (index: number) => margin.left + (points.length > 1 ? index * xStep : plotWidth / 2)
  const yForValue = (value: number) => margin.top + plotHeight - ((value - min) / span) * plotHeight
  const coordinates = points.map((point, index) => ({
    ...point,
    x: xForIndex(index),
    incomeY: yForValue(point.income),
    expensesY: yForValue(-point.expenses),
    netY: yForValue(point.net),
  }))
  const pathFor = (key: 'incomeY' | 'expensesY' | 'netY') =>
    coordinates
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point[key].toFixed(2)}`)
      .join(' ')
  const areaFor = (key: 'incomeY' | 'expensesY') => {
    if (coordinates.length === 0) {
      return ''
    }
    const seriesPath = pathFor(key)
    const last = coordinates.at(-1) ?? coordinates[0]
    return `${seriesPath} L ${last.x.toFixed(2)} ${zeroY.toFixed(2)} L ${coordinates[0].x.toFixed(2)} ${zeroY.toFixed(2)} Z`
  }
  const ticks = buildTicks(min, max)
  const xLabelEvery = Math.max(1, Math.ceil(points.length / 6))
  const activePoint = activeIndex !== null ? coordinates[activeIndex] : null
  const latest = points.at(-1) ?? points[0]
  const todayMarkerX = showTodayMarker
    ? getPointTodayMarkerX(points.map((point) => point.period), xForIndex, margin.left, width - margin.right)
    : null

  return (
    <div className="cash-flow-chart">
      <div className="chart-stat-grid chart-stat-grid--compact cash-flow-chart__stats" aria-label="Cash flow summary">
        <div>
          <span>Income</span>
          <strong className="is-positive">{formatCurrency(latest.income, currency)}</strong>
        </div>
        <div>
          <span>Expenses</span>
          <strong className="is-negative">{formatCurrency(latest.expenses, currency)}</strong>
        </div>
        <div>
          <span>Net</span>
          <strong className={latest.net >= 0 ? 'is-positive' : 'is-negative'}>{formatCurrency(latest.net, currency)}</strong>
        </div>
      </div>

      <div className="chart-stage">
        <svg className="chart-axis cash-flow-chart__axis" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Monthly income, expenses, and net cash flow" onMouseLeave={() => setActiveIndex(null)}>
          {ticks.map((tick) => {
            const y = yForValue(tick)
            return (
              <g className={`chart-tick ${Math.abs(tick) < 0.001 ? 'chart-tick--zero' : ''}`} key={tick}>
                <line x1={margin.left} x2={width - margin.right} y1={y} y2={y} />
                <text x={margin.left - 10} y={y + 4} textAnchor="end">
                  {formatCurrency(tick, currency, true)}
                </text>
              </g>
            )
          })}
          <FutureRangeTint bottom={margin.top + plotHeight} left={margin.left} right={width - margin.right} top={margin.top} x={todayMarkerX} />
          <line className="cash-flow-chart__zero" x1={margin.left} x2={width - margin.right} y1={zeroY} y2={zeroY} />
          {points.length > 1 ? (
            <>
              <path
                className="cash-flow-chart__area cash-flow-chart__area--income"
                d={areaFor('incomeY')}
                fill="#12946f"
                fillOpacity="0.28"
              />
              <path
                className="cash-flow-chart__area cash-flow-chart__area--expenses"
                d={areaFor('expensesY')}
                fill="#c43f3f"
                fillOpacity="0.25"
              />
              <path className="cash-flow-chart__line cash-flow-chart__line--net" d={pathFor('netY')} />
            </>
          ) : null}
          <TodayMarkerLine bottom={margin.top + plotHeight} left={margin.left} right={width - margin.right} top={margin.top} x={todayMarkerX} />
          {coordinates.map((point, index) => {
            const showLabel = index === 0 || index === points.length - 1 || index % xLabelEvery === 0
            return (
              <g key={`${point.period}-${index}`}>
                <circle className="chart__hit" cx={point.x} cy={point.netY} r={14} onMouseEnter={() => setActiveIndex(index)} onFocus={() => setActiveIndex(index)} />
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
            className="chart-tooltip cash-flow-chart__tooltip"
            style={{
              left: `${tooltipLeftPercent(activePoint.x, width)}%`,
              top: `${(activePoint.netY / height) * 100}%`,
            }}
          >
            <span>{activePoint.period}</span>
            <strong className="is-positive">Income {formatCurrency(activePoint.income, currency)}</strong>
            <strong className="is-negative">Expenses {formatCurrency(activePoint.expenses, currency)}</strong>
            <strong>Net {formatCurrency(activePoint.net, currency)}</strong>
          </div>
        ) : null}
      </div>

      <div className="cash-flow-chart__legend" aria-hidden="true">
        <span><i className="cash-flow-chart__legend-income" />Income</span>
        <span><i className="cash-flow-chart__legend-expenses" />Expenses</span>
        <span><i className="cash-flow-chart__legend-net" />Net</span>
      </div>
    </div>
  )
}

