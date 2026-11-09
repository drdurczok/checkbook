import type { ReactNode } from 'react'

export type MetricItem = {
  label: ReactNode
  value: ReactNode
}

export function MetricGrid({ items, className }: { items: MetricItem[]; className?: string }) {
  return (
    <div className={['metric-grid', className].filter(Boolean).join(' ')}>
      {items.map((item, index) => (
        <div className="metric-card" key={typeof item.label === 'string' ? item.label : index}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  )
}
