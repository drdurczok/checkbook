import { useId, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { OutlinedInput } from '../../components/ui/OutlinedField'
import type { ExpenseNameSuggestion } from '../../contracts/expenses'
import '../../styles/features/expense-name-suggestions.css'

interface ExpenseNameInputProps {
  id: string
  value: string
  suggestions: ExpenseNameSuggestion[]
  searching: boolean
  failed: boolean
  onChange: (name: string) => void
  onSelect: (suggestion: ExpenseNameSuggestion) => void
  categoryLabel: (suggestion: ExpenseNameSuggestion) => string
}

export function ExpenseNameInput({ id, value, suggestions, searching, failed, onChange, onSelect, categoryLabel }: ExpenseNameInputProps) {
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const expanded = open && suggestions.length > 0
  const active = expanded && activeIndex < suggestions.length ? activeIndex : -1
  const select = (suggestion: ExpenseNameSuggestion) => {
    onSelect(suggestion)
    setOpen(false)
    setActiveIndex(-1)
    inputRef.current?.focus()
  }

  return (
    <div className="expense-name" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
    }}>
      <OutlinedInput
        id={id}
        ref={inputRef}
        label="Name"
        leadingIcon={<Pencil />}
        required
        autoComplete="off"
        placeholder="Name"
        value={value}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setOpen(true)
          setActiveIndex(-1)
          onChange(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && expanded) {
            event.preventDefault()
            event.stopPropagation()
            setOpen(false)
            setActiveIndex(-1)
          } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && suggestions.length) {
            event.preventDefault()
            setOpen(true)
            const next = event.key === 'ArrowDown'
              ? (active + 1) % suggestions.length
              : (active <= 0 ? suggestions.length - 1 : active - 1)
            setActiveIndex(next)
            document.getElementById(`${listId}-${next}`)?.scrollIntoView?.({ block: 'nearest' })
          } else if (event.key === 'Enter' && active >= 0) {
            event.preventDefault()
            select(suggestions[active])
          }
        }}
      />
      {expanded ? (
        <div className="expense-name__suggestions" id={listId} role="listbox" aria-label="Expense name suggestions">
          {suggestions.map((suggestion, index) => (
            <button
              className="expense-name__suggestion"
              id={`${listId}-${index}`}
              key={`${suggestion.description}-${suggestion.category_id}`}
              type="button"
              role="option"
              aria-selected={active === index}
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(suggestion)}
            >
              <span>{suggestion.description}</span>
              <small>{categoryLabel(suggestion)}</small>
            </button>
          ))}
        </div>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {open && value.trim().length >= 2
          ? searching ? 'Searching expense history.' : failed ? 'History suggestions unavailable. You can still enter an expense.' : `${suggestions.length} matching expense names.`
          : ''}
      </span>
    </div>
  )
}
