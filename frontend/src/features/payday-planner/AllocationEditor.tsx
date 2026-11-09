import { useEffect, useId, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Decimal from 'decimal.js'
import { CalendarDays, ChevronDown, Coins, Folder, Landmark, Layers, ListOrdered, Pencil, Plus, Repeat, StickyNote, Tags, Trash2, Wallet } from 'lucide-react'
import { FormSheet } from '../../components/ui/FormSheet'
import { OutlinedInput, OutlinedNativeSelect, OutlinedTextarea } from '../../components/ui/OutlinedField'
import type { AllocationInput, AllocationKind } from '../../contracts/payday-planner'
import { api } from '../../lib/api'
import { plannerMoney, validPlannerAmount } from './model'

const SECTION_OPTIONS = [
  { key: 'mandatory', label: 'Mandatory payment', icon: Landmark },
  { key: 'monthly', label: 'Additional payment', icon: CalendarDays },
  { key: 'flexible', label: 'Flexible allocation', icon: Wallet },
] as const

export function AllocationEditor({ initial, token, title, existing = false, allocationSelection = false, initialRecurring = false, allowOrphanSnapshot = false, pending, onSave, onDelete, onClose, month, currency }: {
  initial: AllocationInput & { category_name?: string | null; subcategory_name?: string | null; expense_group_name?: string | null }
  token: string
  title: string
  existing?: boolean
  allocationSelection?: boolean
  initialRecurring?: boolean
  allowOrphanSnapshot?: boolean
  pending: boolean
  onSave: (value: AllocationInput) => Promise<void>
  onDelete?: () => void
  onClose: () => void
  month?: string
  currency?: string
}) {
  const id = useId()
  const [draftState, setDraft] = useState(initial)
  const [saved, setSaved] = useState(initial)
  const [position, setPosition] = useState(String(initial.position ?? 0))
  const validPosition = /^\d+$/.test(position) && Number(position) <= 2147483647
  const [recurring, setRecurring] = useState(initialRecurring)
  const [savingRecurring, setSavingRecurring] = useState(false)
  const [aliasOverride, setAliasOverride] = useState<string | null | undefined>(undefined)
  const [editingName, setEditingName] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notesVisible, setNotesVisible] = useState(Boolean(initial.notes))
  const [sectionMenuOpen, setSectionMenuOpen] = useState(false)
  const sectionMenuRef = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    if (!sectionMenuOpen) return
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && sectionMenuRef.current?.contains(event.target)) return
      setSectionMenuOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [sectionMenuOpen])
  const validMonth = month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : undefined
  const monthEnd = validMonth ? new Date(Date.UTC(Number(validMonth.slice(0, 4)), Number(validMonth.slice(5)), 0)).toISOString().slice(0, 10) : undefined
  const board = useQuery({ queryKey: ['planner-expense-categories', token, validMonth], queryFn: () => api.getExpensesBoard(token, validMonth ? { start_date: `${validMonth}-01`, end_date: monthEnd } : undefined) })
  const detail = useQuery({ queryKey: ['planner-expense-category', token, draftState.category_id], queryFn: () => api.getExpenseCategoryDetail(token, draftState.category_id ?? ''), enabled: Boolean(draftState.category_id) })
  const categories = board.data?.categories.filter((category) => !category.is_retired && !category.parent_id && !category.utility_property_id) ?? []
  const initialCategory = board.data?.categories.find((category) => category.id === draftState.category_id)
  const [group, setGroup] = useState<string | null>(null)
  const orphanCategoryName = allowOrphanSnapshot && existing && !initial.category_id ? initial.category_name : null
  const selectedGroup = group ?? (orphanCategoryName ? '' : initial.expense_group_id ?? initialCategory?.expense_group_id ?? '')
  const automaticNameFor = (categoryId: string | null | undefined, groupId: string) => (!categoryId && !groupId && group === null ? orphanCategoryName : null)
    ?? board.data?.categories.find((category) => category.id === categoryId)?.name
    ?? (categoryId && categoryId === initial.category_id ? initial.category_name : undefined)
    ?? board.data?.groups.find((item) => item.id === groupId)?.name
    ?? (groupId && groupId === initial.expense_group_id ? initial.expense_group_name : undefined) ?? ''
  const initialAutomaticName = orphanCategoryName ?? automaticNameFor(initial.category_id, initial.expense_group_id ?? '')
  const alias = aliasOverride === undefined ? (initial.title && initial.title !== initialAutomaticName ? initial.title : null) : aliasOverride
  const automaticName = automaticNameFor(draftState.category_id, selectedGroup)
  const draft = { ...draftState, position: Number(position), expense_group_id: selectedGroup || null, title: alias ?? automaticName }
  const preservesOrphanSnapshot = (value: AllocationInput) => allowOrphanSnapshot && existing && !initial.category_id && Boolean(initial.category_name || initial.expense_group_name) && !value.category_id && !value.expense_group_id && !value.subcategory_id && value.section === initial.section && value.kind === initial.kind
  const categoryRequired = draft.section !== 'flexible' && !draft.expense_group_id && !preservesOrphanSnapshot(draft)
  const visibleCategories = categories.filter((category) => (category.expense_group_id ?? '') === selectedGroup)
  const hasCostSelection = Boolean(selectedGroup || draftState.category_id || draft.subcategory_id)
  const costValues = draft.subcategory_id
    ? detail.data?.entries?.filter((entry) => entry.subcategory_id === draft.subcategory_id && Boolean(entry.entry_date) && entry.entry_date?.slice(0, 7) === validMonth).map((entry) => entry.amount)
    : board.data?.monthly_totals.filter((point) => point.period.slice(0, 7) === validMonth && (draftState.category_id
      ? point.category_id === draftState.category_id
      : board.data.categories.some((category) => category.id === point.category_id && category.expense_group_id === selectedGroup))).map((point) => point.value)
  const costAvailable = validMonth && !board.isPending && !board.error && (!draft.subcategory_id || (!detail.isPending && !detail.error)) && costValues?.length
  const cost = costAvailable && costValues ? costValues.reduce((sum, value) => sum.plus(value), new Decimal(0)).toFixed(2) : null
  const save = async (value: AllocationInput, recurringValue = recurring) => {
    if (!validPosition) {
      setError('Enter a whole-number position between 0 and 2147483647.')
      return false
    }
    const positioned = { ...value, position: Number(position) }
    const payload = allocationSelection ? { ...positioned, recurring: recurringValue } : positioned
    if (!value.title.trim() || !validPlannerAmount(value.amount)) {
      setError('Enter a name and a non-negative amount with at most two decimal places.')
      return false
    }
    if (value.section !== 'flexible' && !value.category_id && !value.expense_group_id && !preservesOrphanSnapshot(value)) {
      setError('Choose a category or group before saving this payment. Your draft is retained.')
      return false
    }
    setError(null)
    try {
      await onSave(payload)
      setSaved(value)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save. Your draft is retained.')
      return false
    }
  }
  const update = (patch: Partial<AllocationInput>, immediate = false, groupId = selectedGroup) => {
    const next = { ...draft, ...patch, expense_group_id: groupId || null }
    if (alias === null) next.title = automaticNameFor(next.category_id, groupId)
    setDraft(next)
    if (existing && immediate) void save(next)
  }
  const autosave = () => {
    if (existing && JSON.stringify(draft) !== JSON.stringify(saved)) void save(draft)
  }
  const activeSection = SECTION_OPTIONS.find((item) => item.key === draft.section) ?? SECTION_OPTIONS[0]
  return <FormSheet eyebrow={allocationSelection ? title : undefined} title={allocationSelection ? (
    <span className="record-add-kind" ref={sectionMenuRef} onKeyDown={(event) => {
      if (event.key === 'Escape' && sectionMenuOpen) {
        event.preventDefault()
        event.stopPropagation()
        setSectionMenuOpen(false)
        sectionMenuRef.current?.querySelector('button')?.focus()
      }
    }}>
      <button aria-expanded={sectionMenuOpen} aria-haspopup="listbox" className="record-add-kind-toggle" type="button" disabled={pending} onClick={() => setSectionMenuOpen((value) => !value)}>
        {activeSection.label}
        <ChevronDown aria-hidden="true" className="h-4 w-4" />
      </button>
      {sectionMenuOpen ? (
        <div aria-label="Allocation section" className="record-add-kind-menu" role="listbox">
          {SECTION_OPTIONS.map((item) => (
            <button aria-selected={draft.section === item.key} className={draft.section === item.key ? 'is-active' : ''} key={item.key} type="button" role="option" disabled={pending} onClick={() => { setSectionMenuOpen(false); sectionMenuRef.current?.querySelector('button')?.focus(); update({ section: item.key }, true) }}>
              <item.icon aria-hidden="true" className="h-4 w-4" />
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  ) : title} onClose={onClose} className="record-add-modal quick-add-modal planner-allocation-editor" leading={<div className="record-add-icon" aria-hidden="true"><Layers className="h-5 w-5" /></div>}>
    <form className="planner-form quick-add-form" onSubmit={(event) => { event.preventDefault(); void save(draft) }}>
      <fieldset disabled={pending} className="planner-form__fields form-grid">
        <OutlinedInput id={`${id}-title`} label="Name" leadingIcon={<Pencil />} className={alias === null && !editingName ? 'planner-name--automatic' : undefined} value={draft.title} onFocus={() => setEditingName(true)} onChange={(event) => setAliasOverride(event.target.value)} onBlur={() => {
          setEditingName(false)
          const next = { ...draft, title: draft.title.trim() ? draft.title : automaticName }
          if (!draft.title.trim()) setAliasOverride(null)
          if (existing && JSON.stringify(next) !== JSON.stringify(saved)) void save(next)
        }} required />
        <OutlinedInput id={`${id}-amount`} label="Amount" leadingIcon={<Coins />} inputMode="decimal" value={draft.amount} onChange={(event) => update({ amount: event.target.value })} onBlur={autosave} aria-invalid={!validPlannerAmount(draft.amount)} required />
        {hasCostSelection ? <p className="planner-form__suggestion muted" role="status" aria-label="Suggested amount">{cost !== null && currency ? plannerMoney(cost, currency) : 'Suggestion unavailable'}</p> : null}
        <OutlinedInput id={`${id}-position`} label="Position" leadingIcon={<ListOrdered />} type="number" inputMode="numeric" min={0} max={2147483647} step={1} value={position} onChange={(event) => setPosition(event.target.value)} onBlur={autosave} error={!validPosition ? 'Use a whole number from 0 to 2147483647.' : undefined} hint="Lower numbers appear first within each payment section." required />
        <OutlinedNativeSelect id={`${id}-kind`} label="Type" leadingIcon={<Layers />} value={draft.kind} onChange={(event) => update({ kind: event.target.value as AllocationKind }, true)}>
          <option value="expense">Expense</option><option value="savings">Savings</option><option value="transfer">Transfer</option><option value="other">Other</option>
        </OutlinedNativeSelect>
        <div className="record-add-pair">
        <OutlinedNativeSelect id={`${id}-group`} label="Category" leadingIcon={<Tags />} value={selectedGroup} onChange={(event) => { setGroup(event.target.value); setError(null); update({ category_id: null, subcategory_id: null }, Boolean(event.target.value), event.target.value) }}>
          {selectedGroup && !board.data?.groups.some((item) => item.id === selectedGroup && !item.is_retired) ? <option value={selectedGroup}>{board.data?.groups.find((item) => item.id === selectedGroup)?.name ?? 'Existing group'} (unavailable)</option> : null}
          <option value="">Uncategorized</option>{board.data?.groups.filter((item) => !item.is_retired).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </OutlinedNativeSelect>
        <OutlinedNativeSelect id={`${id}-category`} label="Group" leadingIcon={<Folder />} required={categoryRequired} value={draftState.category_id ?? ''} onChange={(event) => update({ category_id: event.target.value || null, subcategory_id: null }, true)}>
          <option value="">{preservesOrphanSnapshot(draft) ? `${initial.category_name || initial.expense_group_name} (deleted; snapshot retained)` : 'Choose group'}</option>
          {draftState.category_id && !visibleCategories.some((category) => category.id === draftState.category_id) ? <option value={draftState.category_id}>{initialCategory?.name ?? (draftState.category_id === initial.category_id ? initial.category_name : null) ?? 'Existing category'} (unavailable)</option> : null}
          {visibleCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        </OutlinedNativeSelect>
        </div>
        {notesVisible ? <OutlinedTextarea id={`${id}-notes`} label="Notes" leadingIcon={<StickyNote />} value={draft.notes} onChange={(event) => update({ notes: event.target.value })} onBlur={autosave} />
          : <div className="record-add-notes-toggle-row"><button type="button" aria-controls={`${id}-notes`} aria-expanded={false} className="record-add-notes-toggle" onClick={() => setNotesVisible(true)}><Plus aria-hidden="true" className="h-4 w-4" />Add notes</button></div>}
      </fieldset>
      {board.error || detail.error ? <p role="alert">Could not load category choices. Existing selection is retained.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {pending ? <div role="status" className="muted">Saving...</div> : null}
      <div className="planner-form__actions quick-add-actions">
        {existing && onDelete ? <button className="button button--ghost planner-delete" type="button" aria-label="Delete allocation" title="Delete allocation" disabled={pending} onClick={onDelete}><Trash2 size={18} aria-hidden="true" /></button> : null}
        {!existing ? <button className="button" disabled={pending} type="submit">Create</button> : <button className="button button--ghost" type="button" disabled={pending} onClick={() => { if (JSON.stringify(draft) === JSON.stringify(saved)) onClose(); else void save(draft).then((success) => { if (success) onClose() }) }}>Done</button>}
        {allocationSelection ? <button className={`planner-recurring-toggle${recurring ? ' is-active' : ''}`} type="button" aria-label="Repeat every month" title="Repeat every month" aria-pressed={recurring} disabled={pending || savingRecurring} onClick={() => {
          const previous = recurring
          const next = !previous
          setRecurring(next)
          if (existing) {
            setSavingRecurring(true)
            void save(draft, next).then((success) => { if (!success) setRecurring(previous) }).finally(() => setSavingRecurring(false))
          }
        }}><Repeat aria-hidden="true" className="h-4 w-4" /></button> : null}
      </div>
    </form>
  </FormSheet>
}
