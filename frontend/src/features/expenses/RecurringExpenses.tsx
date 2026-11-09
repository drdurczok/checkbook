import { useId, useState } from 'react'
import { Calendar, Coins, Folder, Pencil, Repeat, StickyNote, Users } from 'lucide-react'
import { DetailActionsMenu } from '../../components/DetailActionsMenu'
import { Modal } from '../../components/Modal'
import { SectionPanel } from '../../components/panel'
import { AsyncState } from '../../components/ui/AsyncState'
import { Button } from '../../components/ui/Button'
import { FormSheet } from '../../components/ui/FormSheet'
import { OutlinedInput, OutlinedNativeSelect, OutlinedTextarea } from '../../components/ui/OutlinedField'
import type { ExpenseCategorySummary, RecurringExpense, RecurringExpensePayload } from '../../contracts/expenses'
import { fmtMoney, formatAmountDraft, parseAmountDraft } from '../../lib/format'
import { useSession } from '../../lib/session'
import { expenseCadences, recurringTotals } from './recurring'
import { useRecurringExpenses } from './useRecurringExpenses'
import '../../styles/features/recurring-expenses.css'

export function RecurringExpenses({ categories, showRetired = false, matchesFilter }: {
  categories: ExpenseCategorySummary[]
  showRetired?: boolean
  /** Restricts the card totals and the management list to schedules the page
      filter accepts; omit it to show every schedule. */
  matchesFilter?: (schedule: RecurringExpense) => boolean
}) {
  const { token, currency } = useSession()
  const { query, mutation } = useRecurringExpenses(token ?? '')
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<RecurringExpense | null>(null)
  const schedules = (query.data ?? []).filter((schedule) => !matchesFilter || matchesFilter(schedule))
  const totals = recurringTotals(schedules)
  const visible = schedules.filter((schedule) => showRetired || schedule.is_active)
  const error = mutation.error instanceof Error ? mutation.error.message : null

  return <>
    <SectionPanel title="Recurring expenses">
      <AsyncState loading={query.isPending} error={query.error?.message} empty={false} emptyTitle="" emptyBody="">
        <button className="recurring-expenses-card" onClick={() => { mutation.reset(); setOpen(true) }} type="button" aria-label="Manage recurring expenses">
          <span><Repeat aria-hidden="true" className="h-5 w-5" /><strong>{totals.count} upcoming</strong></span>
          <strong>{fmtMoney(totals.monthly, currency)}</strong>
        </button>
      </AsyncState>
    </SectionPanel>
    {open && !editing ? <Modal title="Recurring expenses" onClose={() => setOpen(false)} className="recurring-expenses-modal">
      {error ? <p role="alert">{error}</p> : null}
      <AsyncState loading={query.isPending} error={query.error?.message} empty={!visible.length} emptyTitle="No recurring expenses" emptyBody="Choose Recurring expense in Add record to create a schedule.">
        <ul className="recurring-expenses-list">
          {visible.toSorted((a, b) => (a.next_due_date ?? '9999').localeCompare(b.next_due_date ?? '9999')).map((schedule) => <li key={schedule.id}>
            <div><strong>{schedule.description}</strong><small>{schedule.category_name} · {expenseCadences.find((item) => item.value === schedule.cadence)?.label}{!schedule.is_active ? ' · Retired' : ''}</small><small>{schedule.next_due_date ? `Next: ${schedule.next_due_date}` : 'No upcoming payment'}</small></div>
            <strong>{fmtMoney(schedule.amount, currency)}</strong>
            <DetailActionsMenu label={`Options for ${schedule.description}`} actions={[
              { label: 'Edit', onClick: () => { mutation.reset(); setEditing(schedule) }, disabled: mutation.isPending || !schedule.is_active },
              { label: 'Expense now', onClick: () => mutation.mutate({ kind: 'now', id: schedule.id }), disabled: mutation.isPending || !schedule.is_active || !schedule.next_due_date },
              { label: 'Retire', onClick: () => mutation.mutate({ kind: 'retire', id: schedule.id }), disabled: mutation.isPending || !schedule.is_active },
            ]} />
          </li>)}
        </ul>
      </AsyncState>
    </Modal> : null}
    {editing ? <RecurringExpenseEditor schedule={editing} categories={categories} currency={currency} busy={mutation.isPending} error={error} onClose={() => setEditing(null)} onSave={async (payload) => { await mutation.mutateAsync({ kind: 'edit', id: editing.id, payload }); setEditing(null) }} /> : null}
  </>
}

function RecurringExpenseEditor({ schedule, categories, currency, busy, error, onClose, onSave }: {
  schedule: RecurringExpense
  categories: ExpenseCategorySummary[]
  currency: string
  busy: boolean
  error: string | null
  onClose: () => void
  onSave: (payload: RecurringExpensePayload) => Promise<void>
}) {
  const id = useId()
  const [draft, setDraft] = useState<RecurringExpensePayload>({ description: schedule.description, amount: schedule.amount, start_date: schedule.start_date, end_date: schedule.end_date, cadence: schedule.cadence, owner_scope: schedule.owner_scope, category_name: schedule.category_name, notes: schedule.notes })
  const [amount, setAmount] = useState(String(schedule.amount))
  const [validation, setValidation] = useState<string | null>(null)
  const groups = categories.filter((category) => !category.parent_id && !category.is_retired)
  return <FormSheet title="Edit recurring expense" onClose={onClose} className="quick-add-modal">
    <form className="record-add-form" onSubmit={(event) => {
      event.preventDefault()
      if (!(Number(amount) > 0) || !Number.isFinite(Number(amount))) { setValidation('Enter an amount greater than zero.'); return }
      if (draft.end_date && draft.end_date < draft.start_date) { setValidation('End date must be on or after the start date.'); return }
      setValidation(null)
      void onSave({ ...draft, amount: Number(amount) }).catch(() => { /* Mutation error is displayed in the form. */ })
    }}>
      <OutlinedInput id={`${id}-name`} label="Name" leadingIcon={<Pencil />} required value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
      <OutlinedInput id={`${id}-amount`} label="Amount" leadingIcon={<Coins />} required inputMode="decimal" value={formatAmountDraft(amount)} onChange={(event) => setAmount(parseAmountDraft(event.target.value))} />
      <div className="record-add-pair">
        <OutlinedInput id={`${id}-start`} label="Start" leadingIcon={<Calendar />} required type="date" value={draft.start_date} onChange={(event) => setDraft({ ...draft, start_date: event.target.value })} />
        <OutlinedInput id={`${id}-end`} label="End (optional)" leadingIcon={<Calendar />} type="date" min={draft.start_date} value={draft.end_date ?? ''} onChange={(event) => setDraft({ ...draft, end_date: event.target.value || null })} />
      </div>
      <OutlinedNativeSelect id={`${id}-cadence`} label="Frequency" leadingIcon={<Repeat />} value={draft.cadence ?? 'monthly'} onChange={(event) => { const cadence = expenseCadences.find((item) => item.value === event.target.value)?.value; if (cadence) setDraft({ ...draft, cadence }) }}>
        {expenseCadences.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </OutlinedNativeSelect>
      <OutlinedNativeSelect id={`${id}-group`} label="Group" leadingIcon={<Folder />} value={draft.category_name} onChange={(event) => setDraft({ ...draft, category_name: event.target.value })}>
        {!groups.some((group) => group.name === draft.category_name) ? <option value={draft.category_name}>{draft.category_name}</option> : null}
        {groups.map((group) => <option key={group.id} value={group.name}>{group.name}</option>)}
      </OutlinedNativeSelect>
      <OutlinedNativeSelect id={`${id}-owner`} label="Owner" leadingIcon={<Users />} value={draft.owner_scope} onChange={(event) => { const owner = event.target.value; if (owner === 'self' || owner === 'joint' || owner === 'spouse') setDraft({ ...draft, owner_scope: owner }) }}>
        <option value="joint">Joint</option><option value="self">Self</option><option value="spouse">Spouse</option>
      </OutlinedNativeSelect>
      <OutlinedTextarea id={`${id}-notes`} label="Notes" leadingIcon={<StickyNote />} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
      <section className="recurring-price-history" aria-label="Price history"><h3>Price history</h3>
        {schedule.price_history.length ? <ul>{schedule.price_history.map((price, index) => <li key={`${price.changed_at}-${index}`}><time dateTime={price.changed_at}>{price.changed_at.slice(0, 10)}</time><strong>{fmtMoney(price.amount, currency)}</strong></li>)}</ul> : <p>No price changes recorded.</p>}
      </section>
      {validation || error ? <p role="alert">{validation || error}</p> : null}
      <Button busy={busy} busyLabel="Saving..." type="submit">Save changes</Button>
    </form>
  </FormSheet>
}
