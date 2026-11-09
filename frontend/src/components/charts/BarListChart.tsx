import { clamp, formatCurrency } from './shared'

export function BarListChart({
  items,
  currency,
}: {
  items: Array<{ label: string; value: number; meta?: string }>
  currency: string
}) {
  if (items.length === 0) {
    return <div className="chart-empty">No data yet</div>
  }

  const max = Math.max(...items.map((item) => Math.abs(item.value)), 1)
  return (
    <div className="bar-list-chart">
      {items.map((item) => (
        <div className="bar-list-row" key={item.label}>
          <div>
            <strong>{item.label}</strong>
            {item.meta ? <span>{item.meta}</span> : null}
          </div>
          <div className="bar-list-track" aria-hidden="true">
            <div style={{ width: `${clamp((Math.abs(item.value) / max) * 100, 3, 100)}%` }} />
          </div>
          <strong>{formatCurrency(item.value, currency)}</strong>
        </div>
      ))}
    </div>
  )
}

