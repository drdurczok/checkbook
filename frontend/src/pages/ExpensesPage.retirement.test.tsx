import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExpensesPage } from './ExpensesPage'
import type { ExpensesBoard, ExpenseCategoryDetail, ExpenseCategoryPayload, ExpenseGroupPayload } from '../types'

const api = vi.hoisted(() => ({
  getExpensesBoard: vi.fn(),
  getDashboardOverview: vi.fn(),
  getCategories: vi.fn(async () => []),
  getAssets: vi.fn(async () => []),
  getExpenseCategoryDetail: vi.fn(),
  updateExpenseGroup: vi.fn(),
  updateExpenseCategory: vi.fn(),
}))
vi.mock('../lib/api', () => ({ api }))
vi.mock('../lib/session', () => ({ useSession: () => ({ token: 'token', currency: 'PLN', setError: vi.fn(), setMessage: vi.fn() }) }))

let board: ExpensesBoard
let detail: ExpenseCategoryDetail

function renderPage(showRetired = false, showForecast = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={client}><ExpensesPage showRetired={showRetired} showForecast={showForecast} /></QueryClientProvider>)
  return { ...view, setShowRetired: (value: boolean) => view.rerender(<QueryClientProvider client={client}><ExpensesPage showRetired={value} showForecast={showForecast} /></QueryClientProvider>) }
}

beforeEach(() => {
  vi.clearAllMocks()
  board = {
    monthly_totals: [{ category_id: 'category', period: '2026-01', value: 120 }],
    groups: [{ id: 'group', name: 'Property', color: '', notes: '', sort_order: 0, is_retired: false, can_delete: false, is_source_linked: true }],
    categories: [{ id: 'category', name: 'Mortgage', expense_group_id: 'group', parent_id: null, is_system: false, sort_order: 0, total_amount: 120, monthly_average: 120, entry_count: 1, is_retired: false, can_delete: false, is_source_linked: true }],
  }
  detail = { ...board.categories[0], subcategories: [], monthly_totals: [], entries: [] }
  api.getExpensesBoard.mockImplementation(async () => structuredClone(board))
  api.getExpenseCategoryDetail.mockImplementation(async () => structuredClone(detail))
  api.getDashboardOverview.mockResolvedValue({ expense_breakdown: [], expense_trend_by_category: [] })
  api.updateExpenseGroup.mockImplementation(async (_token: string, _id: string, payload: ExpenseGroupPayload) => {
    board.groups[0] = { ...board.groups[0], ...payload }
    return board.groups[0]
  })
  api.updateExpenseCategory.mockImplementation(async (_token: string, _id: string, payload: ExpenseCategoryPayload) => {
    board.categories[0] = { ...board.categories[0], ...payload }
    detail = { ...detail, ...payload }
    return board.categories[0]
  })
})

describe('expense retirement', () => {
  it('shows monthly loan schedules without editable actions or bulk-selection access', async () => {
    detail.monthly_totals = [{ period: '2026-01', value: 120 }, { period: '2027-02', value: 120 }]
    detail.entries = [
      { id: 'scheduled-future', description: 'Mortgage', amount: 120, entry_date: '2027-02-01', owner_scope: 'joint', notes: '', data_source: 'loan_schedule', extra_payload: { read_only: true } },
      { id: 'scheduled-past', description: 'Mortgage', amount: 120, entry_date: '2026-01-01', owner_scope: 'joint', notes: '', data_source: 'loan_schedule', extra_payload: { read_only: true } },
    ]
    const user = userEvent.setup()
    renderPage(false, true)
    await user.click(await screen.findByText('Mortgage'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('February 2027')).toBeInTheDocument()
    expect(within(dialog).getByText('January 2026')).toBeInTheDocument()
    expect(within(dialog).getAllByText('Scheduled loan payment')).toHaveLength(2)
    expect(within(dialog).queryByRole('button', { name: 'Edit expense' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('button', { name: 'Delete expense' })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument()
    const rows = dialog.querySelectorAll<HTMLButtonElement>('button.entry-row')
    expect(rows).toHaveLength(2)
    await user.click(rows[0])
    const actions = screen.getByRole('dialog', { name: 'Expense actions' })
    expect(within(actions).getByText(/read.only/i)).toBeInTheDocument()
    expect(within(actions).queryByRole('button', { name: 'Edit expense' })).not.toBeInTheDocument()
    expect(within(actions).queryByRole('button', { name: 'Delete expense' })).not.toBeInTheDocument()
  })

  it('hides retired categories and their children by default, then shows them greyed', async () => {
    board.groups[0].is_retired = true
    const view = renderPage()
    await screen.findByRole('button', { name: 'Add expense' })
    expect(screen.queryByText('Property')).not.toBeInTheDocument()
    expect(screen.queryByText('Mortgage')).not.toBeInTheDocument()
    view.setShowRetired(true)
    const title = await screen.findByText('Property', { selector: '.expense-group-name' })
    expect(title.closest('.expense-group-panel')).toHaveClass('expense-group-panel--retired')
    expect(screen.getByText('Mortgage')).toBeInTheDocument()
  })

  it('hides a retired child but keeps its active parent', async () => {
    board.categories[0].is_retired = true
    const view = renderPage()
    await screen.findByText('Property', { selector: '.expense-group-name' })
    expect(screen.queryByText('Mortgage')).not.toBeInTheDocument()
    view.setShowRetired(true)
    expect((await screen.findByText('Mortgage')).closest('button')).toHaveClass('expense-row--retired')
  })

  it('protects an automatic category from deletion and retires/unretires it from options', async () => {
    const user = userEvent.setup()
    const view = renderPage()
    await user.click(await screen.findByRole('button', { name: 'Category options for Property' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit category' }))
    const dialog = screen.getByRole('dialog', { name: 'Edit category' })
    expect(within(dialog).queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Retire' }))
    await waitFor(() => expect(api.updateExpenseGroup).toHaveBeenCalledWith('token', 'group', expect.objectContaining({ is_retired: true })))
    await waitFor(() => expect(screen.queryByText('Mortgage')).not.toBeInTheDocument())
    view.setShowRetired(true)
    await user.click(await screen.findByRole('button', { name: 'Category options for Property' }))
    await user.click(screen.getByRole('menuitem', { name: 'Unretire category' }))
    await waitFor(() => expect(api.updateExpenseGroup).toHaveBeenLastCalledWith('token', 'group', expect.objectContaining({ is_retired: false })))
  })

  it('protects an automatic group in its editor and supports retirement both ways', async () => {
    const user = userEvent.setup()
    const view = renderPage()
    await user.click(await screen.findByText('Mortgage'))
    await user.click(screen.getByRole('button', { name: 'Group actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit group' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Retire' }))
    await waitFor(() => expect(api.updateExpenseCategory).toHaveBeenCalledWith('token', 'category', expect.objectContaining({ is_retired: true })))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    view.setShowRetired(true)
    await user.click(await screen.findByText('Mortgage'))
    await user.click(screen.getByRole('button', { name: 'Group actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Unretire group' }))
    await waitFor(() => expect(api.updateExpenseCategory).toHaveBeenLastCalledWith('token', 'category', expect.objectContaining({ is_retired: false })))
  })

  it('keeps delete available for manually created categories and groups', async () => {
    board.groups[0].can_delete = true
    detail.can_delete = true
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Category options for Property' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit category' }))
    expect(screen.getByRole('button', { name: 'Delete category Property' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await user.click(screen.getByText('Mortgage'))
    await user.click(screen.getByRole('button', { name: 'Group actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit group' }))
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })
})
