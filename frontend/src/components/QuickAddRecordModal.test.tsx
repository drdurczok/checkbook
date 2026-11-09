import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { QuickAddRecordModal } from './QuickAddRecordModal'
import { api } from '../lib/api'
import type { ExpenseCategorySummary } from '../types'

vi.mock('../lib/session', () => ({
  useSession: () => ({
    token: 'test-token',
    currency: 'PLN',
    setError: vi.fn(),
    setMessage: vi.fn(),
  }),
}))

function row(id: string, name: string, parent_id: string | null, expense_group_id: string | null): ExpenseCategorySummary {
  return { id, name, parent_id, expense_group_id, is_system: false, is_retired: false, can_delete: true, is_source_linked: false, sort_order: 0, total_amount: 0, monthly_average: 0, entry_count: 0 }
}

beforeEach(() => {
  vi.spyOn(api, 'getExpenseNameSuggestions').mockResolvedValue([])
})

function renderModal(props: React.ComponentProps<typeof QuickAddRecordModal>) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><QuickAddRecordModal {...props} /></QueryClientProvider>)
}

describe('QuickAddRecordModal expense classification', () => {
  it('cascades Category to Group and submits without subgroup data even with historical subgroups', async () => {
    const createExpense = vi.spyOn(api, 'createExpense').mockResolvedValue({ id: 'expense', record_type: 'expense', name: 'Utility bill' })
    const onAdded = vi.fn()
    const onClose = vi.fn()
    try {
      renderModal({
        categories: [],
        expenseGroups: [{ id: 'household', name: 'Household', color: '', notes: '', sort_order: 0, is_retired: false, can_delete: true, is_source_linked: false }],
        expenseRows: [
          row('other', 'Other', null, null),
          row('utilities', 'Utilities', null, 'household'),
          row('electricity', 'Electricity', 'utilities', 'household'),
        ],
        properties: [],
        onAdded,
        onClose,
      })
      expect(screen.getByRole('combobox', { name: 'Group' })).toHaveValue('Other')
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'household')
      expect(screen.getByRole('combobox', { name: 'Group' })).toHaveValue('Utilities')
      expect(screen.queryByRole('combobox', { name: 'Subgroup' })).toBeNull()
      expect(screen.queryByRole('option', { name: 'Electricity' })).toBeNull()
      await userEvent.type(screen.getByRole('combobox', { name: 'Name' }), 'Utility bill')
      await userEvent.type(screen.getByRole('textbox', { name: 'Amount' }), '42.50')
      await userEvent.click(screen.getByRole('button', { name: 'Add Expense' }))
      await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
      expect(onAdded).toHaveBeenCalledOnce()
      expect(createExpense).toHaveBeenCalledOnce()
      expect(createExpense.mock.calls[0][1]).toMatchObject({ category_name: 'Utilities', amount: 42.5 })
      expect(createExpense.mock.calls[0][1]).not.toHaveProperty('subcategory_name')
      expect(createExpense.mock.calls[0][1]).not.toHaveProperty('subcategory_id')
    } finally {
      createExpense.mockRestore()
    }
  })
})
