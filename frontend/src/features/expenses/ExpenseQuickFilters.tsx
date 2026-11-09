import { useId, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

export function ExpenseQuickFilters({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false)
  const id = useId()

  return (
    <div className="expense-quick-filters">
      <div
        id={id}
        aria-label="Filter by category"
        className={`expense-filter-row${expanded ? ' is-expanded' : ''}`}
        role="group"
      >
        {children}
      </div>
      <button
        type="button"
        className="expense-filter-toggle"
        aria-label={expanded ? 'Collapse quick filters' : 'Expand quick filters'}
        title={expanded ? 'Collapse quick filters' : 'Expand quick filters'}
        aria-expanded={expanded}
        aria-controls={id}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
      </button>
    </div>
  )
}
