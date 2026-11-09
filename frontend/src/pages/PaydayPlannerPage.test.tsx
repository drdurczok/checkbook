import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaydayPlanner } from '../contracts/payday-planner'
import { api } from '../lib/api'
import { HeaderSlotProvider, useHeaderSlotContext } from '../lib/header-slot'
import { PaydayPlannerPage } from './PaydayPlannerPage'
import { PaydayPlannerAnalysisPage } from './PaydayPlannerAnalysisPage'

vi.mock('../lib/session', () => ({ useSession: () => ({ token: 'token', setError: vi.fn(), setMessage: vi.fn() }) }))
vi.mock('../lib/api', () => ({ api: { getPaydayPlanner: vi.fn(), deletePaydayAllocation: vi.fn(), updatePaydayAllocation: vi.fn(), getExpensesBoard: vi.fn(), getExpenseCategoryDetail: vi.fn() } }))
const bundle: PaydayPlanner = {
  month: '2026-01', current_month: '2026-01', currency: 'USD', provisional: true, income: '100.00', total_allocated: '110.00', remaining: '-10.00', completed_total: '0.00', actual_total: '35.00', unplanned_actual_total: '5.00', templates: [], suggestions: [], unplanned_actuals: [{ category_id: null, subcategory_id: null, category_name: 'Uncategorized', subcategory_name: null, amount: '5.00' }],
  allocations: [{ id: 'a', expense_group_name: 'Essentials', title: 'Groceries', section: 'monthly', kind: 'expense', category_id: 'food', subcategory_id: null, category_name: 'Food', subcategory_name: null, amount: '110.00', notes: '', source: 'manual', template_id: null, completed: false, completed_at: null, actual_amount: '30.00', difference: '-80.00', percentage: '-72.73' }],
}
function TestHeader() {
  const { headerControls } = useHeaderSlotContext()
  return <header aria-label="App header">{headerControls}</header>
}
function renderPage(analysis = false, path = "/") {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><MemoryRouter initialEntries={[path]}><HeaderSlotProvider><TestHeader />{analysis ? <PaydayPlannerAnalysisPage /> : <PaydayPlannerPage />}</HeaderSlotProvider></MemoryRouter></QueryClientProvider>)
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getPaydayPlanner).mockResolvedValue(bundle)
  vi.mocked(api.updatePaydayAllocation).mockResolvedValue({ ...bundle, allocations: [{ ...bundle.allocations[0], completed: true }] })
})
describe('payday planner page', () => {
  it('orders each section by position and starts new allocations after its last item', async () => {
    const user = userEvent.setup()
    const allocation = bundle.allocations[0]
    vi.mocked(api.getPaydayPlanner).mockResolvedValue({ ...bundle, allocations: [
      { ...allocation, id: 'late', title: 'Later', position: 8 },
      { ...allocation, id: 'early', title: 'Earlier', position: 1 },
    ] })
    vi.mocked(api.getExpensesBoard).mockResolvedValue({ groups: [], categories: [], monthly_totals: [] })
    renderPage()
    await screen.findByRole('button', { name: 'Earlier, 110.00' })
    expect(Array.from(document.querySelectorAll('.planner-item__title')).map((item) => item.textContent)).toEqual(['Earlier', 'Later'])
    await user.click(screen.getByTitle('Add to Additional Payments'))
    expect(await screen.findByRole('spinbutton', { name: 'Position' })).toHaveValue(9)
  })
  it('uses backend household current month, warns about negative balance, and labels actuals', async () => {
    renderPage()
    expect(await screen.findByText('-10.00')).toHaveClass('planner-negative')
    expect(screen.queryByRole('heading', { name: 'Monthly Income Calculator' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Current month' })).not.toBeInTheDocument()
    expect(screen.queryByText(/available to allocate/)).not.toBeInTheDocument()
    expect(within(screen.getByRole('banner', { name: 'App header' })).getByLabelText('Month and year')).toBeInTheDocument()
    expect(api.getPaydayPlanner).toHaveBeenCalledWith('token', undefined)
    expect(screen.getByLabelText('Month and year')).toHaveValue('2026-01')
    expect(screen.queryByRole('link', { name: 'Back to Planning' })).not.toBeInTheDocument()
    expect(screen.getByText('January 2026')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit Groceries' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Mandatory Payments' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Additional Payments' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Manage mandatory templates' })).not.toBeInTheDocument()
    expect(screen.getByText('Essentials')).toHaveClass('planner-item__category')
    expect(screen.getByRole('heading', { name: 'Flexible Allocations' })).toBeInTheDocument()
    expect(screen.queryByText('Provisional - actual spending may still change')).not.toBeInTheDocument()
    expect(screen.queryByText(/Expense allocations match recorded spending/)).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Use Suggested' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Analyze' })).toHaveAttribute('href', '/planning/analyze?month=2026-01')
    expect(document.querySelectorAll('.planner-section.card')).toHaveLength(3)
    expect(screen.queryByText('Nothing planned yet')).not.toBeInTheDocument()
    expect(screen.queryByText(/New months start with snapshots/)).not.toBeInTheDocument()
    expect(screen.queryByText('Add an allocation to plan your spending.')).not.toBeInTheDocument()
    for (const add of screen.getAllByRole('button', { name: 'Add' })) {
      expect(add).toHaveClass('planner-section__add')
      expect(add.textContent).toBe('')
      expect(add).toHaveAttribute('title')
    }
    expect(document.querySelector('.planner-item__amount')?.textContent).toBe('110.00')
    expect(document.querySelector('.planner-item__currency')).toBeNull()
  })
  it('shows analysis tabs and retains selected month in the return link and month navigation', async () => {
    const user = userEvent.setup()
    renderPage(true, '/planning/analyze?month=2026-01')
    await screen.findByRole('table')
    expect(within(screen.getByRole('table')).getByText('30.00')).toBeInTheDocument()
    expect(within(screen.getByRole('table')).queryByRole('columnheader', { name: 'Difference %' })).not.toBeInTheDocument()
    const difference = within(screen.getByRole('table')).getByText('-80.00')
    expect(difference).toHaveTextContent('-80.00 (-72.73%)')
    expect(difference).not.toHaveClass('planner-difference--under', 'planner-difference--large')
    expect(within(difference).getByText('(-72.73%)')).toHaveClass('planner-difference--under', 'planner-difference--large')
    expect(screen.getByRole('table').textContent).not.toContain('$')
    expect(screen.getByRole('tab', { name: 'Planned vs Actual' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByText(/Actual expenses without/)).not.toBeInTheDocument()
    screen.getByRole('tab', { name: 'Planned vs Actual' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Unplanned Actual' })).toHaveFocus()
    expect(screen.getByRole('tab', { name: 'Unplanned Actual' })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: 'Planned vs Actual' })).toHaveFocus()
    await user.keyboard('{End}')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByText(/Actual expenses without a matching planned allocation/)).toHaveTextContent('$5.00')
    expect(screen.getByRole('link', { name: 'Close analysis' })).toHaveAttribute('href', '/planning?month=2026-01')
    await user.click(screen.getByRole('button', { name: 'Previous month' }))
    await waitFor(() => expect(api.getPaydayPlanner).toHaveBeenCalledWith('token', '2025-12'))
    expect(screen.getByRole('link', { name: 'Close analysis' })).toHaveAttribute('href', '/planning?month=2025-12')
  })
  it('loads a bookmarked month on the main page', async () => {
    renderPage(false, '/planning?month=2026-02')
    await screen.findByRole('link', { name: 'Analyze' })
    expect(api.getPaydayPlanner).toHaveBeenCalledWith('token', '2026-02')
    expect(screen.getByRole('link', { name: 'Analyze' })).toHaveAttribute('href', '/planning/analyze?month=2026-02')
  })
  it('navigates across years and persists completion without changing the amount', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('-10.00')
    const card = screen.getByRole('button', { name: 'Groceries, 110.00' })
    card.focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(api.updatePaydayAllocation).toHaveBeenCalledWith('token', 'a', expect.objectContaining({ amount: '110.00', completed: true, month: '2026-01' })))
    await user.click(screen.getByRole('button', { name: 'Previous month' }))
    await waitFor(() => expect(api.getPaydayPlanner).toHaveBeenCalledWith('token', '2025-12'))
  })
  it('opens the editor directly and deletes only after confirmation', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getExpensesBoard).mockResolvedValue({ groups: [], categories: [], monthly_totals: [] })
    vi.mocked(api.getExpenseCategoryDetail).mockResolvedValue({ id: 'food', name: 'Food', is_system: false, is_retired: false, can_delete: true, is_source_linked: false, sort_order: 0, subcategories: [], entries: [], monthly_totals: [] })
    vi.mocked(api.deletePaydayAllocation).mockResolvedValue({ ok: true })
    renderPage()
    const card = await screen.findByRole('button', { name: 'Groceries, 110.00' })
    card.focus()
    await user.keyboard('{Shift>}{F10}{/Shift}')
    expect(await screen.findByRole('button', { name: 'Done' })).toBeVisible()
    expect(api.updatePaydayAllocation).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Delete allocation' }))
    expect(screen.getByRole('dialog', { name: 'Delete Groceries?' })).toBeVisible()
    expect(api.deletePaydayAllocation).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Confirm delete' }))
    await waitFor(() => expect(api.deletePaydayAllocation).toHaveBeenCalledWith('token', 'a'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
  it('renders a recoverable server error rather than showing a zero income plan', async () => {
    vi.mocked(api.getPaydayPlanner).mockRejectedValue(new Error('Income unavailable'))
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('Income unavailable')
    expect(screen.queryByText('Net income')).not.toBeInTheDocument()
  })
})
