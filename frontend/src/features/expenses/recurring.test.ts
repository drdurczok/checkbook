import { describe, expect, it } from 'vitest'
import type { ExpenseCadence, RecurringExpense } from '../../contracts/expenses'
import { recurringTotals } from './recurring'

export function schedule(overrides: Partial<RecurringExpense> = {}): RecurringExpense {
  return { id: 'rent', description: 'Rent', amount: 100, start_date: '2026-01-01', end_date: null, next_due_date: '2026-11-01', cadence: 'monthly', owner_scope: 'joint', category_id: 'home', category_name: 'Home', notes: '', is_active: true, price_history: [], ...overrides }
}

describe('recurring expense totals', () => {
  it.each<[ExpenseCadence, number]>([['weekly', 433.33], ['biweekly', 216.67], ['monthly', 100], ['quarterly', 33.33], ['yearly', 8.33]])('normalizes %s to a labeled monthly estimate', (cadence, monthly) => {
    expect(recurringTotals([schedule({ cadence })])).toEqual({ count: 1, monthly, nextPayments: 100 })
  })
  it('sums decimals before rounding and excludes retired or exhausted schedules', () => {
    expect(recurringTotals([schedule({ amount: 0.1 }), schedule({ amount: 0.2 }), schedule({ is_active: false }), schedule({ next_due_date: null })])).toEqual({ count: 2, monthly: 0.3, nextPayments: 0.3 })
    expect(recurringTotals(Array.from({ length: 3 }, () => schedule({ amount: 1, cadence: 'quarterly' })))).toEqual({ count: 3, monthly: 1, nextPayments: 3 })
  })
  it('returns zero for an empty list', () => {
    expect(recurringTotals([])).toEqual({ count: 0, monthly: 0, nextPayments: 0 })
  })
})
