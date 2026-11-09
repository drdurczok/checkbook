import { expect, test } from '@playwright/test'

for (const width of [390, 1280]) {
  test(`linked property utility expense history at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
    let detailRequests = 0
    let utilityRequests = 0
    let writes = 0
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.includes('/expense-categories/')) detailRequests += 1
      if (url.pathname.includes('/utilities')) utilityRequests += 1
      if (route.request().method() !== 'GET') writes += 1
      const category = { id: 'house', utility_property_id: 'house', name: 'Utilities', expense_group_id: 'bucket', is_system: true, is_retired: false, can_delete: false, is_source_linked: true, sort_order: 0, total_amount: 90, monthly_average: 45, entry_count: 3 }
      const json = url.pathname.endsWith('/auth/session') ? {
        token: 'utility-expenses', expires_at: '2099-01-01T00:00:00Z',
        user: { id: 'u', email: 'u@example.com', full_name: 'User', picture_url: '' },
        household: { id: 'h', name: 'Household', base_currency: 'PLN', timezone: 'Europe/Warsaw' },
        membership: { id: 'm', role: 'owner', relationship_kind: 'owner' },
        settings: { id: 's', privacy_mode: 'household', allow_cross_member_visibility: true, projection_baseline_window_months: 12, projection_horizon_months: 24, savings_allocation_strategy: 'default', role_permissions: {} },
      } : url.pathname.endsWith('/expenses/board') ? {
        groups: [{ id: 'bucket', name: 'Family home', color: '', notes: '', sort_order: 0, is_retired: false, can_delete: false, is_source_linked: true }],
        categories: [category],
        monthly_totals: [{ category_id: 'house', period: '2026-06', value: 60 }, { category_id: 'house', period: '2026-05', value: 30 }],
      } : url.pathname.includes('/expense-categories/house') ? {
        ...category, subcategories: [],
        monthly_totals: [{ period: '2026-05', value: 30 }, { period: '2026-06', value: 60 }],
        entries: [
          { id: 'electric', description: 'Electricity', amount: 40, entry_date: '2026-06-15', owner_scope: 'joint', notes: '', data_source: 'utility_bill' },
          { id: 'water', description: 'Water', amount: 20, entry_date: '2026-06-01', owner_scope: 'joint', notes: '', data_source: 'utility_bill' },
          { id: 'gas', description: 'Gas', amount: 30, entry_date: '2026-05-01', owner_scope: 'joint', notes: '', data_source: 'utility_bill' },
          { id: 'future', description: 'Future electricity', amount: 50, entry_date: '2099-01-01', owner_scope: 'joint', notes: '', data_source: 'utility_bill' },
        ],
      } : []
      await route.fulfill({ json })
    })
    await page.addInitScript(() => localStorage.setItem('checkbook.session', 'utility-expenses'))
    await page.goto('/expenses')
    await page.getByText('Utilities', { exact: true }).click()
    const dialog = page.getByRole('dialog', { name: /Utilities/ })
    const history = dialog.getByRole('region', { name: 'Expenses transaction history' })
    await expect(history.getByRole('heading', { name: 'June 2026' })).toBeVisible()
    await expect(history.getByRole('button', { name: /Electricity/ })).toContainText('PLN 40')
    await expect(history.getByRole('button', { name: /Water/ })).toContainText('PLN 20')
    await expect(history.getByRole('button', { name: /Gas/ })).toContainText('PLN 30')
    await expect(history.getByText('Future electricity', { exact: true })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: /Edit utility values|Add expense|Details/ })).toHaveCount(0)
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: `test-results/utility-expenses-${width}.png`, fullPage: true })
    await history.getByRole('button', { name: /Electricity/ }).click()
    const actions = page.getByRole('dialog', { name: 'Expense actions', exact: true })
    await expect(actions.getByText(/Utility bills are read-only here/)).toBeVisible()
    await expect(actions.getByRole('button', { name: /Edit expense|Delete expense|Select expenses/ })).toHaveCount(0)
    await actions.getByRole('button', { name: 'Close', exact: true }).click()
    await dialog.getByRole('button', { name: 'Close group details', exact: true }).click()
    expect(detailRequests).toBe(1)
    expect(utilityRequests).toBe(0)
    expect(writes).toBe(0)
    expect(errors).toEqual([])
  })
}
