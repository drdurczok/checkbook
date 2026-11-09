import { test, expect } from '@playwright/test'
import type { ExpenseCategorySummary } from '../src/contracts/expenses'

const settings = { id: 's', privacy_mode: 'private_joint', allow_cross_member_visibility: false, projection_baseline_window_months: 6, projection_horizon_months: 18, savings_allocation_strategy: 'keep_cash_positive', role_permissions: {} }
const session = { token: 'monthly-spend', expires_at: '2099-01-01T00:00:00Z', user: { id: 'u', email: 'u@example.com', full_name: 'User', picture_url: '' }, household: { id: 'h', name: 'House', base_currency: 'PLN', timezone: 'Europe/Warsaw' }, membership: { id: 'm', role: 'owner', relationship_kind: 'owner' }, settings }

function category(id: string, expense_group_id: string | null, sort_order: number): ExpenseCategorySummary {
  return { id, name: id, expense_group_id, sort_order, is_system: false, is_retired: false, can_delete: true, is_source_linked: false, total_amount: 9999, monthly_average: 999, entry_count: 1 }
}

for (const width of [390, 1280]) {
  test(`monthly expense values and ordering remain independent of date filters at ${width}px`, async ({ page }) => {
    const errors: string[] = []
    const boardRequests: URL[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
    await page.setViewportSize({ width, height: 900 })
    await page.clock.setFixedTime(new Date(2026, 0, 31, 12))
    const groups = [
      { id: 'living', name: 'Living', color: '', notes: '', sort_order: 0, is_retired: false, can_delete: true, is_source_linked: false },
      { id: 'property', name: 'Property', color: '', notes: '', sort_order: 1, is_retired: false, can_delete: true, is_source_linked: false },
    ]
    const categories = [category('Groceries', 'living', 0), category('Dining', 'living', 1), category('Mortgage', 'property', 2), category('Repairs', 'property', 3), category('Other', null, 4)]
    const monthlyTotals = [
      { category_id: 'Groceries', period: '2025-10', value: 30 },
      { category_id: 'Dining', period: '2025-12', value: 60 },
      { category_id: 'Mortgage', period: '2025-11', value: 210 },
      { category_id: 'Repairs', period: '2025-12', value: 120 },
      { category_id: 'Other', period: '2025-12', value: 240 },
      { category_id: 'Groceries', period: '2026-01', value: 200 },
      { category_id: 'Dining', period: '2026-01', value: 100 },
      { category_id: 'Mortgage', period: '2026-01', value: 5 },
      { category_id: 'Repairs', period: '2026-01', value: 10 },
      { category_id: 'Other', period: '2026-01', value: 400 },
    ]
    await page.route('http://127.0.0.1:4174/api/**', async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/household/expenses/board') boardRequests.push(url)
      const json = url.pathname === '/api/auth/session' ? session
        : url.pathname === '/api/household/expenses/board' ? {
          groups, categories,
          monthly_totals: url.searchParams.get('start_date') === '2025-10-01' ? monthlyTotals : [{ category_id: 'Groceries', period: '2024-01', value: 9000 }],
        } : []
      await route.fulfill({ json })
    })
    await page.addInitScript(() => localStorage.setItem('checkbook.session', 'monthly-spend'))
    await page.goto('/expenses')
    const panels = page.locator('.expense-group-panel')
    await expect(panels.locator('.expense-group-name')).toHaveText(['Property', 'Uncategorized', 'Living'])
    await expect(panels.locator('.detail-row .expense-category-label')).toHaveText(['Mortgage', 'Repairs', 'Other', 'Dining', 'Groceries'])
    await expect(panels.locator('.detail-row strong')).toHaveText([/70.*\/ mo/, /40.*\/ mo/, /80.*\/ mo/, /20.*\/ mo/, /10.*\/ mo/])
    expect(boardRequests.some((url) => url.searchParams.get('start_date') === '2025-10-01' && url.searchParams.get('end_date') === '2026-01-31')).toBe(true)
    expect(boardRequests.some((url) => !url.searchParams.has('start_date') && url.searchParams.get('end_date') === '2026-01-31')).toBe(true)
    expect(await page.locator('.expenses-page').evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    await panels.first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: `test-results/expense-monthly-spend-${width}.png`, fullPage: true })

    await page.locator('.app-content').evaluate((node) => { node.scrollTop = 0 })
    await page.getByRole('button', { name: 'Date range', exact: true }).click()
    await page.getByRole('option', { name: 'Current month', exact: true }).click()
    await expect(panels.locator('.expense-group-name')).toHaveText(['Uncategorized', 'Living', 'Property'])
    await expect(panels.locator('.detail-row .expense-category-label')).toHaveText(['Other', 'Groceries', 'Dining', 'Repairs', 'Mortgage'])
    await expect(panels.locator('.detail-row strong')).toHaveText([/400.*\/ mo/, /200.*\/ mo/, /100.*\/ mo/, /10.*\/ mo/, /5.*\/ mo/])
    await expect.poll(() => boardRequests.some((url) => url.searchParams.get('start_date') === '2026-01-01')).toBe(true)
    expect(boardRequests.filter((url) => url.searchParams.get('start_date') === '2025-10-01').every((url) => url.searchParams.get('end_date') === '2026-01-31' && !url.searchParams.has('include_planned'))).toBe(true)
    expect(await page.locator('.expenses-page').evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: `test-results/expense-current-month-spend-${width}.png`, fullPage: true })
    expect(errors).toEqual([])
  })
}
