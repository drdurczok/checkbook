import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QuickAddRecordModal } from './QuickAddRecordModal'
import { api } from '../lib/api'
import type { ExpenseNameSuggestion } from '../contracts/expenses'
import type { ExpenseCategorySummary, ExpenseGroup } from '../types'

vi.mock('../lib/session', () => ({
  useSession: () => ({ token: 'test-token', currency: 'PLN', setError: vi.fn(), setMessage: vi.fn() }),
}))

const coffee = { description: 'Coffee shop', category_id: 'coffee', category_name: 'Coffee', expense_group_id: 'food' }
const fuel = { description: 'Fuel station', category_id: 'fuel', category_name: 'Fuel', expense_group_id: 'transport' }
const groups: ExpenseGroup[] = ['food', 'transport'].map((id) => ({ id, name: id, color: '', notes: '', sort_order: 0, is_retired: false, can_delete: true, is_source_linked: false }))
const rows: ExpenseCategorySummary[] = [
  ['other', 'Other', null], ['coffee', 'Coffee', 'food'], ['groceries', 'Groceries', 'food'], ['fuel', 'Fuel', 'transport'],
].map(([id, name, group], index) => ({ id: id ?? '', name: name ?? '', expense_group_id: group, parent_id: null, is_system: false, is_retired: false, can_delete: true, is_source_linked: false, sort_order: index, total_amount: 0, monthly_average: 0, entry_count: 0 }))

function openModal(expenseRows = rows) {
  const onClose = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={client}><QuickAddRecordModal categories={[]} expenseGroups={groups} expenseRows={expenseRows} properties={[]} onAdded={vi.fn()} onClose={onClose} /></QueryClientProvider>)
  return { ...view, onClose, user: userEvent.setup(), name: screen.getByRole('combobox', { name: 'Name' }) }
}

beforeEach(() => {
  vi.spyOn(api, 'getExpenseNameSuggestions').mockImplementation(async (_token, query) => query.startsWith('fu') ? [fuel] : [coffee, { ...coffee, description: 'Coffee beans', category_id: 'groceries', category_name: 'Groceries' }])
})
afterEach(() => vi.restoreAllMocks())

describe('historical expense name matching', () => {
  it('never offers projected utility sources as writable expense groups', async () => {
    const { user } = openModal([
      ...rows,
      { ...rows[0], id: 'house', name: 'Utilities', expense_group_id: 'food', utility_property_id: 'house', is_source_linked: true, can_delete: false },
    ])
    await user.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'food')
    const options = within(screen.getByRole('combobox', { name: 'Group' }))
    expect(options.getByRole('option', { name: 'Coffee' })).toBeInTheDocument()
    expect(options.queryByRole('option', { name: 'Utilities' })).not.toBeInTheDocument()
  })

  it('debounces typing, automatically classifies the best match, selects by keyboard, and saves the inferred group only', async () => {
    const create = vi.spyOn(api, 'createExpense').mockResolvedValue({ id: 'new', record_type: 'expense', name: 'Coffee beans' })
    const { user, name, onClose } = openModal()
    await user.type(name, 'c')
    expect(api.getExpenseNameSuggestions).not.toHaveBeenCalled()
    await user.type(name, 'of')
    await screen.findByRole('listbox', { name: 'Expense name suggestions' })
    expect(api.getExpenseNameSuggestions).toHaveBeenCalledWith('test-token', 'cof')
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('food')
    expect(screen.getByRole('combobox', { name: 'Group' })).toHaveValue('Coffee')
    expect(name).toHaveValue('cof')
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(name).toHaveValue('Coffee beans')
    expect(screen.queryByRole('listbox', { name: 'Expense name suggestions' })).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Group' })).toHaveValue('Groceries')
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '10')
    await user.click(screen.getByRole('button', { name: 'Add Expense' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    expect(create.mock.calls[0][1]).toMatchObject({ description: 'Coffee beans', category_name: 'Groceries', amount: 10 })
    expect(create.mock.calls[0][1]).not.toHaveProperty('subcategory_name')
  })

  it.each(['Category', 'Group'])('locks both classification fields after a manual %s change, including after clearing and selecting another suggestion', async (field) => {
    const { user, name } = openModal()
    await user.type(name, 'cof')
    await screen.findByRole('listbox', { name: 'Expense name suggestions' })
    if (field === 'Category') {
      await user.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'transport')
    } else {
      await user.selectOptions(screen.getByRole('combobox', { name: 'Group' }), 'Groceries')
    }
    const expectedCategory = field === 'Category' ? 'transport' : 'food'
    const expectedGroup = field === 'Category' ? 'Fuel' : 'Groceries'
    await user.clear(name)
    await user.type(name, 'fuel')
    const list = await screen.findByRole('listbox', { name: 'Expense name suggestions' })
    await user.click(within(list).getByRole('option', { name: /Fuel station/ }))
    expect(name).toHaveValue('Fuel station')
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue(expectedCategory)
    expect(screen.getByRole('combobox', { name: 'Group' })).toHaveValue(expectedGroup)
  })

  it('ignores late history responses for an earlier name', async () => {
    let finishCoffee: (items: ExpenseNameSuggestion[]) => void = () => {}
    vi.mocked(api.getExpenseNameSuggestions).mockImplementation((_token, query) => query === 'coffee'
      ? new Promise((resolve) => { finishCoffee = resolve }) : Promise.resolve([fuel]))
    const { user, name } = openModal()
    await user.type(name, 'coffee')
    await waitFor(() => expect(api.getExpenseNameSuggestions).toHaveBeenCalledWith('test-token', 'coffee'))
    await user.clear(name)
    await user.type(name, 'fuel')
    await screen.findByRole('option', { name: /Fuel station/ })
    await act(async () => finishCoffee([coffee]))
    expect(screen.queryByRole('option', { name: /Coffee shop/ })).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('transport')
    expect(screen.getByRole('combobox', { name: 'Group' })).toHaveValue('Fuel')
  })

  it('dismisses just suggestions with Escape and restores autofill in a fresh modal', async () => {
    const first = openModal()
    await first.user.type(first.name, 'cof')
    await screen.findByRole('listbox', { name: 'Expense name suggestions' })
    await first.user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(first.onClose).not.toHaveBeenCalled()
    await first.user.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'transport')
    first.unmount()
    const second = openModal()
    await second.user.type(second.name, 'cof')
    await screen.findByRole('listbox', { name: 'Expense name suggestions' })
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('food')
    expect(screen.getByRole('combobox', { name: 'Group' })).toHaveValue('Coffee')
  })

  it('supports the overview fallback without board data', async () => {
    render(<QueryClientProvider client={new QueryClient()}><QuickAddRecordModal
      categories={[{ id: 'coffee', name: 'Coffee', kind: 'expense', normalized_name: 'coffee', parent_id: null, is_system: false, sort_order: 1 }, { id: 'other', name: 'Other', kind: 'expense', normalized_name: 'other', parent_id: null, is_system: false, sort_order: 0 }]}
      properties={[]} onAdded={vi.fn()} onClose={vi.fn()}
    /></QueryClientProvider>)
    await userEvent.type(screen.getByRole('combobox', { name: 'Name' }), 'cof')
    await screen.findByRole('listbox', { name: 'Expense name suggestions' })
    expect(screen.queryByRole('combobox', { name: 'Category' })).toBeNull()
    expect(screen.getByRole('combobox', { name: 'Group' })).toHaveValue('Coffee')
  })

  it('does not classify from a missing or stale board category', async () => {
    vi.mocked(api.getExpenseNameSuggestions).mockResolvedValue([{ ...coffee, category_id: 'missing' }])
    const { user, name } = openModal()
    await user.type(name, 'cof')
    await screen.findByRole('listbox', { name: 'Expense name suggestions' })
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('')
    expect(screen.getByRole('combobox', { name: 'Group' })).toHaveValue('Other')
  })

  it('allows manual entry after a history failure and never searches loan names', async () => {
    vi.mocked(api.getExpenseNameSuggestions).mockRejectedValue(new Error('Unavailable'))
    const { user, name } = openModal()
    await user.type(name, 'new name')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('History suggestions unavailable'))
    expect(name).toHaveValue('new name')
    expect(screen.getByRole('combobox', { name: 'Group' })).toHaveValue('Other')
    await user.click(screen.getByRole('button', { name: 'Expense' }))
    await user.click(screen.getByRole('option', { name: 'Loan' }))
    vi.mocked(api.getExpenseNameSuggestions).mockClear()
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Coffee loan')
    expect(api.getExpenseNameSuggestions).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
