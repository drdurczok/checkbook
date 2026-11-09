import { expect, test } from '@playwright/test'

const settings = { id: 's', privacy_mode: 'private_joint', allow_cross_member_visibility: false, projection_baseline_window_months: 6, projection_horizon_months: 18, savings_allocation_strategy: 'keep_cash_positive', role_permissions: {} }
const session = { token: 'chart-forecast', expires_at: '2099-01-01T00:00:00Z', user: { id: 'u', email: 'u@example.com', full_name: 'User', picture_url: '' }, household: { id: 'h', name: 'House', base_currency: 'PLN', timezone: 'Europe/Warsaw' }, membership: { id: 'm', role: 'owner', relationship_kind: 'owner' }, settings }
const groups = [{ id: 'home', name: 'Home', color: '217 119 6', notes: '', sort_order: 0, is_retired: false, can_delete: false, is_source_linked: true }]
const categories = [{ id: 'mortgage', name: 'Mortgage', expense_group_id: 'home', is_system: false, is_retired: false, can_delete: false, is_source_linked: true, sort_order: 0, total_amount: 720000, monthly_average: 2000, entry_count: 360 }]
const monthlyTotals = Array.from({ length: 360 }, (_, index) => ({
  category_id: 'mortgage',
  period: `${2026 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`,
  value: 2000,
}))

for (const width of [390, 1280]) {
  test(`all-time forecast fits the complete loan schedule inside Expense mix at ${width}px`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
    await page.setViewportSize({ width, height: 900 })
    await page.clock.setFixedTime(new Date('2026-10-15T12:00:00Z'))
    await page.route('http://127.0.0.1:4174/api/**', async (route) => {
      const url = new URL(route.request().url())
      const json = url.pathname === '/api/auth/session' ? session
        : url.pathname === '/api/household/settings' ? settings
        : url.pathname === '/api/household/expenses/board' ? {
          groups, categories,
          monthly_totals: url.searchParams.has('end_date') ? monthlyTotals.slice(0, 10) : monthlyTotals,
        } : []
      await route.fulfill({ json })
    })
    await page.addInitScript(() => localStorage.setItem('checkbook.session', 'chart-forecast'))
    await page.goto('/expenses')
    const chart = page.getByRole('img', { name: 'Monthly expenses by category' })
    await expect(chart.locator('.stacked-chart__segment')).toHaveCount(10)
    await page.getByRole('button', { name: 'Date range', exact: true }).click()
    await page.getByRole('switch', { name: 'Forecast' }).click()
    await page.keyboard.press('Escape')
    await expect(chart.locator('.stacked-chart__segment')).toHaveCount(360)
    await chart.scrollIntoViewIfNeeded()

    const layout = await chart.evaluate((svg) => {
      const bounds = svg.getBoundingClientRect()
      const segments = [...svg.querySelectorAll('.stacked-chart__segment')].map((segment) => {
        const rect = segment.getBoundingClientRect()
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
      })
      const labels = [...svg.querySelectorAll('.chart-x-label')].map((label) => {
        const rect = label.getBoundingClientRect()
        return { left: rect.left, right: rect.right, text: label.textContent }
      })
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, segments, labels }
    })
    for (const segment of layout.segments) {
      expect(segment.left).toBeGreaterThanOrEqual(layout.left)
      expect(segment.right).toBeLessThanOrEqual(layout.right + 1)
      expect(segment.top).toBeGreaterThanOrEqual(layout.top)
      expect(segment.bottom).toBeLessThanOrEqual(layout.bottom + 1)
    }
    expect(layout.labels).toHaveLength(6)
    expect(layout.labels[0].text).toBe('2026-01')
    expect(layout.labels.at(-1)?.text).toBe('2055-12')
    for (const [index, label] of layout.labels.entries()) {
      expect(label.left).toBeGreaterThanOrEqual(layout.left)
      expect(label.right).toBeLessThanOrEqual(layout.right + 1)
      if (index > 0) expect(label.left).toBeGreaterThan(layout.labels[index - 1].right)
    }
    const pageLayout = await page.locator('.expenses-page').evaluate((node) => ({ clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }))
    expect(pageLayout.scrollWidth).toBeLessThanOrEqual(pageLayout.clientWidth)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await page.screenshot({ path: `test-results/stacked-chart-forecast-${width}.png`, fullPage: true })

    await page.locator('.app-content').evaluate((node) => node.scrollTo(0, 0))
    await page.getByRole('button', { name: 'Date range', exact: true }).click()
    await page.getByRole('switch', { name: 'Forecast' }).click()
    await page.keyboard.press('Escape')
    await expect(chart.locator('.stacked-chart__segment')).toHaveCount(10)
    expect(errors).toEqual([])
  })
}
