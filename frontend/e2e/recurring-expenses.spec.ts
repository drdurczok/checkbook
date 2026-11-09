import { expect, test } from '@playwright/test'

const settings = { id: 's', privacy_mode: 'private_joint', allow_cross_member_visibility: false, projection_baseline_window_months: 6, projection_horizon_months: 18, savings_allocation_strategy: 'keep_cash_positive', role_permissions: {} }
const session = { token: 'recurring', expires_at: '2099-01-01T00:00:00Z', user: { id: 'u', email: 'u@example.com', full_name: 'User', picture_url: '' }, household: { id: 'h', name: 'House', base_currency: 'PLN', timezone: 'Europe/Warsaw' }, membership: { id: 'm', role: 'owner', relationship_kind: 'owner' }, settings }

for (const width of [1280, 390]) {
  test(`recurring expense management at ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = []
    const requests: string[] = []
    let schedule = { id: 'rent', description: 'Home rent', amount: 1200, start_date: '2026-01-01', end_date: null as string | null, next_due_date: '2026-11-01', cadence: 'monthly', owner_scope: 'joint', category_id: 'home', category_name: 'Home', notes: '', is_active: true, price_history: [{ amount: 1000, changed_at: '2026-01-01T12:00:00Z' }] }
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
    await page.setViewportSize({ width, height: 900 })
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      const method = route.request().method()
      if (path.startsWith('/api/household/expenses/recurring')) {
        requests.push(`${method} ${path}`)
        if (method === 'GET') return route.fulfill({ json: [schedule] })
        if (method === 'PUT') schedule = { ...schedule, ...route.request().postDataJSON() }
        if (path.endsWith('/retire')) schedule = { ...schedule, is_active: false }
        return route.fulfill({ json: schedule })
      }
      const responses: Record<string, unknown> = {
        '/api/auth/session': session, '/api/household/settings': settings,
        '/api/household/expenses/board': { groups: [], categories: [], monthly_totals: [] },
        '/api/household/categories': [], '/api/household/assets': [],
        '/api/backups/config': { path: '', retention: 0 },
      }
      await route.fulfill({ json: responses[path] ?? [] })
    })
    await page.addInitScript(() => localStorage.setItem('checkbook.session', 'recurring'))
    await page.goto('/expenses')
    await expect(page.getByRole('button', { name: 'Manage recurring expenses' }).getByText('1 upcoming', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Manage recurring expenses' }).click()
    await expect(page.getByText('Next: 2026-11-01')).toBeVisible()
    await page.getByRole('button', { name: 'Options for Home rent' }).click()
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Price history' })).toContainText('2026-01-01')
    await page.getByLabel('Amount', { exact: true }).fill('1400')
    await page.getByLabel('End (optional)').fill('2027-12-31')
    const editor = page.getByRole('dialog', { name: 'Edit recurring expense' })
    // Mobile sheets translate without changing opacity; measure after entrance.
    await editor.evaluate(async (node) => {
      await Promise.all(node.getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)))
    })
    await page.screenshot({ path: testInfo.outputPath(`recurring-edit-${width}.png`), fullPage: true })
    const datePositions = await editor.locator('input[type="date"]').evaluateAll((inputs) =>
      inputs.map((input) => input.getBoundingClientRect().y))
    expect(datePositions).toHaveLength(2)
    expect(Math.abs(datePositions[0] - datePositions[1])).toBeLessThan(2)
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByRole('dialog', { name: 'Recurring expenses', exact: true })).toBeVisible()
    expect(schedule.amount).toBe(1400)
    expect(schedule.end_date).toBe('2027-12-31')
    await page.getByRole('button', { name: 'Options for Home rent' }).click()
    await page.getByRole('menuitem', { name: 'Expense now' }).click()
    await expect.poll(() => requests.filter((request) => request.endsWith('/expense-now')).length).toBe(1)
    await page.getByRole('button', { name: 'Options for Home rent' }).click()
    await page.getByRole('menuitem', { name: 'Retire', exact: true }).click()
    await expect(page.getByText('No recurring expenses')).toBeVisible()
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: 'Add expense', exact: true }).click()
    await page.getByRole('button', { name: 'Expense', exact: true }).click()
    await page.getByRole('option', { name: 'Recurring expense', exact: true }).click()
    await expect(page.getByLabel('Frequency (optional)')).toHaveValue('monthly')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`recurring-add-${width}.png`), fullPage: true })
    expect(errors).toEqual([])
  })
}
