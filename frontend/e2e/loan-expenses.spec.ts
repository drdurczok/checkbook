import { expect, test } from '@playwright/test'

for (const width of [390, 1280]) {
  test(`monthly loan schedules appear in their expense group at ${width}px`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
    const group = { id: 'property', name: 'Home', color: '30 111 214', notes: '', sort_order: 0, is_retired: false, can_delete: false }
    const category = { id: 'loan', name: 'Mortgage', parent_id: null, expense_group_id: 'property', is_system: false, sort_order: 0, total_amount: 200, monthly_average: 100, entry_count: 2, is_retired: false, can_delete: false }
    const monthly = [{ period: '2026-01', value: 100 }, { period: '2027-02', value: 100 }]
    await page.clock.setFixedTime(new Date('2026-10-15T12:00:00Z'))
    await page.setViewportSize({ width, height: 900 })
    await page.route('http://127.0.0.1:4174/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      const json = path === '/api/auth/session' ? {
        token: 'loan-expenses', expires_at: '2099-01-01T00:00:00Z', user: { id: 'u', email: 'u@example.com', full_name: 'User', picture_url: '' },
        household: { id: 'h', name: 'House', base_currency: 'PLN', timezone: 'Europe/Warsaw' }, membership: { id: 'm', role: 'owner', relationship_kind: 'owner' },
        settings: { id: 's', privacy_mode: 'private_joint', allow_cross_member_visibility: false, projection_baseline_window_months: 6, projection_horizon_months: 18, savings_allocation_strategy: 'keep_cash_positive', role_permissions: {} },
      } : path === '/api/household/expenses/board' ? { groups: [group], categories: [category], monthly_totals: monthly.map((point) => ({ ...point, category_id: 'loan' })) }
        : path === '/api/household/expense-categories/loan' ? {
          ...category, subcategories: [], monthly_totals: monthly,
          entries: monthly.map((point) => ({ id: point.period, amount: point.value, description: 'Mortgage', entry_date: `${point.period}-01`, owner_scope: 'joint', notes: '', data_source: 'loan_schedule', extra_payload: { read_only: true } })).reverse(),
        } : []
      await route.fulfill({ json })
    })
    await page.addInitScript(() => localStorage.setItem('checkbook.session', 'loan-expenses'))
    await page.goto('/expenses')
    await expect(page.locator('.expense-group-name')).toHaveText('Home')
    await page.getByText('Mortgage', { exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('January 2026', { exact: true })).toBeVisible()
    await expect(dialog.getByText('February 2027', { exact: true })).toHaveCount(0)
    await expect(dialog.getByText('Scheduled loan payment')).toHaveCount(1)
    await expect(dialog.locator('.entry-month-header strong')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close group details' }).click()
    await page.locator('.app-content').evaluate((node) => node.scrollTo(0, 0))
    await page.getByRole('button', { name: 'Date range', exact: true }).click()
    await page.getByRole('dialog', { name: 'Date range', exact: true }).getByRole('switch', { name: 'Forecast' }).click()
    await page.keyboard.press('Escape')
    await page.getByText('Mortgage', { exact: true }).click()
    await expect(dialog.getByText('February 2027', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Scheduled loan payment')).toHaveCount(2)
    await expect(dialog.getByRole('checkbox')).toHaveCount(0)
    await expect(dialog.locator('button.entry-row')).toHaveCount(2)
    await expect(dialog.locator('.entry-day, .entry-check, .entry-actions')).toHaveCount(0)
    await dialog.locator('button.entry-row').first().click()
    const actions = page.getByRole('dialog', { name: 'Expense actions' })
    await expect(actions.getByText(/read.only/i)).toBeVisible()
    await expect(actions.getByRole('button', { name: 'Edit expense', exact: true })).toHaveCount(0)
    await expect(actions.getByRole('button', { name: 'Delete expense', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.screenshot({ path: `test-results/loan-expense-schedule-${width}.png` })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(errors).toEqual([])
  })
}
