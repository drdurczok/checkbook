import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { OutlinedInput, OutlinedNativeSelect, OutlinedTextarea } from '../../components/ui/OutlinedField'
import { Button } from '../../components/ui/Button'
import type { LoanSummary } from '../../contracts/dashboard'
import type { AssetSummary } from '../../contracts/assets'
import type { LoanUpdatePayload } from '../../contracts/loans'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'

export function LoanEditor({ loan, properties, onSaved, onCancel }: {
  loan: LoanSummary
  properties: AssetSummary[]
  onSaved: (loan: LoanSummary) => void
  onCancel: () => void
}) {
  const id = useId()
  const { token, setMessage } = useSession()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState(() => ({
    name: loan.name,
    interest_rate: String(loan.interest_rate),
    original_balance: loan.original_balance == null ? '' : String(loan.original_balance),
    start_date: loan.start_date ?? '',
    end_date: loan.end_date ?? '',
    notes: loan.notes ?? '',
    linked_property_id: loan.linked_property_id ?? '',
  }))
  const update = (key: keyof typeof draft, value: string) => setDraft((current) => ({ ...current, [key]: value }))
  const mutation = useMutation({
    mutationFn: (payload: LoanUpdatePayload) => api.updateLoan(token, loan.id, payload),
    onSuccess: (updated) => {
      onSaved(updated)
      setMessage('Loan updated.')
      for (const queryKey of [['overview'], ['properties'], ['loans'], ['expenses'], ['planning']]) {
        void queryClient.invalidateQueries({ queryKey })
      }
    },
  })

  return (
    <form className="loan-editor" aria-label="Edit loan" onSubmit={(event) => {
      event.preventDefault()
      mutation.mutate({
        ...draft,
        name: draft.name.trim(),
        interest_rate: Number(draft.interest_rate),
        original_balance: draft.original_balance === '' ? null : Number(draft.original_balance),
        start_date: draft.start_date || null,
        end_date: draft.end_date || null,
        linked_property_id: draft.linked_property_id || null,
      })
    }}>
      <OutlinedInput id={`${id}-name`} label="Loan name" value={draft.name} required autoFocus disabled={mutation.isPending} onChange={(event) => update('name', event.target.value)} />
      <OutlinedNativeSelect id={`${id}-property`} label="Linked property" value={draft.linked_property_id} disabled={mutation.isPending} onChange={(event) => update('linked_property_id', event.target.value)}>
        <option value="">No linked property</option>
        {loan.linked_property_id && !properties.some((property) => property.id === loan.linked_property_id) ? <option value={loan.linked_property_id}>Current linked property</option> : null}
        {properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
      </OutlinedNativeSelect>
      <div className="loan-editor__grid">
        {([
          ['original_balance', 'Original balance', false],
          ['interest_rate', 'Interest rate', true],
        ] as const).map(([key, label, required]) => (
          <OutlinedInput key={key} id={`${id}-${key}`} label={label} type="number" min="0" step="any" required={required} value={draft[key]} disabled={mutation.isPending} onChange={(event) => update(key, event.target.value)} />
        ))}
        <OutlinedInput id={`${id}-start`} label="Start date" type="date" value={draft.start_date} disabled={mutation.isPending} onChange={(event) => update('start_date', event.target.value)} />
        <OutlinedInput id={`${id}-end`} label="End date" type="date" min={draft.start_date || undefined} value={draft.end_date} disabled={mutation.isPending} onChange={(event) => update('end_date', event.target.value)} />
      </div>
      <OutlinedTextarea id={`${id}-notes`} label="Notes" rows={3} value={draft.notes} disabled={mutation.isPending} onChange={(event) => update('notes', event.target.value)} />
      {mutation.isError ? <p className="loan-editor__error" role="alert">{mutation.error instanceof Error ? mutation.error.message : 'Loan update failed.'}</p> : null}
      <div className="loan-editor__actions">
        <Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? 'Saving...' : 'Save loan'}</Button>
      </div>
    </form>
  )
}
