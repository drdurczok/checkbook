import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardOverview } from '../types'
import { useEffect } from 'react'
import { ExpensesPage } from './ExpensesPage'
import { SessionProvider, useSession } from '../lib/session'
import type { SessionResponse } from '../types'

const board = {
  monthly_totals: [{ category_id: 'cat-fixed', period: '2026-01', value: 300 }, { category_id: 'cat-fun', period: '2026-01', value: 100 }],
  groups: [{ id: 'group-1', name: 'Fixed', color: '30 111 214', notes: '', sort_order: 0 }],
  categories: [
    {
      id: 'cat-fixed',
      name: 'Rent',
      parent_id: null,
      expense_group_id: 'group-1',
      is_system: false,
      sort_order: 0,
      total_amount: 300,
      monthly_average: 300,
      entry_count: 1,
      first_entry_date: '2026-01-01',
      last_entry_date: '2026-01-31',
    },
    {
      id: 'cat-fun',
      name: 'Fun stuff',
      parent_id: null,
      expense_group_id: null,
      is_system: false,
      sort_order: 1,
      total_amount: 100,
      monthly_average: 100,
      entry_count: 1,
      first_entry_date: '2026-01-02',
      last_entry_date: '2026-01-20',
    },
  ],
}

const detail = {
  id: 'cat-fixed',
  name: 'Rent',
  expense_group_id: 'group-1',
  is_system: false,
  sort_order: 0,
  subcategories: [],
  monthly_totals: [{ period: '2026-01', value: 300 }],
  entries: [],
}

const dashboard = {
  metrics: [],
  net_worth_trend: [],
  net_worth_components: [],
  cash_flow_trend: [],
  cash_flow_components: [],
  income_breakdown: [],
  expense_breakdown: [
    { label: 'Fixed', value: 300, share: 0.75 },
    { label: 'Fun stuff', value: 100, share: 0.25 },
  ],
  expense_trend_by_category: [{ period: '2026-01', values: { Fixed: 300, 'Fun stuff': 100 } }],
  utility_trend: [],
  savings_allocation: [],
  loans: [],
  upcoming_planned_expenses: [],
  recent_activity: [],
  goals: [],
  last_successful_import: null,
} satisfies DashboardOverview

const householdCategories = [
  { id: 'household-cat-1', kind: 'expense', name: 'Rent', normalized_name: 'rent', parent_id: null, is_system: false, sort_order: 0 },
]

const assets = [
  {
    id: 'asset-1',
    kind: 'asset',
    name: 'Vacation home',
    category: 'Property',
    current_value: 100000,
    currency: 'PLN',
    owner_scope: 'joint',
    valuation_date: '2026-01-01',
    notes: '',
    linked_property_id: null,
  },
]

const api = vi.hoisted(() => ({
  getExpensesBoard: vi.fn(async () => board),
  getDashboardOverview: vi.fn(async () => dashboard),
  getExpenseCategoryDetail: vi.fn(async () => detail),
  getCategories: vi.fn(async () => householdCategories),
  getAssets: vi.fn(async () => assets),
  createExpenseGroup: vi.fn(async () => ({ id: 'group-new', name: 'Travel', color: '30 111 214', notes: '', sort_order: 1 })),
}))

vi.mock('../lib/api', () => ({ api }))

const session = {
  token: 'test-token',
  expires_at: '2099-01-01T00:00:00Z',
  user: { id: 'user-1', email: 'owner@example.com', full_name: 'Test Owner', picture_url: '' },
  household: { id: 'house-1', name: 'Test Household', base_currency: 'PLN', timezone: 'Europe/Warsaw' },
  membership: { id: 'membership-1', role: 'owner', relationship_kind: 'owner' },
  settings: {
    id: 'settings-1',
    privacy_mode: 'household',
    allow_cross_member_visibility: true,
    projection_baseline_window_months: 12,
    projection_horizon_months: 24,
    savings_allocation_strategy: 'default',
    role_permissions: {},
  },
}

/** Mirrors App's bootstrap: restore the stored session into the provider. */
function SessionInjector({ value }: { value: SessionResponse }) {
  const { applySession } = useSession()
  useEffect(() => {
    applySession(value)
  }, [applySession, value])
  return null
}

function renderExpenses(dateRange: 'all' | 'month' = 'all') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <SessionInjector value={session as SessionResponse} />
        <ExpensesPage dateRange={dateRange} />
      </SessionProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  api.getExpensesBoard.mockClear()
  api.getDashboardOverview.mockClear()
  api.getExpenseCategoryDetail.mockClear()
  api.getCategories.mockClear()
  api.getAssets.mockClear()
  api.createExpenseGroup.mockClear()
  window.localStorage.setItem('checkbook.session', JSON.stringify(session))
})

describe('ExpensesPage quick add and category filter', () => {
  it('opens the shared record-add modal from the plus button, with the loan kind reusing linked properties', async () => {
    renderExpenses()

    await screen.findByText('Rent')
    await userEvent.click(screen.getByRole('button', { name: 'Add expense' }))

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveClass('record-add-modal')
    expect(screen.getByPlaceholderText('Name')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Expense' }))
    await userEvent.click(screen.getByRole('option', { name: 'Loan' }))

    expect(screen.getByPlaceholderText('Current balance')).toBeInTheDocument()
    const linked = screen.getByRole('combobox', { name: 'Linked property or vehicle' })
    expect(linked).toHaveTextContent('Vacation home')
    expect(linked.closest('.outlined-field')).toBeInTheDocument()
  })

  it('keeps category creation in the add-dropdown and saves through the existing form', async () => {
    const user = userEvent.setup()
    renderExpenses()
    await screen.findByText('Rent')
    expect(screen.queryByRole('button', { name: /^(New|Add) category$/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Add expense' }))
    await user.click(screen.getByRole('button', { name: 'Expense' }))
    expect(within(screen.getByRole('listbox', { name: 'Record type' })).getAllByRole('option').map((option) => option.textContent)).toEqual(['Expense', 'Recurring expense', 'Loan', 'Category'])
    await user.click(screen.getByRole('option', { name: 'Category' }))

    const dialog = screen.getByRole('dialog', { name: 'New category' })
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(dialog).toHaveClass('expense-group-modal')
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Travel')
    await user.click(within(dialog).getByRole('button', { name: 'Save category' }))
    await waitFor(() => expect(api.createExpenseGroup).toHaveBeenCalledWith('test-token', {
      name: 'Travel', color: '30 111 214', notes: '', sort_order: 1,
    }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.getExpensesBoard).toHaveBeenCalledTimes(4)

    await user.click(screen.getByRole('button', { name: 'Add expense' }))
    expect(screen.getByRole('button', { name: 'Expense' })).toBeInTheDocument()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('defaults to the first uncategorized group and resets group when category changes', async () => {
    renderExpenses()
    await screen.findByText('Rent')
    await userEvent.click(screen.getByRole('button', { name: 'Add expense' }))

    const category = screen.getByRole('combobox', { name: 'Category' })
    const group = screen.getByRole('combobox', { name: 'Group' })
    expect(category.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(category).toHaveValue('')
    expect(group).toHaveValue('Fun stuff')
    expect(group).not.toHaveTextContent('Rent')

    await userEvent.selectOptions(category, 'group-1')
    expect(group).toHaveValue('Rent')
    expect(group).not.toHaveTextContent('Fun stuff')

    await userEvent.selectOptions(category, '')
    expect(group).toHaveValue('Fun stuff')
  })

  it('labels the summary total with the active date range filter', async () => {
    const first = renderExpenses()

    await screen.findByText('Rent')
    const labels = (container: HTMLElement) =>
      [...container.querySelectorAll('.expense-summary-grid > div > span')].map((node) => node.textContent)
    expect(labels(first.container)).toEqual([
      'Monthly average',
      'All time',
    ])
    first.unmount()

    const second = renderExpenses('month')
    await screen.findByLabelText('Expenses summary')
    expect(labels(second.container)).toEqual([
      'Monthly average',
      'Current month',
    ])
  })

  it('filters charts and tables from the chip row: All first, Uncategorized last', async () => {
    renderExpenses()

    await screen.findByText('Rent')
    const chips = screen
      .getAllByRole('button')
      .filter((button) => button.closest('.expense-filter-row'))
    const labels = chips.map((chip) => chip.textContent)
    expect(labels[0]).toBe('All')
    expect(labels[labels.length - 1]).toBe('Uncategorized')
    expect(labels).toContain('Fixed')

    expect(screen.getByText('Fun stuff')).toBeInTheDocument()
    await userEvent.click(chips.find((chip) => chip.textContent === 'Fixed') as HTMLElement)
    expect(screen.queryByText('Fun stuff')).not.toBeInTheDocument()
    expect(screen.getByText('Rent')).toBeInTheDocument()

    await userEvent.click(chips.find((chip) => chip.textContent === 'Uncategorized') as HTMLElement)
    expect(screen.queryByText('Rent')).not.toBeInTheDocument()
    expect(screen.getByText('Fun stuff')).toBeInTheDocument()

    await userEvent.click(chips.find((chip) => chip.textContent === 'All') as HTMLElement)
    expect(screen.getByText('Rent')).toBeInTheDocument()
    expect(screen.getByText('Fun stuff')).toBeInTheDocument()
  })

  it('shows the edit-group form above the statistics', async () => {
    renderExpenses()

    const row = await screen.findByText('Rent')
    await userEvent.click(row.closest('button') ?? row)
    await userEvent.click(screen.getByRole('button', { name: 'Group actions' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Edit group' }))

    const dialog = screen.getByRole('dialog')
    const editor = dialog.querySelector('.expense-settings-editor')
    const stats = dialog.querySelector('.expense-detail-stats')
    expect(editor).not.toBeNull()
    expect(stats).not.toBeNull()
    /* Bit 2 (DOCUMENT_POSITION_PRECEDING) set: the editor precedes the
       statistics in DOM order, i.e. it renders above them. */
    const position = (stats as Node).compareDocumentPosition(editor as Node)
    expect(position & Node.DOCUMENT_POSITION_PRECEDING).toBe(Node.DOCUMENT_POSITION_PRECEDING)
  })
})
