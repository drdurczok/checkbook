import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import Decimal from 'decimal.js'
import { X } from 'lucide-react'
import { DetailActionsMenu } from '../../components/DetailActionsMenu'
import { Button } from '../../components/ui/Button'
import { FormSheet } from '../../components/ui/FormSheet'
import { Checkbox } from '../../components/ui/NativeControls'
import { OutlinedInput } from '../../components/ui/OutlinedField'
import type { LoanSummary } from '../../contracts/dashboard'
import type { LoanUpdatePayload } from '../../contracts/loans'
import { api } from '../../lib/api'
import { todayInputValue } from '../../lib/format'
import { useSession } from '../../lib/session'
import { loanPaymentCompleted, loanPaymentSchedule, loanPaymentSourceRows } from './model'
import '../../styles/features/loan-table.css'

const editableColumns = [
  ['principal', 'Principal'],
  ['interest', 'Interest'],
  ['extra_principal', 'Extra principal'],
] as const

function decimalOf(value: string | number | null | undefined): Decimal | null {
  if (value === null || value === undefined || String(value).trim() === '') return null
  try {
    return new Decimal(String(value).trim())
  } catch {
    return null
  }
}

export function LoanPaymentEditor({ loan, rowIndex, onSaved, onCancel }: {
  loan: LoanSummary
  rowIndex: number | null
  onSaved: (loan: LoanSummary) => void
  onCancel: () => void
}) {
  const { token, setMessage } = useSession()
  const id = useId()
  const queryClient = useQueryClient()
  const schedule = loanPaymentSourceRows(loan)
  const displaySchedule = loanPaymentSchedule(loan)
  const payment = rowIndex === null ? undefined : schedule[rowIndex]
  const current = rowIndex === null ? undefined : displaySchedule[rowIndex]
  const [completed, setCompleted] = useState(() => payment ? loanPaymentCompleted(payment) : false)
  const [date, setDate] = useState(() => {
    if (rowIndex !== null) return displaySchedule[rowIndex]?.date ?? todayInputValue()
    const lastDate = displaySchedule.at(-1)?.date
    if (!lastDate) return todayInputValue()
    const [year, month] = lastDate.split('-').map(Number)
    return `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01`
  })
  const [amounts, setAmounts] = useState(() => Object.fromEntries(
    editableColumns.map(([key]) => [key, payment?.[key] == null ? '' : String(payment[key])]),
  ))
  const mutation = useMutation({
    mutationFn: (payload: LoanUpdatePayload) => api.updateLoan(token, loan.id, payload),
    onSuccess: (updated) => {
      onSaved(updated)
      setMessage('Loan payment updated.')
      for (const queryKey of [['overview'], ['properties'], ['loans'], ['expenses'], ['planning']]) {
        void queryClient.invalidateQueries({ queryKey })
      }
    },
  })
  const saveSchedule = (paymentSchedule: LoanUpdatePayload['payment_schedule']) => mutation.mutate({
    name: loan.name,
    interest_rate: loan.interest_rate,
    original_balance: loan.original_balance ?? null,
    start_date: loan.start_date ?? null,
    end_date: loan.end_date ?? null,
    notes: loan.notes ?? '',
    linked_property_id: loan.linked_property_id ?? null,
    payment_schedule: paymentSchedule,
  })
  const close = () => { if (!mutation.isPending) onCancel() }

  // Base payment and balance are derived, never typed: the base payment is the
  // sum of principal and interest, the balance is the previous row's balance
  // less the current principal and extra principal.
  const zero = new Decimal(0)
  const principal = decimalOf(amounts.principal)
  const interest = decimalOf(amounts.interest)
  const extra = decimalOf(amounts.extra_principal)
  const basePayment = principal === null && interest === null
    ? (payment?.payment == null ? '' : String(payment.payment))
    : (principal ?? zero).add(interest ?? zero).toString()
  const previousRow = rowIndex === null ? displaySchedule.at(-1) : displaySchedule[rowIndex - 1]
  const storedBalance = decimalOf(current?.outstanding_loan_balance)
  // Reconstruct the row's own opening from its frozen values, never the live
  // edits, so changing principal or extra reduces the balance from the same
  // anchor the stored balance was computed from.
  const opening = decimalOf(previousRow?.outstanding_loan_balance)
    ?? (storedBalance === null ? null
      : storedBalance
        .add(decimalOf(current?.principal) ?? zero)
        .add(decimalOf(current?.extra_principal) ?? zero))
    ?? decimalOf(loan.current_balance)
  const balanceRaw = opening === null ? null : opening.minus(principal ?? zero).minus(extra ?? zero)
  const balance = balanceRaw === null ? '' : balanceRaw.isNegative() ? '0' : balanceRaw.toString()

  return (
    <FormSheet title={payment ? 'Edit payment' : 'Add payment'} eyebrow={loan.name} className="loan-payment-sheet" onClose={close}
      actions={rowIndex !== null ? (
        <div className="asset-detail-actions">
          <DetailActionsMenu label="Payment actions"
            actions={[{
              label: 'Remove row',
              disabled: mutation.isPending,
              // Index into the full schedule, not the forecast-filtered visible rows.
              onClick: () => saveSchedule(schedule.filter((_, index) => index !== rowIndex)),
            }]} />
          <button aria-label="Close" className="record-add-close" disabled={mutation.isPending} onClick={close} type="button">
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      ) : undefined}>
      <form className="quick-add-form" aria-label={payment ? 'Edit loan payment' : 'Add loan payment'} onSubmit={(event) => {
        event.preventDefault()
        const updated = {
          ...(payment?.id === undefined ? {} : { id: payment.id }),
          date,
          ...Object.fromEntries(editableColumns.flatMap(([key]) => amounts[key] === '' ? [] : [[key, amounts[key]]])),
          ...(basePayment === '' ? {} : { payment: basePayment }),
          ...(balance === '' ? {} : { outstanding_loan_balance: balance }),
          ...(payment?.interest_balance == null ? {} : { interest_balance: String(payment.interest_balance) }),
          completed,
          projected: !completed,
        }
        saveSchedule(rowIndex === null ? [...schedule, updated] : schedule.map((row, index) => index === rowIndex ? updated : row))
      }}>
        <div className="form-grid">
          <OutlinedInput id={`${id}-date`} label="Date" type="date" required value={date} disabled={mutation.isPending} autoFocus onChange={(event) => setDate(event.target.value)} />
          <label className="loan-payment-sheet__status">
            <Checkbox checked={completed} disabled={mutation.isPending}
              onChange={(event) => setCompleted(event.target.checked)} />
            <span>Completed</span>
            <span aria-hidden="true" className="loan-payment-sheet__status-track"><i /></span>
          </label>
          <OutlinedInput id={`${id}-payment`} label="Base payment" type="number" inputMode="decimal" min="0" step="any"
            value={basePayment} readOnly disabled={mutation.isPending} className="loan-payment-sheet__derived" />
          <OutlinedInput id={`${id}-balance`} label="Balance" type="number" inputMode="decimal" min="0" step="any"
            value={balance} readOnly disabled={mutation.isPending} className="loan-payment-sheet__derived" />
          {editableColumns.map(([key, label]) => (
            <OutlinedInput key={key} id={`${id}-${key}`} label={label} type="number" inputMode="decimal" min="0" step="any"
              value={amounts[key]} disabled={mutation.isPending}
              onChange={(event) => setAmounts((current) => ({ ...current, [key]: event.target.value }))} />
          ))}
        </div>
        {mutation.isError ? <p className="loan-payment-sheet__error" role="alert">{mutation.error instanceof Error ? mutation.error.message : 'Loan payment update failed.'}</p> : null}
        <div className="quick-add-actions loan-payment-sheet__actions">
          <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? 'Saving...' : 'Save payment'}</Button>
        </div>
      </form>
    </FormSheet>
  )
}
