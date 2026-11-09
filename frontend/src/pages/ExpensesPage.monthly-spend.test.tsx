import { render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExpensesPage } from './ExpensesPage'
import type { ExpenseCategorySummary, ExpensesBoard } from '../types'
import { fmtMoney } from '../lib/format'
import type { DateRangeKey } from '../lib/format'

const api = vi.hoisted(() => ({
  getExpensesBoard: vi.fn(),
  getCategories: vi.fn(async () => []),
  getAssets: vi.fn(async () => []),
  getRecurringExpenses: vi.fn(async () => []),
}))
vi.mock('../lib/api', () => ({ api }))
vi.mock('../lib/session', () => ({ useSession: () => ({ token: 'token', currency: 'PLN', setError: vi.fn(), setMessage: vi.fn() }) }))

function category(id: string, group: string, sort_order: number): ExpenseCategorySummary {
  return {
    id, name: id, expense_group_id: group, sort_order,
    is_system: false, is_retired: false, can_delete: true, is_source_linked: false,
    monthly_average: 999, total_amount: 777, entry_count: 4,
  }
}

let filteredBoard: ExpensesBoard
let monthlyBoard: ExpensesBoard
const monthlyRange = { start_date: '2025-10-01', end_date: '2026-01-31' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 0, 31, 23, 30))
  filteredBoard = {
    groups: [
      { id: 'living', name: 'Living', color: '', notes: '', sort_order: 0, is_retired: false, can_delete: true, is_source_linked: false },
      { id: 'property', name: 'Property', color: '', notes: '', sort_order: 1, is_retired: false, can_delete: true, is_source_linked: false },
    ],
    categories: [category('Groceries', 'living', 0), category('Dining', 'living', 1), category('Mortgage', 'property', 2), category('Repairs', 'property', 3)],
    monthly_totals: [
      { category_id: 'Groceries', period: '2024-01', value: 9000 },
      { category_id: 'Dining', period: '2026-01', value: 400 },
      { category_id: 'Mortgage', period: '2026-02', value: 9999 },
    ],
  }
  monthlyBoard = {
    ...structuredClone(filteredBoard),
    monthly_totals: [
      { category_id: 'Groceries', period: '2025-10', value: 30 },
      { category_id: 'Dining', period: '2025-12', value: 60 },
      { category_id: 'Mortgage', period: '2025-11', value: 210 },
      { category_id: 'Repairs', period: '2025-12', value: 120 },
      { category_id: 'Groceries', period: '2026-01', value: 200 },
      { category_id: 'Dining', period: '2026-01', value: 100 },
      { category_id: 'Mortgage', period: '2026-01', value: 5 },
      { category_id: 'Repairs', period: '2026-01', value: 10 },
    ],
  }
  api.getExpensesBoard.mockImplementation(async (_token: string, range: { start_date?: string; end_date?: string }) => structuredClone(
    range.start_date === monthlyRange.start_date ? monthlyBoard : filteredBoard,
  ))
})

afterEach(() => vi.useRealTimers())

function renderPage(dateRange: DateRangeKey = 'all', showForecast = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const page = (range: DateRangeKey, forecast: boolean) => <QueryClientProvider client={client}><ExpensesPage dateRange={range} showForecast={forecast} /></QueryClientProvider>
  const result = render(page(dateRange, showForecast))
  return { ...result, rerenderPage: (range: DateRangeKey, forecast = false) => result.rerender(page(range, forecast)) }
}

function expectSpending(container: HTMLElement, currentMonth = false) {
  const panels = Array.from(container.querySelectorAll<HTMLElement>('.expense-group-panel'))
  expect(panels.map((panel) => panel.querySelector('.expense-group-name')?.textContent)).toEqual(currentMonth ? ['Living', 'Property'] : ['Property', 'Living'])
  const expected = currentMonth
    ? [{ names: ['Groceries', 'Dining'], amounts: [200, 100], total: 300 }, { names: ['Repairs', 'Mortgage'], amounts: [10, 5], total: 15 }]
    : [{ names: ['Mortgage', 'Repairs'], amounts: [70, 40], total: 110 }, { names: ['Dining', 'Groceries'], amounts: [20, 10], total: 30 }]
  for (const [index, panel] of panels.entries()) {
    const rows = within(panel).getAllByRole('button').filter((button) => button.classList.contains('detail-row'))
    expect(rows.map((row) => row.querySelector('.expense-category-label')?.textContent)).toEqual(expected[index].names)
    expect(rows.map((row) => row.querySelector('strong')?.textContent)).toEqual(expected[index].amounts.map((amount) => `${fmtMoney(amount, 'PLN')} / mo`))
    expect(panel.querySelector('.expense-group-monthly')?.textContent).toBe(`${fmtMoney(expected[index].total, 'PLN')} / mo`)
  }
}

describe('expense monthly spend', () => {
  it('keeps a separate calendar-month query and sorts both levels by displayed spend across date filters', async () => {
    const { container, rerenderPage } = renderPage()
    await waitFor(() => expectSpending(container))
    expect(api.getExpensesBoard).toHaveBeenCalledWith('token', monthlyRange)
    expect(api.getExpensesBoard).toHaveBeenCalledWith('token', { end_date: '2026-01-31' })
    expect(screen.getByLabelText('Expenses summary').textContent).toContain(fmtMoney(3108, 'PLN'))

    for (const [range, start] of [['6m', '2025-08-01'], ['12m', '2025-02-01'], ['ytd', '2026-01-01']] as const) {
      rerenderPage(range)
      await waitFor(() => expect(api.getExpensesBoard).toHaveBeenCalledWith('token', { start_date: start, end_date: '2026-01-31' }))
      await waitFor(() => expectSpending(container))
    }

    rerenderPage('month')
    await waitFor(() => expectSpending(container, true))
    rerenderPage('all')
    await waitFor(() => expectSpending(container))
    expect(api.getExpensesBoard.mock.calls.filter(([, range]) => range.start_date === monthlyRange.start_date).every(([, range]) => range.end_date === '2026-01-31')).toBe(true)
  })

  it('sorts Uncategorized among top-level panels by its displayed monthly spend', async () => {
    const uncategorized = { ...category('Other', 'unused', 4), expense_group_id: null }
    filteredBoard.categories.push(uncategorized)
    monthlyBoard.categories.push(structuredClone(uncategorized))
    monthlyBoard.monthly_totals.push({ category_id: 'Other', period: '2025-12', value: 240 })
    monthlyBoard.monthly_totals.push({ category_id: 'Other', period: '2026-01', value: 400 })
    const { container, rerenderPage } = renderPage()
    const panelNames = () => Array.from(container.querySelectorAll('.expense-group-name')).map((element) => element.textContent)

    await waitFor(() => expect(panelNames()).toEqual(['Property', 'Uncategorized', 'Living']))
    rerenderPage('month')
    await waitFor(() => expect(panelNames()).toEqual(['Uncategorized', 'Living', 'Property']))
  })

  it('does not apply forecast or filtered-board amounts to monthly spend while retaining filtered main totals', async () => {
    const { container, rerenderPage } = renderPage('all', true)
    await waitFor(() => expectSpending(container))
    expect(api.getExpensesBoard).toHaveBeenCalledWith('token', { include_planned: true })
    expect(api.getExpensesBoard).toHaveBeenCalledWith('token', monthlyRange)

    filteredBoard.categories = filteredBoard.categories.map((value) => ({ ...value, total_amount: 42 }))
    rerenderPage('month', true)
    await waitFor(() => expect(api.getExpensesBoard).toHaveBeenCalledWith('token', { start_date: '2026-01-01', end_date: '2026-01-31', include_planned: true }))
    await waitFor(() => expectSpending(container, true))
    await waitFor(() => expect(screen.getByLabelText('Expenses summary').textContent).toContain(fmtMoney(168, 'PLN')))
    expect(api.getExpensesBoard.mock.calls.filter(([, range]) => range.start_date === monthlyRange.start_date).every(([, range]) => range.include_planned === undefined)).toBe(true)
  })
})
