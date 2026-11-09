import { test, expect } from '@playwright/test'

const settings = { id: 's', privacy_mode: 'private_joint', allow_cross_member_visibility: false, projection_baseline_window_months: 6, projection_horizon_months: 18, savings_allocation_strategy: 'keep_cash_positive', role_permissions: {} }
const session = { token: 'retirement', expires_at: '2099-01-01T00:00:00Z', user: { id: 'u', email: 'u@example.com', full_name: 'User', picture_url: '' }, household: { id: 'h', name: 'House', base_currency: 'PLN', timezone: 'Europe/Warsaw' }, membership: { id: 'm', role: 'owner', relationship_kind: 'owner' }, settings }

for (const width of [390, 1280]) {
  test(`retire and restore automatic expense categories and groups at ${width}px`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
    const group = { id: 'group', name: 'Property', color: '30 111 214', notes: '', sort_order: 0, is_retired: false, can_delete: false }
    const category = { id: 'category', name: 'Mortgage', parent_id: null, expense_group_id: 'group', is_system: false, sort_order: 0, total_amount: 120, monthly_average: 120, entry_count: 1, is_retired: false, can_delete: false }
    await page.setViewportSize({ width, height: 900 })
    await page.route('http://127.0.0.1:4174/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      if (route.request().method() === 'PUT' && path === '/api/household/expense-groups/group') Object.assign(group, route.request().postDataJSON())
      if (route.request().method() === 'PUT' && path === '/api/household/expense-categories/category') Object.assign(category, route.request().postDataJSON())
      const json = path === '/api/auth/session' ? session
        : path === '/api/dashboard/overview' ? { expense_breakdown: [], expense_trend_by_category: [] }
        : path === '/api/household/expenses/board' ? { groups: [group], categories: [category], monthly_totals: [] }
        : path === '/api/household/expense-groups/group' ? group
        : path === '/api/household/expense-categories/category' ? { ...category, subcategories: [], monthly_totals: [], entries: [] }
        : []
      await route.fulfill({ json })
    })
    await page.addInitScript(() => localStorage.setItem('checkbook.session', 'retirement'))
    await page.goto('/expenses')
    await expect(page.getByText('Mortgage', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Category options for Property' }).click()
    await page.getByRole('menuitem', { name: 'Edit category' }).click()
    const editor = page.getByRole('dialog', { name: 'Edit category' })
    await expect(editor.getByRole('button', { name: /Delete/ })).toHaveCount(0)
    await editor.getByRole('button', { name: 'Retire', exact: true }).click()
    await expect(page.getByText('Mortgage', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Date range', exact: true }).click()
    const toggle = page.getByRole('switch', { name: 'Retired' })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
    await expect(page.locator('.expense-group-panel--retired')).toBeVisible()
    await expect(page.locator('.expense-group-panel--retired')).toHaveCSS('filter', 'grayscale(1)')
    await page.screenshot({ path: `test-results/expense-retired-category-${width}.png` })
    await page.getByRole('button', { name: 'Category options for Property' }).click()
    await page.getByRole('menuitem', { name: 'Unretire category' }).click()
    await expect(page.locator('.expense-group-panel--retired')).toHaveCount(0)
    await page.getByRole('button', { name: 'Dismiss success message' }).click()
    await page.getByText('Mortgage', { exact: true }).click()
    await page.getByRole('button', { name: 'Group actions' }).click()
    await page.getByRole('menuitem', { name: 'Edit group' }).click()
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0)
    await page.getByRole('dialog').getByRole('button', { name: 'Retire', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.expense-row--retired')).toBeVisible()
    const retiredNameColor = await page.locator('.expense-row--retired > span > span').evaluate((node) => getComputedStyle(node).color)
    const activeNameColor = await page.locator('.expense-group-name').evaluate((node) => getComputedStyle(node).color)
    expect(retiredNameColor).not.toBe(activeNameColor)
    await page.screenshot({ path: `test-results/expense-retired-group-${width}.png` })
    await page.getByRole('button', { name: 'Dismiss success message' }).click()
    await page.getByText('Mortgage', { exact: true }).click()
    await page.getByRole('button', { name: 'Group actions' }).click()
    await page.getByRole('menuitem', { name: 'Unretire group' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.expense-row--retired')).toHaveCount(0)
    await page.getByRole('button', { name: 'Date range', exact: true }).click()
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await page.keyboard.press('Escape')
    await expect(page.getByText('Mortgage', { exact: true })).toBeVisible()
    await expect(page.locator('.expenses-page')).toHaveJSProperty('scrollWidth', await page.locator('.expenses-page').evaluate((node) => node.clientWidth))
    expect(errors).toEqual([])
  })
}
