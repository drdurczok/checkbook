import { useEffect, useRef } from 'react'
import { Repeat2 } from 'lucide-react'
import type { PlannerAllocation } from '../../contracts/payday-planner'

export function AllocationCard({ item, amount, currency, subtitle, pending, onComplete, onEdit }: {
  item: PlannerAllocation
  amount: string
  currency?: string
  subtitle?: string
  pending: boolean
  onComplete: () => void
  onEdit: () => void
}) {
  const press = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressReleaseClick = useRef(false)
  const origin = useRef({ x: 0, y: 0 })
  const cancel = () => { if (press.current !== null) clearTimeout(press.current); press.current = null }
  const cancelGesture = () => { cancel(); suppressReleaseClick.current = true }
  // The held pointer can leave the browser's native long-press selection on the editor text that just appeared beneath it; clear it while opening and again after the editor paints.
  const clearLongPressSelection = () => {
    document.getSelection()?.removeAllRanges()
    requestAnimationFrame(() => requestAnimationFrame(() => document.getSelection()?.removeAllRanges()))
  }
  useEffect(() => () => { if (press.current !== null) clearTimeout(press.current) }, [])
  useEffect(() => { if (pending && press.current !== null) { clearTimeout(press.current); press.current = null; suppressReleaseClick.current = true } }, [pending])
  const symbol = currency ? new Intl.NumberFormat(undefined, { style: 'currency', currency }).formatToParts(0).find((part) => part.type === 'currency')?.value : undefined
  const symbolIndex = symbol ? amount.indexOf(symbol) : -1
  const suffix = symbol && symbolIndex >= 0 ? amount.slice(symbolIndex + symbol.length) : ''
  return <li className={`planner-item${item.completed ? ' planner-item--completed' : ''}`}>
    <div className="planner-item__card" role="button" tabIndex={0} aria-label={`${item.title}, ${amount}${item.completed ? ', completed' : ''}`} aria-disabled={pending} aria-pressed={item.completed} aria-describedby={`allocation-hint-${item.id}`}
      onPointerDown={(event) => { if (event.button !== 0 || pending) return; cancel(); suppressReleaseClick.current = false; origin.current = { x: event.clientX, y: event.clientY }; press.current = setTimeout(() => { suppressReleaseClick.current = true; press.current = null; onEdit(); clearLongPressSelection() }, 500) }}
      onPointerMove={(event) => { if (press.current !== null && Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 10) cancelGesture() }}
      onPointerUp={cancel} onPointerCancel={cancelGesture}
      // Touch pointers fire pointerleave after pointerup, just before the tap's click; leaving after release must not swallow it.
      onPointerLeave={() => { if (press.current !== null) cancelGesture() }}
      onClick={() => { if (suppressReleaseClick.current) { suppressReleaseClick.current = false; return } if (!pending) onComplete() }}
      onContextMenu={(event) => { event.preventDefault(); cancelGesture(); if (!pending) onEdit() }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!pending && !event.repeat) onComplete() }
        else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); if (!pending && !event.repeat) onEdit() }
      }}>
      <span className="planner-item__name"><strong className="planner-item__title">{item.title}{item.template_id ? <Repeat2 className="planner-item__recurring" size={15} aria-label="Repeats every month" /> : null}</strong>{subtitle ? <span className="planner-item__category">{subtitle}</span> : null}</span><strong className="planner-item__amount">{symbol && symbolIndex >= 0 ? <>{amount.slice(0, symbolIndex)}<span className="planner-item__currency">{symbol}</span>{suffix && !/^\s/.test(suffix) ? ' ' : ''}{suffix}</> : amount}</strong>
    </div>
    <span className="planner-item__hint" id={`allocation-hint-${item.id}`}>Press to toggle completion. Hold, right click, or press Shift+F10 to edit.</span>
  </li>
}
