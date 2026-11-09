import { useState } from 'react'
import { Checkbox } from '../../components/ui/NativeControls'
import { Modal } from '../../components/Modal'
import { OutlinedInput } from '../../components/ui/OutlinedField'
import type { PlannerSuggestion } from '../../contracts/payday-planner'
import { validPlannerAmount } from './model'

export function SuggestionsPreview({ suggestions, pending, onApply, onClose }: {
  suggestions: PlannerSuggestion[]
  pending: boolean
  onApply: (items: PlannerSuggestion[]) => Promise<void>
  onClose: () => void
}) {
  const [items, setItems] = useState(suggestions)
  const [selected, setSelected] = useState(() => new Set(suggestions.map((item) => item.key)))
  const [error, setError] = useState<string | null>(null)
  const accepted = items.filter((item) => selected.has(item.key))
  return <Modal title="Review suggested payments" onClose={onClose} className="planner-suggestions">
    <div className="planner-dialog__body">
      <p className="muted">Review the reasons, adjust amounts, and uncheck anything to reject it. Applying only adds eligible missing items; completed payments and manual plans are never overwritten. Existing category overlaps are skipped.</p>
      {!items.length ? <p>No new suggestions for this month.</p> : <div className="planner-suggestions__list">{items.map((item, index) => <div className="planner-suggestion" key={item.key}>
        <label className="planner-suggestion__choice"><Checkbox checked={selected.has(item.key)} disabled={pending} onChange={(event) => { const checked = event.target.checked; setSelected((previous) => { const next = new Set(previous); if (checked) next.add(item.key); else next.delete(item.key); return next }) }} /><strong>{item.title}</strong></label>
        <p>{item.reason}</p><small className="muted">{[item.section, item.category_name, item.subcategory_name].filter(Boolean).join(' / ')}</small>
        <OutlinedInput id={`suggestion-amount-${index}`} label={`Amount for ${item.title}`} inputMode="decimal" value={item.amount} disabled={pending || !selected.has(item.key)} aria-invalid={selected.has(item.key) && !validPlannerAmount(item.amount)} onChange={(event) => setItems((previous) => previous.map((entry) => entry.key === item.key ? { ...entry, amount: event.target.value } : entry))} />
      </div>)}</div>}
      {error ? <p role="alert">{error}</p> : null}
      <div className="planner-actions"><button className="button button--ghost" type="button" disabled={pending} onClick={() => setSelected(new Set())}>Reject all</button><button className="button" type="button" disabled={pending || !accepted.length || accepted.some((item) => !validPlannerAmount(item.amount))} onClick={() => { setError(null); void onApply(accepted).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not apply suggestions.')) }}>{pending ? 'Applying...' : `Apply ${accepted.length} selected`}</button></div>
    </div>
  </Modal>
}
