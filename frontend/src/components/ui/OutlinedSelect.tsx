import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { OutlinedField } from './OutlinedField'

export interface OutlinedSelectOption {
  value: string
  label: string
  secondary?: string
  icon?: ReactNode
}

export interface OutlinedSelectProps {
  id: string
  label: string
  value: string
  options: readonly OutlinedSelectOption[]
  leadingIcon?: ReactNode
  onChange: (value: string) => void
  hint?: ReactNode
  error?: ReactNode
  disabled?: boolean
  className?: string
}

interface MenuPlacement {
  above: boolean
  left: number
  width: number
  maxHeight: number
}

export function OutlinedSelect({
  id,
  label,
  value,
  options,
  leadingIcon,
  onChange,
  hint,
  error,
  disabled = false,
  className = '',
}: OutlinedSelectProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [placement, setPlacement] = useState<MenuPlacement | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef({ text: '', time: 0 })
  const selectedIndex = options.findIndex((option) => option.value === value)
  const selected = options[selectedIndex]
  const isOpen = open && !disabled
  const menuReady = placement !== null
  const menuId = `${id}-listbox`
  const valueId = `${id}-value`
  const optionId = (index: number) => `${id}-option-${index}`

  if (disabled && open) setOpen(false)

  useEffect(() => {
    if (!isOpen) return
    const closeOutside = (event: PointerEvent) => {
      const field = triggerRef.current?.closest('.outlined-field')
      if (event.target instanceof Node && field?.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    let frame = 0
    const measure = () => {
      const shell = triggerRef.current?.closest('.outlined-field__shell')
      const menu = menuRef.current
      if (!shell || !menu) return
      const rect = shell.getBoundingClientRect()
      const viewport = window.visualViewport
      const viewportTop = viewport?.offsetTop ?? 0
      const viewportLeft = viewport?.offsetLeft ?? 0
      const viewportHeight = viewport?.height ?? window.innerHeight
      const viewportWidth = viewport?.width ?? window.innerWidth
      const margin = 8
      const gap = 6
      if (rect.bottom < viewportTop || rect.top > viewportTop + viewportHeight) {
        setOpen(false)
        return
      }
      const below = Math.max(0, viewportTop + viewportHeight - rect.bottom - margin - gap)
      const above = Math.max(0, rect.top - viewportTop - margin - gap)
      const desiredHeight = Math.min(320, menu.scrollHeight || 320)
      const placeAbove = below < desiredHeight && above > below
      const width = Math.min(rect.width, Math.max(0, viewportWidth - margin * 2))
      const left = Math.max(viewportLeft + margin, Math.min(rect.left, viewportLeft + viewportWidth - margin - width))
      setPlacement({
        above: placeAbove,
        left: left - rect.left,
        width,
        maxHeight: Math.min(320, placeAbove ? above : below),
      })
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    schedule()
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
    }
  }, [isOpen, options])

  useEffect(() => {
    if (!isOpen || !menuReady || activeIndex < 0) return
    const frame = requestAnimationFrame(() => {
      const menu = menuRef.current
      const option = menu?.children.item(activeIndex)
      if (!menu || !(option instanceof HTMLElement)) return
      // Scroll only the listbox, not the page or the containing modal.
      if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop
      else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight) {
        menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [activeIndex, isOpen, menuReady])

  const openMenu = (index = selectedIndex >= 0 ? selectedIndex : 0) => {
    setPlacement(null)
    setActiveIndex(options.length ? index : -1)
    searchRef.current = { text: '', time: 0 }
    setOpen(true)
  }

  const selectOption = (index: number) => {
    const option = options[index]
    if (!option) return
    onChange(option.value)
    setOpen(false)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault()
        const direction = event.key === 'ArrowDown' ? 1 : -1
        if (!isOpen) openMenu(selectedIndex >= 0 ? selectedIndex : direction > 0 ? 0 : options.length - 1)
        else setActiveIndex((current) => options.length ? (current + direction + options.length) % options.length : -1)
        return
      }
      case 'Home':
      case 'End': {
        event.preventDefault()
        const index = event.key === 'Home' ? 0 : options.length - 1
        if (!isOpen) openMenu(index)
        else setActiveIndex(options.length ? index : -1)
        return
      }
      case 'Enter':
      case ' ':
        event.preventDefault()
        if (isOpen) selectOption(activeIndex)
        else openMenu()
        return
      case 'Escape':
        if (isOpen) {
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
        }
        return
      case 'Tab':
        setOpen(false)
        return
    }
    if (event.key.length !== 1 || event.altKey || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    const now = Date.now()
    const previous = isOpen && now - searchRef.current.time < 700 ? searchRef.current.text : ''
    const text = previous + event.key.toLocaleLowerCase()
    searchRef.current = { text, time: now }
    const repeated = [...text].every((character) => character === text[0])
    const query = repeated ? text[0] : text
    const start = isOpen ? activeIndex : selectedIndex
    for (let offset = repeated ? 1 : 0; offset < options.length + (repeated ? 1 : 0); offset += 1) {
      const index = (Math.max(start, repeated ? -1 : 0) + offset) % options.length
      if (options[index].label.toLocaleLowerCase().startsWith(query)) {
        if (!isOpen) {
          setPlacement(null)
          setOpen(true)
        }
        setActiveIndex(index)
        break
      }
    }
  }

  return (
    <OutlinedField
      className={`outlined-select${className ? ` ${className}` : ''}`}
      disabled={disabled}
      error={error}
      hasValue={value !== ''}
      hint={hint}
      id={id}
      label={label}
      leadingIcon={leadingIcon}
    >
      {(controlProps) => (
        <>
          <button
            {...controlProps}
            aria-activedescendant={isOpen && options[activeIndex] ? optionId(activeIndex) : undefined}
            aria-controls={isOpen ? menuId : undefined}
            aria-expanded={isOpen}
            aria-haspopup="listbox"
            aria-labelledby={value === '' ? `${id}-label` : `${id}-label ${valueId}`}
            className="outlined-field__input outlined-select__trigger"
            onBlur={() => setOpen(false)}
            onClick={() => isOpen ? setOpen(false) : openMenu()}
            onKeyDown={handleKeyDown}
            ref={triggerRef}
            role="combobox"
            type="button"
          >
            <span className={`outlined-select__trigger-meta${value === '' ? ' is-placeholder' : ''}`}>
              <span id={valueId}>{value === '' ? label : selected?.label ?? value}</span>
              {value !== '' && selected?.secondary ? <small>{selected.secondary}</small> : null}
            </span>
            <ChevronDown aria-hidden="true" className="outlined-select__chevron" />
          </button>
          {isOpen ? (
            <div
              aria-labelledby={`${id}-label`}
              className={`outlined-select__menu${placement?.above ? ' is-above' : ''}`}
              id={menuId}
              ref={menuRef}
              role="listbox"
              style={placement ? { left: placement.left, width: placement.width, maxHeight: placement.maxHeight } : { visibility: 'hidden' }}
            >
              {options.map((option, index) => (
                <div
                  aria-label={option.secondary ? `${option.label} ${option.secondary}` : option.label}
                  aria-selected={option.value === value}
                  className={`outlined-select__option${option.value === value ? ' is-active' : ''}${index === activeIndex ? ' is-highlighted' : ''}`}
                  id={optionId(index)}
                  key={option.value}
                  onClick={() => selectOption(index)}
                  onPointerDown={(event) => event.preventDefault()}
                  onPointerMove={() => setActiveIndex(index)}
                  role="option"
                >
                  <span className="outlined-select__option-meta">
                    <span aria-hidden="true">{option.icon}</span>
                    <span>{option.label}</span>
                    {option.secondary ? <small>{option.secondary}</small> : null}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </OutlinedField>
  )
}
