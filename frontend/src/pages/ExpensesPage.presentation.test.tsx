import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExpensesPage } from './ExpensesPage'
import type { ExpensesBoard } from '../types'

const api = vi.hoisted(() => ({
  getExpensesBoard: vi.fn(),
  getCategories: vi.fn(async () => []),
  getAssets: vi.fn(async () => []),
  getExpenseCategoryDetail: vi.fn(),
  updateExpenseEntry: vi.fn(async () => ({})),
  deleteExpenseEntry: vi.fn(async () => ({})),
}))
vi.mock('../lib/api', () => ({ api }))
vi.mock('../lib/session', () => ({ useSession: () => ({ token: 'token', currency: 'PLN', setError: vi.fn(), setMessage: vi.fn() }) }))

let board: ExpensesBoard

function renderPage(dateRange: 'all' | 'month' = 'all', showForecast = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><ExpensesPage dateRange={dateRange} showForecast={showForecast} /></QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  board = {
    groups: [
      { id: 'property', name: 'Property', color: '16 148 111', notes: '', sort_order: 0, is_retired: false, can_delete: false, is_source_linked: true },
      { id: 'living', name: 'Living', color: '', notes: '', sort_order: 1, is_retired: false, can_delete: true, is_source_linked: false },
    ],
    categories: [
      { id: 'mortgage', name: 'Mortgage', expense_group_id: 'property', is_system: false, is_retired: false, can_delete: false, is_source_linked: true, sort_order: 0, total_amount: 600, monthly_average: 100, entry_count: 6 },
      { id: 'groceries', name: 'Groceries', expense_group_id: 'living', is_system: false, is_retired: false, can_delete: true, is_source_linked: false, sort_order: 1, total_amount: 25, monthly_average: 5, entry_count: 5 },
    ],
    monthly_totals: [
      ...Array.from({ length: 6 }, (_, index) => ({ category_id: 'mortgage', period: `2026-0${index + 1}`, value: 100 })),
      ...Array.from({ length: 5 }, (_, index) => ({ category_id: 'groceries', period: `2026-0${index + 1}`, value: 5 })),
    ],
  }
  api.getExpensesBoard.mockImplementation(async () => structuredClone(board))
  api.getExpenseCategoryDetail.mockImplementation(async () => ({
    ...board.categories[0], subcategories: [], monthly_totals: [{ period: '2026-06', value: 100 }],
    entries: [{ id: 'payment', description: 'Mortgage', amount: 100, entry_date: '2026-06-01', owner_scope: 'joint', notes: '', data_source: 'loan_schedule' }],
  }))
})

describe('expense presentation', () => {
  it.each([false, true])('shows future detail entries only with Forecast enabled (%s)', async (showForecast) => {
    const today = new Date().toLocaleDateString('sv-SE')
    api.getExpenseCategoryDetail.mockResolvedValue({
      ...board.categories[1], subcategories: [], monthly_totals: [],
      entries: [
        { id: 'past', description: 'Past expense', amount: 10, entry_date: '2000-01-01', owner_scope: 'joint', notes: '', data_source: 'app_manual' },
        { id: 'today', description: 'Today expense', amount: 20, entry_date: today, owner_scope: 'joint', notes: '', data_source: 'app_manual' },
        { id: 'undated', description: 'Undated expense', amount: 30, entry_date: null, owner_scope: 'joint', notes: '', data_source: 'app_manual' },
        { id: 'future', description: 'Future expense', amount: 40, entry_date: '2099-01-01', owner_scope: 'joint', notes: '', data_source: 'app_manual' },
        { id: 'scheduled', description: 'Future loan', amount: 50, entry_date: '2099-01-02', owner_scope: 'joint', notes: '', data_source: 'loan_schedule' },
      ],
    })
    const user = userEvent.setup()
    renderPage('all', showForecast)
    await user.click(await screen.findByText('Groceries'))
    const history = await screen.findByRole('region', { name: 'Expenses transaction history' })
    expect(within(history).getByText('Past expense')).toBeVisible()
    expect(within(history).getByText('Today expense')).toBeVisible()
    expect(within(history).getByText('Undated expense')).toBeVisible()
    const monthHeaders = history.querySelectorAll('.entry-month-header')
    expect(monthHeaders).toHaveLength(showForecast ? 4 : 3)
    for (const header of monthHeaders) {
      expect(header.querySelector('h3')).toBeVisible()
      if (header.textContent?.includes('2 expenses')) {
        expect(header.querySelector('strong')).toHaveTextContent('90')
      } else {
        expect(header.querySelector('strong')).toBeNull()
      }
    }
    if (showForecast) {
      expect(within(history).getByText('Future expense')).toBeVisible()
      expect(within(history).getByText('Scheduled loan payment')).toBeVisible()
    } else {
      expect(within(history).queryByText('Future expense')).not.toBeInTheDocument()
      expect(within(history).queryByText('Scheduled loan payment')).not.toBeInTheDocument()
    }
  })

  it('lists linked utility bills in the standard expense history without source navigation or ledger mutations', async () => {
    const category = {
      id: 'house-id', utility_property_id: 'house-id', name: 'Utilities', expense_group_id: 'property',
      is_system: true, is_retired: false, can_delete: false, is_source_linked: true,
      sort_order: 2, total_amount: 60, monthly_average: 30, entry_count: 2,
    }
    board.categories.push(category)
    board.monthly_totals.push({ category_id: 'house-id', period: '2026-06', value: 60 })
    api.getExpenseCategoryDetail.mockResolvedValue({
      ...category, subcategories: [], monthly_totals: [{ period: '2026-06', value: 60 }],
      entries: [
        { id: 'electric', description: 'Electricity', amount: 40, entry_date: '2026-06-01', owner_scope: 'joint', notes: '', data_source: 'utility_bill' },
        { id: 'water', description: 'Water', amount: 20, entry_date: '2026-06-01', owner_scope: 'joint', notes: '', data_source: 'utility_bill' },
      ],
    })
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByText('Utilities'))
    const dialog = await screen.findByRole('dialog', { name: /Utilities/ })
    const history = within(dialog).getByRole('region', { name: 'Expenses transaction history' })
    expect(within(history).getByText('Electricity')).toBeVisible()
    expect(within(history).getByText('Water')).toBeVisible()
    expect(within(history).getByRole('heading', { name: 'June 2026' })).toBeVisible()
    expect(within(dialog).queryByRole('button', { name: /Edit utility values|Add expense|Delete|Retire/ })).not.toBeInTheDocument()
    expect(api.getExpenseCategoryDetail).toHaveBeenCalledWith('token', 'house-id')
    await user.click(within(history).getByRole('button', { name: /Electricity/ }))
    const actions = screen.getByRole('dialog', { name: 'Expense actions' })
    expect(within(actions).getByText(/Utility bills are read-only here/)).toBeVisible()
    expect(within(actions).queryByRole('button', { name: /Edit expense|Delete expense|Select expenses/ })).not.toBeInTheDocument()
    expect(api.updateExpenseEntry).not.toHaveBeenCalled()
    expect(api.deleteExpenseEntry).not.toHaveBeenCalled()
  })

  it('shows every month newest-first without collapsing and preserves cross-month selection and editing', async () => {
    api.getExpenseCategoryDetail.mockResolvedValue({
      ...board.categories[1], subcategories: [], monthly_totals: [],
      entries: [
        { id: 'old', description: 'Winter groceries', amount: 10, entry_date: '2025-12-03', owner_scope: 'joint', notes: '', data_source: 'app_manual' },
        { id: 'latest', description: 'Summer groceries', amount: 30, entry_date: '2026-06-20', owner_scope: 'joint', notes: '', data_source: 'app_manual' },
        { id: 'middle', description: 'Spring groceries', amount: 20, entry_date: '2026-03-10', owner_scope: 'joint', notes: '', data_source: 'app_manual' },
        { id: 'earlier', description: 'Early summer groceries', amount: 15, entry_date: '2026-06-02', owner_scope: 'joint', notes: '', data_source: 'app_manual' },
      ],
    })
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByText('Groceries'))
    const history = await screen.findByRole('region', { name: 'Expenses transaction history' })
    expect(history).not.toHaveAttribute('tabindex')
    expect(history.querySelector('.entry-day, .entry-check, .entry-actions, [role=checkbox], input[type=checkbox]')).toBeNull()
    const months = Array.from(history.querySelectorAll<HTMLElement>('.entry-month'))
    expect(months).toHaveLength(3)
    expect(within(history).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
      'June 2026', 'March 2026', 'December 2025',
    ])
    expect(Array.from(history.querySelectorAll('.entry-name')).map((label) => label.textContent)).toEqual([
      'Summer groceries', 'Early summer groceries', 'Spring groceries', 'Winter groceries',
    ])
    for (const month of months) {
      expect(month.querySelector('.entry-month-header')?.tagName).not.toBe('BUTTON')
      expect(month.querySelector('[aria-expanded]')).not.toBeInTheDocument()
      for (const row of month.querySelectorAll('.entry-row')) expect(row).toBeVisible()
    }
    await user.click(within(history).getByRole('heading', { name: 'June 2026' }))
    expect(history.querySelectorAll('.entry-row')).toHaveLength(4)

    const winter = within(history).getByRole('button', { name: /Winter groceries/ })
    const spring = within(history).getByRole('button', { name: /Spring groceries/ })
    expect(winter).toHaveClass('entry-row')
    expect(winter).not.toHaveAttribute('aria-pressed')
    fireEvent.contextMenu(winter)
    expect(winter).toHaveAttribute('aria-pressed', 'true')
    expect(spring).toHaveAttribute('aria-pressed', 'false')
    await user.click(spring)
    expect(screen.getByRole('button', { name: 'Delete (2)' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getByRole('button', { name: 'Delete (4)' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(winter).toHaveAttribute('aria-pressed', 'false')
    await user.click(screen.getByRole('button', { name: 'Exit selection' }))

    await user.click(winter)
    const actions = screen.getByRole('dialog', { name: 'Expense actions' })
    expect(within(actions).getByRole('button', { name: 'Delete expense' })).toBeVisible()
    await user.click(within(actions).getByRole('button', { name: 'Edit expense' }))
    const editor = screen.getByRole('dialog', { name: 'Edit expense' })
    expect(within(editor).getByRole('textbox', { name: 'Description (optional)' })).toHaveValue('Winter groceries')
    expect(within(editor).getByLabelText('Date')).toHaveValue('2025-12-03')
    await user.clear(within(editor).getByRole('textbox', { name: 'Description (optional)' }))
    await user.type(within(editor).getByRole('textbox', { name: 'Description (optional)' }), 'Updated groceries')
    await user.click(within(editor).getByRole('button', { name: 'Update expense' }))
    await waitFor(() => expect(api.updateExpenseEntry).toHaveBeenCalledWith('token', 'old', expect.objectContaining({ description: 'Updated groceries', entry_date: '2025-12-03', amount: 10 })))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit expense' })).not.toBeInTheDocument())
    await user.click(within(history).getByRole('button', { name: /Winter groceries/ }))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await user.click(within(screen.getByRole('dialog', { name: 'Expense actions' })).getByRole('button', { name: 'Delete expense' }))
    await waitFor(() => expect(api.deleteExpenseEntry).toHaveBeenCalledWith('token', 'old'))
    confirm.mockRestore()
  })

  it('keeps a failed update and its error inside the edit sheet so it can be retried', async () => {
    api.getExpenseCategoryDetail.mockResolvedValue({
      ...board.categories[1], subcategories: [], monthly_totals: [],
      entries: [{ id: 'manual', description: 'Weekly shop', amount: 10, entry_date: '2026-06-03', owner_scope: 'joint', notes: '', data_source: 'app_manual' }],
    })
    api.updateExpenseEntry.mockRejectedValueOnce(new Error('Expense could not be saved'))
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByText('Groceries'))
    await user.click(await screen.findByRole('button', { name: /Weekly shop/ }))
    await user.click(screen.getByRole('button', { name: 'Edit expense' }))
    const editor = screen.getByRole('dialog', { name: 'Edit expense' })
    await user.click(within(editor).getByRole('button', { name: 'Update expense' }))
    expect(await within(editor).findByText('Expense could not be saved')).toBeVisible()
    expect(editor).toBeVisible()
    expect(within(editor).getByRole('textbox', { name: 'Description (optional)' })).toHaveValue('Weekly shop')
    await user.click(within(editor).getByRole('button', { name: 'Update expense' }))
    await waitFor(() => expect(editor).not.toBeInTheDocument())
    expect(api.updateExpenseEntry).toHaveBeenCalledTimes(2)
  })

  it('enters selection with a long press, suppresses its click, and supports Shift+Space', async () => {
    api.getExpenseCategoryDetail.mockResolvedValue({
      ...board.categories[1], subcategories: [], monthly_totals: [],
      entries: [{ id: 'manual', description: 'Weekly shop', amount: 10, entry_date: '2026-06-03', owner_scope: 'joint', notes: '', data_source: 'app_manual' }],
    })
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByText('Groceries'))
    const row = await screen.findByRole('button', { name: /Weekly shop/ })
    vi.useFakeTimers()
    try {
      fireEvent.pointerDown(row, { pointerId: 1, isPrimary: true, button: 0, clientX: 20, clientY: 20 })
      act(() => vi.advanceTimersByTime(550))
      fireEvent.pointerUp(row, { pointerId: 1 })
      fireEvent.click(row)
      expect(row).toHaveAttribute('aria-pressed', 'true')
      expect(screen.queryByRole('dialog', { name: 'Expense actions' })).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
    await user.click(screen.getByRole('button', { name: 'Exit selection' }))
    row.focus()
    await user.keyboard('{Shift>} {/Shift}')
    expect(row).toHaveAttribute('aria-pressed', 'true')
  })

  it.each(['move', 'cancel', 'scroll'] as const)('does not select after pointer %s cancels a long press', async (reason) => {
    api.getExpenseCategoryDetail.mockResolvedValue({
      ...board.categories[1], subcategories: [], monthly_totals: [],
      entries: [{ id: 'manual', description: 'Weekly shop', amount: 10, entry_date: '2026-06-03', owner_scope: 'joint', notes: '', data_source: 'app_manual' }],
    })
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByText('Groceries'))
    const row = await screen.findByRole('button', { name: /Weekly shop/ })
    vi.useFakeTimers()
    try {
      fireEvent.pointerDown(row, { pointerId: 1, isPrimary: true, button: 0, clientX: 20, clientY: 20 })
      if (reason === 'move') fireEvent.pointerMove(row, { pointerId: 1, clientX: 20, clientY: 40 })
      else if (reason === 'cancel') fireEvent.pointerCancel(row, { pointerId: 1 })
      else fireEvent.scroll(screen.getByRole('dialog'))
      act(() => vi.advanceTimersByTime(550))
      fireEvent.pointerUp(row, { pointerId: 1 })
      expect(row).not.toHaveAttribute('aria-pressed')
      expect(screen.queryByRole('button', { name: 'Exit selection' })).not.toBeInTheDocument()
      expect(screen.queryByRole('dialog', { name: 'Expense actions' })).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('disables loan rows in selection and excludes them from select-all and deletion', async () => {
    api.getExpenseCategoryDetail.mockResolvedValue({
      ...board.categories[1], subcategories: [], monthly_totals: [],
      entries: [
        { id: 'manual', description: 'Weekly shop', amount: 10, entry_date: '2026-06-03', owner_scope: 'joint', notes: '', data_source: 'app_manual' },
        { id: 'loan', description: 'Scheduled repayment', amount: 100, entry_date: '2026-06-01', owner_scope: 'joint', notes: '', data_source: 'loan_schedule' },
      ],
    })
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByText('Groceries'))
    const row = await screen.findByRole('button', { name: /Weekly shop/ })
    fireEvent.contextMenu(row)
    const loan = screen.getByRole('button', { name: /Scheduled loan payment/ })
    expect(loan).toBeDisabled()
    expect(loan).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Delete (1)' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear all' }))
    await user.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getByRole('button', { name: 'Delete (1)' })).toBeInTheDocument()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Delete (1)' }))
    await waitFor(() => expect(api.deleteExpenseEntry).toHaveBeenCalledExactlyOnceWith('token', 'manual'))
    confirm.mockRestore()
  })

  it('requires six distinct months, including when the category filter changes', async () => {
    const user = userEvent.setup()
    renderPage()
    expect(await screen.findByRole('heading', { name: 'Spending trend' })).toBeInTheDocument()
    const filters = screen.getByRole('group', { name: 'Filter by category' })
    await user.click(within(filters).getByRole('button', { name: 'Living' }))
    expect(screen.queryByRole('heading', { name: /Spending trend/ })).not.toBeInTheDocument()
    await user.click(within(filters).getByRole('button', { name: 'Property' }))
    expect(screen.getByRole('heading', { name: 'Spending trend' })).toBeInTheDocument()
    expect(screen.getByText('Property', { selector: '.expense-chart-filter-pill' })).toBeInTheDocument()
    await user.click(within(filters).getByRole('button', { name: /^All$/ }))
    expect(screen.getByRole('heading', { name: 'Spending trend' })).toBeInTheDocument()
    expect(document.querySelector('.expense-chart-filter-pill')).toBeNull()
  })

  it('hides the trend for a short date-filtered response even with duplicate points', async () => {
    board.monthly_totals = board.monthly_totals.filter((point) => point.period <= '2026-03')
    renderPage('month')
    await screen.findByRole('heading', { name: 'Expense mix' })
    expect(screen.queryByRole('heading', { name: /Spending trend/ })).not.toBeInTheDocument()
    expect(api.getExpensesBoard).toHaveBeenCalledWith('token', expect.objectContaining({ start_date: expect.any(String) }))
  })

  it('uses assigned group colors for bars before and after selecting a filter', async () => {
    const user = userEvent.setup()
    const { container } = renderPage()
    await screen.findByRole('heading', { name: 'Expense mix' })
    const bars = () => Array.from(container.querySelectorAll('.stacked-chart__segment'))
    expect(bars().some((bar) => bar.getAttribute('fill') === 'rgb(16 148 111)')).toBe(true)
    expect(bars().some((bar) => bar.getAttribute('fill') === '#12946f')).toBe(true)
    await user.click(within(screen.getByRole('group', { name: 'Filter by category' })).getByRole('button', { name: 'Property' }))
    expect(bars()).toHaveLength(6)
    expect(bars().every((bar) => bar.getAttribute('fill') === 'rgb(16 148 111)')).toBe(true)
  })

  it('keeps Uncategorized grey in the chart, filter, and heading when selected', async () => {
    board.categories.push({ ...board.categories[1], id: 'other', name: 'Other expenses', expense_group_id: null })
    board.monthly_totals.push({ category_id: 'other', period: '2026-01', value: 25 })
    const user = userEvent.setup()
    const { container } = renderPage()
    await screen.findByRole('heading', { name: 'Expense mix' })
    const grey = 'rgb(var(--mist))'
    const bars = () => Array.from(container.querySelectorAll('.stacked-chart__segment'))
    expect(bars().some((bar) => bar.getAttribute('fill') === grey)).toBe(true)
    const filter = within(screen.getByRole('group', { name: 'Filter by category' })).getByRole('button', { name: 'Uncategorized' })
    expect(filter.querySelector('i')).toHaveStyle({ background: grey })
    expect(screen.getByText('Uncategorized', { selector: '.expense-group-name' }).closest('.expense-group-title')?.querySelector('i')).toHaveStyle({ background: grey })
    await user.click(filter)
    expect(bars()).toHaveLength(1)
    expect(bars()[0]).toHaveAttribute('fill', grey)
  })

  it('does not mark protected user-created or legacy categories and groups', async () => {
    board.groups.forEach((group) => { group.can_delete = false; group.is_source_linked = false })
    board.categories.forEach((category) => { category.can_delete = false; category.is_source_linked = false })
    api.getExpenseCategoryDetail.mockImplementation(async () => ({
      ...board.categories[0], subcategories: [], monthly_totals: [],
      entries: [{ id: 'manual', description: 'Manual payment', amount: 100, owner_scope: 'joint', notes: '', data_source: 'app_manual' }],
    }))
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Mortgage')
    expect(screen.queryByRole('img', { name: 'Inherited from a source' })).not.toBeInTheDocument()
    await user.click(screen.getByText('Mortgage'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByRole('img', { name: 'Inherited from a source' })).not.toBeInTheDocument()
  })

  it('does not mark manual groups inside a source-linked property category', async () => {
    board.categories[0].is_source_linked = false
    const user = userEvent.setup()
    const { container } = renderPage()
    const label = await screen.findByText('Mortgage')
    expect(within(label.closest('button') as HTMLElement).queryByRole('img', { name: 'Inherited from a source' })).not.toBeInTheDocument()
    expect(container.querySelectorAll('.expense-inherited-icon')).toHaveLength(1)
    await user.click(label)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getAllByRole('img', { name: 'Inherited from a source' })).toHaveLength(1)
    expect(within(dialog).getByText('Scheduled loan payment')).toBeInTheDocument()
  })

  it('marks inherited labels and scheduled entries, but not manually created labels', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('Mortgage')
    const property = screen.getByRole('button', { name: 'Category options for Property' }).closest('.expense-group-panel')
    expect(property).not.toBeNull()
    expect(within(property as HTMLElement).getAllByRole('img', { name: 'Inherited from a source' })).toHaveLength(2)
    const manual = screen.getByText('Groceries').closest('button')
    expect(within(manual as HTMLElement).queryByRole('img', { name: 'Inherited from a source' })).not.toBeInTheDocument()
    const monthly = property?.querySelector<HTMLElement>('.expense-group-monthly') ?? null
    const header = property?.querySelector('.panel__header')
    expect(header).toContainElement(screen.getByRole('button', { name: 'Category options for Property' }))
    expect(header).not.toContainElement(monthly)
    expect(monthly?.previousElementSibling).toBe(header)
    await user.click(screen.getByText('Mortgage'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getAllByRole('img', { name: 'Inherited from a source' })).toHaveLength(2)
    expect(within(dialog).getByText('Scheduled loan payment')).toBeInTheDocument()
  })
})
