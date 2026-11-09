import type { BreakdownPoint } from '../../contracts/dashboard'
import { clamp, formatCurrency, formatNumber } from './shared'

export function DonutChart({
  items,
  currency,
}: {
  items: BreakdownPoint[]
  currency: string
}) {
  if (items.length === 0) {
    return <div className="chart-empty">No data yet</div>
  }

  const total = items.reduce((sum, item) => sum + item.value, 0)
  const totalLabel = formatCurrency(total, currency)
  const totalFontSizePx = Math.max(14, Math.min(21.6, 122 / (totalLabel.length * 0.62)))
  const sorted = [...items].sort((a, b) => b.value - a.value)
  const palette = ['#1e6fd6', '#12946f', '#e88936', '#7c5cff', '#d5476a', '#64748b']
  const radius = 58
  const circumference = 2 * Math.PI * radius
  const segments = sorted.map((item, index) => {
    const share = total > 0 ? item.value / total : item.share
    const length = clamp(share, 0, 1) * circumference
    const offset = sorted.slice(0, index).reduce((sum, priorItem) => {
      const priorShare = total > 0 ? priorItem.value / total : priorItem.share
      return sum + clamp(priorShare, 0, 1) * circumference
    }, 0)
    return { item, index, length, offset }
  })

  return (
    <div className="composition-chart">
      <div className="composition-donut" aria-label={`${formatCurrency(total, currency)} across ${sorted.length} categories`}>
        <svg viewBox="0 0 160 160" role="img">
          <circle className="composition-donut__track" cx="80" cy="80" r={radius} />
          {segments.map(({ item, index, length, offset }) => (
            <circle
              className="composition-donut__segment"
              cx="80"
              cy="80"
              key={item.label}
              r={radius}
              stroke={palette[index % palette.length]}
              strokeDasharray={`${length} ${circumference - length}`}
              strokeDashoffset={-offset}
            />
          ))}
        </svg>
        <div className="composition-donut__total">
          <span>Total</span>
          <strong style={{ fontSize: `${totalFontSizePx}px` }}>{totalLabel}</strong>
          <small>{sorted.length} categories</small>
        </div>
      </div>

      <div className="composition-legend">
        {sorted.slice(0, 6).map((item, index) => {
          const share = total > 0 ? item.value / total : item.share
          return (
            <div className="composition-legend__row" key={item.label}>
              <span style={{ background: palette[index % palette.length] }} />
              <strong>{item.label}</strong>
              <small>{formatNumber(share * 100)}%</small>
            </div>
          )
        })}
      </div>
    </div>
  )
}

