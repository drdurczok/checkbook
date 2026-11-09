import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardOverview } from '../types'
import { useEffect } from 'react'
import { ExpensesPage } from './ExpensesPage'
import { SessionProvider, useSession } from '../lib/session'
import type { SessionResponse } from '../types'

const board = {
  monthly_totals: [{ category_id: 'cat-1', period: '2026-01', value: 100 }],
  groups: [],
  categories: [
    {
      id: 'cat-1',
      name: 'Groceries',
      parent_id: null,
      expense_group_id: null,
      is_system: false,
      sort_order: 0,
      total_amount: 100,
      monthly_average: 50,
      entry_count: 1,
      first_entry_date: '2026-01-01',
      last_entry_date: '2026-01-15',
    },
  ],
}

const detail = {
  id: 'cat-1',
  name: 'Groceries',
  expense_group_id: null,
  is_system: false,
  sort_order: 0,
  subcategories: [],
  monthly_totals: [{ period: '2026-01', value: 100 }],
  entries: [],
}

const dashboard = {
  metrics: [],
  net_worth_trend: [],
  net_worth_components: [],
  cash_flow_trend: [],
  cash_flow_components: [],
  income_breakdown: [],
  expense_breakdown: [],
  expense_trend_by_category: [],
  utility_trend: [],
  savings_allocation: [],
  loans: [],
  upcoming_planned_expenses: [],
  recent_activity: [],
  goals: [],
  last_successful_import: null,
} satisfies DashboardOverview

const api = vi.hoisted(() => ({
  getExpensesBoard: vi.fn(async () => board),
  getDashboardOverview: vi.fn(async () => dashboard),
  getExpenseCategoryDetail: vi.fn(async () => detail),
  getCategories: vi.fn(async () => [
    { id: 'household-cat-1', kind: 'expense', name: 'Groceries', normalized_name: 'groceries', parent_id: null, is_system: false, sort_order: 0 },
  ]),
  getAssets: vi.fn(async () => []),
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

function renderExpenses() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <SessionInjector value={session as SessionResponse} />
        <ExpensesPage dateRange="all" />
      </SessionProvider>
    </QueryClientProvider>,
  )
}

async function openEntryEditor() {
  renderExpenses()
  // The group renders as a detail row whose accessible name includes the
  // monthly figure; match on the row class + text instead. The Add expense
  // button is scoped to the dialog because the page FAB shares its name.
  const row = await screen.findByText('Groceries')
  await userEvent.click(row.closest('button') ?? row)
  const dialog = await screen.findByRole('dialog')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Add expense' }))
  return dialog
}

beforeEach(() => {
  api.getExpensesBoard.mockClear()
  api.getDashboardOverview.mockClear()
  api.getExpenseCategoryDetail.mockClear()
  api.getCategories.mockClear()
  api.getAssets.mockClear()
  window.localStorage.setItem('checkbook.session', JSON.stringify(session))
})

describe('ExpensesPage entry editor', () => {
  it('renders outlined entry fields with icons, labels, and associated help', async () => {
    const dialog = await openEntryEditor()

    const amount = screen.getByPlaceholderText('Amount')
    expect(amount).toHaveAttribute('inputmode', 'decimal')

    const description = screen.getByRole('textbox', { name: 'Description (optional)' })
    expect(description).toHaveAccessibleDescription('Only for unusual expenses')

    expect(dialog.querySelectorAll('.outlined-field__icon')).toHaveLength(5)
    expect(dialog.querySelectorAll('.outlined-field.is-date')).toHaveLength(1)
    expect(dialog.querySelector('.record-add-field-control')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Date')).toHaveAttribute('type', 'date')
    const owner = screen.getByRole('combobox', { name: 'Owner' })
    await userEvent.selectOptions(owner, 'spouse')
    expect(owner).toHaveValue('spouse')
    const ids = [...dialog.querySelectorAll('input, select')].map((control) => control.id)
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('formats the amount with grouping and a currency while typing', async () => {
    await openEntryEditor()

    const amount = screen.getByPlaceholderText('Amount')
    const field = amount.closest('.outlined-field')
    const badge = field?.querySelector('.outlined-field__trailing')
    expect(field).not.toHaveClass('has-value')
    expect(badge).toHaveTextContent('PLN')

    await userEvent.type(amount, '12345.6')

    expect(amount).toHaveValue('12\u2009345.6')
    expect(field).toHaveClass('has-value')
    expect(badge).toHaveTextContent('PLN')
  })
})
