import { useEffect, useRef, useState } from 'react'
import { MoreVertical } from 'lucide-react'
import { FilterToggle, type FilterToggleProps } from './FilterToggle'

/** Keyboard-accessible overflow menu for detail header actions. `placement`
 *  positions the popover: "end" (default) seats it under a right-edge trigger,
 *  "start" under a leading (far-left) trigger. */
export function DetailActionsMenu({ label, actions, toggles = [], placement = 'end' }: {
  label: string
  actions: { label: string; onClick: () => void; disabled?: boolean }[]
  toggles?: Pick<FilterToggleProps, 'label' | 'checked' | 'onChange'>[]
  placement?: 'start' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  return (
    <div className={`nw-options${placement === 'end' ? ' nw-options--end' : ''} detail-actions-menu`} ref={rootRef}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
          triggerRef.current?.focus()
        }
      }}
    >
      <button ref={triggerRef} aria-expanded={open} aria-haspopup="menu" aria-label={label}
        className="nw-options__trigger" title="More options" type="button"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) }
        }}
      >
        <MoreVertical aria-hidden="true" className="h-4 w-4" />
      </button>
      {open ? (
        <div className="nw-options__menu" role="menu" aria-label={label} ref={menuRef}
          onKeyDown={(event) => {
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
            const index = items.findIndex((item) => item === document.activeElement)
            const next = event.key === 'ArrowDown' ? (index + 1) % items.length
              : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length
                : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1
            if (next >= 0) { event.preventDefault(); items[next]?.focus() }
          }}
        >
          {actions.map((action) => (
            <button key={action.label} className="nw-options__item" disabled={action.disabled} onClick={() => { setOpen(false); triggerRef.current?.focus(); action.onClick() }} role="menuitem" type="button">{action.label}</button>
          ))}
          {toggles.length ? (
            <div className="app-filter-toggles" role="group">
              {toggles.map((toggle) => (
                <FilterToggle key={toggle.label} {...toggle} role="menuitemcheckbox" onChange={(checked) => {
                  setOpen(false)
                  triggerRef.current?.focus()
                  toggle.onChange(checked)
                }} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
