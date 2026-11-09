import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import type { RecurringExpense } from '../../contracts/expenses'
import { RecurringExpenses } from './RecurringExpenses'
import { QuickAddRecordModal } from '../../components/QuickAddRecordModal'

vi.mock('../../lib/session', () => ({ useSession: () => ({ token: 'token', currency: 'USD', setError: vi.fn(), setMessage: vi.fn() }) }))
const rent: RecurringExpense = { id: 'rent', description: 'Rent', amount: 120, start_date: '2026-01-01', end_date: null, next_due_date: '2026-11-01', cadence: 'monthly', owner_scope: 'joint', category_id: 'home', category_name: 'Home', notes: 'A note', is_active: true, price_history: [{ amount: 100, changed_at: '2026-01-01T12:00:00Z' }] }
function mount(child: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{child}</QueryClientProvider>)
}
beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(api, 'getRecurringExpenses').mockResolvedValue([rent])
  vi.spyOn(api, 'getExpenseNameSuggestions').mockResolvedValue([])
})

describe('recurring expense UI', () => {
  it('shows the upcoming count and amount without the monthly total label', async () => {
    mount(<RecurringExpenses categories={[]} />)
    const card = await screen.findByRole('button', { name: 'Manage recurring expenses' })
    expect(card).toHaveTextContent('1 upcoming')
    expect(card).not.toHaveTextContent('Estimated monthly total')
    expect(within(card).getAllByText(/120/)).toHaveLength(1)
    expect(screen.queryByText('Next payment per schedule')).not.toBeInTheDocument()
    expect(screen.queryByText(/Weekly and biweekly amounts use/)).not.toBeInTheDocument()
  })
  it('applies the page filter to the card totals and the management list', async () => {
    const matching = mount(<RecurringExpenses categories={[]} matchesFilter={(schedule) => schedule.category_id === 'home'} />)
    const card = await screen.findByRole('button', { name: 'Manage recurring expenses' })
    expect(card).toHaveTextContent('1 upcoming')
    await userEvent.click(card)
    expect(await screen.findByText('Rent')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^Close$/ }))
    matching.unmount()

    mount(<RecurringExpenses categories={[]} matchesFilter={(schedule) => schedule.category_id === 'other'} />)
    const filteredCard = await screen.findByRole('button', { name: 'Manage recurring expenses' })
    expect(filteredCard).toHaveTextContent('0 upcoming')
    await userEvent.click(filteredCard)
    expect(await screen.findByText('No recurring expenses')).toBeInTheDocument()
  })
  it('creates a monthly schedule through quick add with paired start and optional end', async () => {
    const create = vi.spyOn(api, 'createRecurringExpense').mockResolvedValue(rent)
    const onAdded = vi.fn()
    mount(<QuickAddRecordModal categories={[{ id: 'home', name: 'Home', kind: 'expense', normalized_name: 'home', is_system: false, sort_order: 0 }]} properties={[]} onAdded={onAdded} onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Expense' }))
    await userEvent.click(screen.getByRole('option', { name: 'Recurring expense' }))
    expect(screen.getByLabelText('Start').closest('.record-add-pair')).toBe(screen.getByLabelText('End (optional)').closest('.record-add-pair'))
    expect(screen.getByLabelText('Frequency (optional)')).toHaveValue('monthly')
    expect(within(screen.getByLabelText('Frequency (optional)')).getAllByRole('option')).toHaveLength(5)
    await userEvent.type(screen.getByRole('combobox', { name: 'Name' }), 'Rent')
    await userEvent.type(screen.getByLabelText('Amount'), '120')
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '2026-11-01' } })
    await userEvent.click(screen.getByRole('button', { name: 'Add Recurring expense' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith('token', { description: 'Rent', amount: 120, start_date: '2026-11-01', end_date: null, cadence: 'monthly', category_name: 'Home', owner_scope: 'joint', notes: '' }))
    expect(onAdded).toHaveBeenCalledOnce()
  })
  it('lists nearest payments and saves edited expense data while showing price history', async () => {
    const update = vi.spyOn(api, 'updateRecurringExpense').mockResolvedValue(rent)
    mount(<RecurringExpenses categories={[]} />)
    await screen.findByText('1 upcoming')
    await userEvent.click(screen.getByRole('button', { name: 'Manage recurring expenses' }))
    expect(screen.getByText('Next: 2026-11-01')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Options for Rent' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.getByRole('region', { name: 'Price history' })).toHaveTextContent('2026-01-01')
    expect(screen.getByRole('region', { name: 'Price history' })).toHaveTextContent('100')
    await userEvent.clear(screen.getByLabelText('Amount'))
    await userEvent.type(screen.getByLabelText('Amount'), '150')
    fireEvent.change(screen.getByLabelText('Start'), { target: { value: '2026-02-01' } })
    fireEvent.change(screen.getByLabelText('End (optional)'), { target: { value: '2027-02-01' } })
    await userEvent.selectOptions(screen.getByLabelText('Owner'), 'self')
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('token', 'rent', expect.objectContaining({ amount: 150, start_date: '2026-02-01', end_date: '2027-02-01', owner_scope: 'self', description: 'Rent', notes: 'A note' })))
    await screen.findByRole('dialog', { name: 'Recurring expenses' })
  })
  it('supports expense now and retire actions and surfaces request errors', async () => {
    const now = vi.spyOn(api, 'expenseRecurringNow').mockRejectedValue(new Error('Payment failed'))
    const retire = vi.spyOn(api, 'retireRecurringExpense').mockResolvedValue({ ...rent, is_active: false })
    mount(<RecurringExpenses categories={[]} />)
    await screen.findByText('1 upcoming')
    await userEvent.click(screen.getByRole('button', { name: 'Manage recurring expenses' }))
    await userEvent.click(screen.getByRole('button', { name: 'Options for Rent' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Expense now' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Payment failed')
    expect(now).toHaveBeenCalledWith('token', 'rent')
    await userEvent.click(screen.getByRole('button', { name: 'Options for Rent' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Retire' }))
    await waitFor(() => expect(retire).toHaveBeenCalledWith('token', 'rent'))
  })
})
