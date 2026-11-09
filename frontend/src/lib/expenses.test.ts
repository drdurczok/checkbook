import { describe, expect, it } from 'vitest'
import type { ExpensesBoard } from '../types'
import { expenseBoardMix } from './expenses'

const board: ExpensesBoard = {
  groups: [
    { id: 'property', name: 'Property', color: '', notes: '', sort_order: 0, is_retired: false, can_delete: false, is_source_linked: true },
    { id: 'retired', name: 'Retired property', color: '', notes: '', sort_order: 1, is_retired: true, can_delete: false, is_source_linked: true },
  ],
  categories: [
    { id: 'loan', name: 'Mortgage', expense_group_id: 'property', is_system: false, is_retired: false, can_delete: false, is_source_linked: true, sort_order: 0, total_amount: 0.3, monthly_average: 0.15, entry_count: 2 },
    { id: 'retired-loan', name: 'Previous mortgage', expense_group_id: 'retired', is_system: false, is_retired: false, can_delete: false, is_source_linked: true, sort_order: 1, total_amount: 50, monthly_average: 50, entry_count: 1 },
  ],
  monthly_totals: [
    { category_id: 'loan', period: '2027-02', value: 0.2 },
    { category_id: 'loan', period: '2026-01', value: 0.1 },
    { category_id: null, period: '2026-01', value: 0.4 },
    { category_id: 'retired-loan', period: '2026-01', value: 50 },
  ],
}

describe('expenseBoardMix', () => {
  it('groups historical and future payments with exact decimal totals and keeps uncategorized spending', () => {
    const mix = expenseBoardMix(board)
    expect(mix.breakdown.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: 'Uncategorized', value: 0.4 }, { label: 'Property', value: 0.3 },
    ])
    expect(mix.trend).toEqual([
      { period: '2026-01', values: { Property: 0.1, Uncategorized: 0.4 } },
      { period: '2027-02', values: { Property: 0.2 } },
    ])
  })

  it('includes retired groups only on request and hides retired categories independently', () => {
    expect(expenseBoardMix(board, true).breakdown[0]).toMatchObject({ label: 'Retired property', value: 50 })
    const retiredCategory = { ...board, categories: board.categories.map((category) => ({ ...category, is_retired: true })) }
    expect(expenseBoardMix(retiredCategory).breakdown).toEqual([{ label: 'Uncategorized', value: 0.4, share: 1 }])
  })
})
