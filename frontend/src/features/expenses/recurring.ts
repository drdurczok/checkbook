import Decimal from 'decimal.js'
import type { ExpenseCadence, RecurringExpense } from '../../contracts/expenses'

export const expenseCadences: { value: ExpenseCadence; label: string }[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Biweekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
]

export function recurringTotals(schedules: RecurringExpense[]) {
  const active = schedules.filter((schedule) => schedule.is_active && schedule.next_due_date !== null)
  const monthly = active.reduce((sum, schedule) => {
    const amount = new Decimal(schedule.amount)
    // Annualize weekly cadences before normalizing; never round individual schedules.
    const normalized = schedule.cadence === 'weekly' ? amount.times(52).div(12)
      : schedule.cadence === 'biweekly' ? amount.times(26).div(12)
        : schedule.cadence === 'quarterly' ? amount.div(3)
          : schedule.cadence === 'yearly' ? amount.div(12) : amount
    return sum.plus(normalized)
  }, new Decimal(0))
  return {
    count: active.length,
    monthly: monthly.toDecimalPlaces(2).toNumber(),
    nextPayments: active.reduce((sum, schedule) => sum.plus(schedule.amount), new Decimal(0)).toDecimalPlaces(2).toNumber(),
  }
}
