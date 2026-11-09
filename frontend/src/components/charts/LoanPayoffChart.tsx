import { useState } from 'react'
import type { LoanPaymentDetail } from '../../contracts/dashboard'
import { buildTicks, formatCurrency, numericValue, tooltipLeftPercent } from './shared'

export function LoanPayoffChart({
  payments,
  currency,
}: {
  payments: LoanPaymentDetail[]
  currency: string
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  const points = payments.map((payment) => ({
    period: payment.date,
    balance: numericValue(payment.outstanding_loan_balance),
    interestBalance: numericValue(payment.interest_balance),
    payment: numericValue(payment.payment),
    interest: numericValue(payment.interest),
    principal: numericValue(payment.principal),
    extraPrincipal: numericValue(payment.extra_principal),
    projected: payment.projected ?? false,
  }))

  if (points.length === 0) {
    return <div className="chart-empty">No data yet</div>
  }

  const width = 900
  const height = 320
  const margin = { top: 20, right: 24, bottom: 46, left: 72 }
  const plotWidth = width - margin.left - margin.right
  const plotHeight = height - margin.top - margin.bottom
  const values = points.flatMap((point) => [point.balance, point.interestBalance])
  const rawMax = Math.max(...values, 1)
  const max = rawMax * 1.08
  const min = 0
  const span = max - min || 1
  const xStep = points.length > 1 ? plotWidth / (points.length - 1) : 0
  const xForIndex = (index: number) => margin.left + (points.length > 1 ? index * xStep : plotWidth / 2)
  const yForValue = (value: number) => margin.top + plotHeight - ((value - min) / span) * plotHeight
  const coordinates = points.map((point, index) => ({
    ...point,
    x: xForIndex(index),
    balanceY: yForValue(point.balance),
    interestY: yForValue(point.interestBalance),
  }))
  const pathFor = (key: 'balanceY' | 'interestY') =>
    coordinates
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point[key].toFixed(2)}`)
      .join(' ')
  const balancePath = pathFor('balanceY')
  const balanceArea =
    coordinates.length > 1
      ? `${balancePath} L ${coordinates.at(-1)?.x.toFixed(2)} ${margin.top + plotHeight} L ${coordinates[0].x.toFixed(2)} ${margin.top + plotHeight} Z`
      : ''
  const ticks = buildTicks(min, max)
  const xLabelEvery = Math.max(1, Math.ceil(points.length / 6))
  const activePoint = activeIndex !== null ? coordinates[activeIndex] : null
  const hitWidth = Math.max(10, xStep || plotWidth)
  const firstProjectedIndex = coordinates.findIndex((point) => point.projected)
  const futureX = firstProjectedIndex >= 0 ? coordinates[firstProjectedIndex].x : null

  return (
    <div className="loan-payoff-chart">
      <div className="chart-stage">
        <svg className="chart-axis" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Loan payoff balance and interest outlook" onMouseLeave={() => setActiveIndex(null)}>
          <defs>
            <linearGradient id="loan-payoff-balance-fill" x1="0" x2="0" y1="0" y2="1">
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
              <path className="loan-payoff-chart__area" d={balanceArea} />
              <path className="loan-payoff-chart__balance" d={balancePath} />
              <path className="loan-payoff-chart__interest" d={pathFor('interestY')} />
            </>
          ) : null}
          {coordinates.map((point, index) => {
            const showLabel = index === 0 || index === points.length - 1 || index % xLabelEvery === 0
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
              top: `${(activePoint.balanceY / height) * 100}%`,
            }}
          >
            <span>{activePoint.period}</span>
            <strong>Balance {formatCurrency(activePoint.balance, currency)}</strong>
            <strong>Interest left {formatCurrency(activePoint.interestBalance, currency)}</strong>
            <strong>Payment {formatCurrency(activePoint.payment, currency)}</strong>
            <strong>Principal {formatCurrency(activePoint.principal + activePoint.extraPrincipal, currency)}</strong>
          </div>
        ) : null}
      </div>

      <div className="loan-payoff-chart__legend" aria-hidden="true">
        <span><i className="loan-payoff-chart__legend-balance" />Balance</span>
        <span><i className="loan-payoff-chart__legend-interest" />Interest remaining</span>
        {futureX !== null ? <span><i className="loan-payoff-chart__legend-future" />Not yet paid</span> : null}
      </div>
    </div>
  )
}

