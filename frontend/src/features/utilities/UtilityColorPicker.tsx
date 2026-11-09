import { useEffect, useId, useRef, useState } from 'react'
import { Check } from 'lucide-react'

const colors = [
  { name: 'Blue', value: '#1e6fd6' },
  { name: 'Red', value: '#c43f3f' },
  { name: 'Yellow', value: '#eab308' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Slate', value: '#64748b' },
  { name: 'Green', value: '#12946f' },
  { name: 'Violet', value: '#8b5cf6' },
  { name: 'Ink', value: '#111827' },
]

export function UtilityColorPicker({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const options = colors.some((color) => color.value === value.toLowerCase()) ? colors : [...colors, { name: 'Custom', value }]

  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  return <div className="utility-color-picker" ref={rootRef}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && open) {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }}>
    <button type="button" className="utility-color-picker__trigger" ref={triggerRef}
      aria-label="Contract color" title={`Contract color (${value})`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      style={{ background: value }} onClick={() => setOpen((current) => !current)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) }
      }} />
    {open ? <div id={id} ref={menuRef} className="utility-color-picker__palette" role="menu" aria-label="Contract colors"
      onKeyDown={(event) => {
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        const index = items.findIndex((item) => item === document.activeElement)
        const next = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? (index + 1) % items.length
          : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? (index - 1 + items.length) % items.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1
        if (next >= 0) { event.preventDefault(); items[next]?.focus() }
      }}>
      {options.map((color) => <button key={color.value} type="button" role="menuitemradio" tabIndex={-1}
        className="utility-color-picker__swatch" aria-label={`${color.name} (${color.value})`} title={`${color.name} (${color.value})`}
        aria-checked={color.value.toLowerCase() === value.toLowerCase()} style={{ background: color.value }}
        onClick={() => { onChange(color.value); setOpen(false); triggerRef.current?.focus() }}>
        {color.value.toLowerCase() === value.toLowerCase() ? <Check aria-hidden="true" className="h-4 w-4" /> : null}
      </button>)}
    </div> : null}
  </div>
}
