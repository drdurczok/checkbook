import { useCallback, useEffect, useRef } from 'react'
import { Link2 } from 'lucide-react'
import { fmtMoney } from '../../lib/format'
import type { ExpenseEntry } from '../../types'

export function ExpenseHistoryRow({ entry, title, currency, selected, selectionMode, onOpen, onSelect }: {
  entry: ExpenseEntry
  title: string
  currency: string
  selected: boolean
  selectionMode: boolean
  onOpen: () => void
  onSelect: () => void
}) {
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  const suppressClick = useRef(false)
  const readOnly = entry.data_source === 'loan_schedule' || entry.data_source === 'utility_bill'
  const cancelPress = useCallback(() => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }, [])
  useEffect(() => {
    window.addEventListener('scroll', cancelPress, true)
    return () => {
      cancelPress()
      window.removeEventListener('scroll', cancelPress, true)
    }
  }, [cancelPress])

  return (
    <button
      className={'entry-row' + (selected ? ' is-selected' : '')}
      type="button"
      aria-pressed={selectionMode ? selected : undefined}
      aria-haspopup={selectionMode ? undefined : 'dialog'}
      disabled={selectionMode && readOnly}
      onPointerDown={(event) => {
        cancelPress()
        suppressClick.current = false
        if (event.button !== 0 || !event.isPrimary || readOnly || selectionMode) return
        press.current = {
          x: event.clientX, y: event.clientY,
          timer: setTimeout(() => {
            press.current = null
            suppressClick.current = true
            onSelect()
          }, 500),
        }
      }}
      onPointerMove={(event) => {
        if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 10) {
          suppressClick.current = true
          cancelPress()
        }
      }}
      onPointerUp={cancelPress}
      onPointerCancel={() => { suppressClick.current = true; cancelPress() }}
      onPointerLeave={cancelPress}
      onContextMenu={(event) => {
        if (readOnly) return
        event.preventDefault()
        cancelPress()
        if (!suppressClick.current) onSelect()
        suppressClick.current = true
      }}
      onKeyDown={(event) => {
        if (event.key === ' ' && event.shiftKey && !readOnly) {
          event.preventDefault()
          if (!event.repeat) onSelect()
        }
      }}
      onClick={() => {
        if (suppressClick.current) { suppressClick.current = false; return }
        if (selectionMode) onSelect()
        else onOpen()
      }}
    >
      <span className="entry-name">{title}{readOnly ? <Link2 aria-label="Inherited from a source" role="img" className="expense-inherited-icon"><title>Inherited from a source</title></Link2> : null}</span>
      <strong className="entry-amount">{fmtMoney(entry.amount, currency)}</strong>
      <span className="entry-meta">
        {entry.entry_date ? <time dateTime={entry.entry_date}>{new Date(entry.entry_date + 'T00:00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}</time> : 'No date'}
        {entry.owner_scope !== 'joint' ? <span className="entry-owner">{entry.owner_scope === 'spouse' ? 'Spouse' : 'Self'}</span> : null}
        {entry.notes ? <span className="entry-note">{entry.notes}</span> : null}
      </span>
    </button>
  )
}
