import { expect, test } from '@playwright/test'

const settings = { id: 's', privacy_mode: 'private_joint', allow_cross_member_visibility: false, projection_baseline_window_months: 6, projection_horizon_months: 18, savings_allocation_strategy: 'keep_cash_positive', role_permissions: {} }
const session = { token: 'forecast', expires_at: '2099-01-01T00:00:00Z', user: { id: 'u', email: 'u@example.com', full_name: 'User', picture_url: '' }, household: { id: 'h', name: 'House', base_currency: 'PLN', timezone: 'Europe/Warsaw' }, membership: { id: 'm', role: 'owner', relationship_kind: 'owner' }, settings }
const dashboard = { metrics: [], net_worth_trend: [], net_worth_components: [], cash_flow_trend: [], cash_flow_components: [], income_breakdown: [], expense_breakdown: [], expense_trend_by_category: [], utility_trend: [], savings_allocation: [], loans: [], upcoming_planned_expenses: [], recent_activity: [], goals: [], last_successful_import: null }

for (const width of [390, 1280]) {
  test(`forecast combines with all ranges and remains independent per page at ${width}px`, async ({ page }) => {
    const errors: string[] = []
    const requests: { path: string; query: Record<string, string> }[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
    await page.setViewportSize({ width, height: 900 })
    await page.clock.setFixedTime(new Date('2026-10-15T12:00:00Z'))
    await page.route('http://127.0.0.1:4174/api/**', async (route) => {
      const url = new URL(route.request().url())
      requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) })
      const json = url.pathname === '/api/auth/session' ? session
        : url.pathname === '/api/household/settings' ? settings
        : url.pathname === '/api/dashboard/overview' ? dashboard
        : url.pathname === '/api/household/expenses/board' ? { groups: [], categories: [], monthly_totals: [] }
        : []
      await route.fulfill({ json })
    })
    await page.addInitScript(() => localStorage.setItem('checkbook.session', 'forecast'))
    await page.goto('/')
    const overviewQuery = () => requests.filter((request) => request.path === '/api/dashboard/overview').at(-1)?.query
    const expensesQuery = () => requests.filter((request) => request.path === '/api/household/expenses/board' && request.query.start_date !== '2026-07-01').at(-1)?.query
    await expect.poll(overviewQuery).toEqual({ end_date: '2026-10-15' })
    const trigger = page.getByRole('button', { name: 'Date range', exact: true })
    await trigger.click()
    await expect(page.getByRole('option', { name: 'Forecast', exact: true })).toHaveCount(0)
    await page.getByRole('dialog', { name: 'Date range', exact: true }).getByRole('switch', { name: 'Forecast' }).click()
    await expect.poll(overviewQuery).toEqual({ include_planned: 'true' })
    await page.screenshot({ path: `test-results/forecast-filter-${width}.png` })

    for (const [label, start, end] of [
      ['Current month', '2026-10-01', '2026-10-31'],
      ['6 months', '2026-05-01', '2027-04-30'],
      ['12 months', '2025-11-01', '2027-10-31'],
      ['YTD', '2026-01-01', '2026-12-31'],
    ]) {
      await page.getByRole('option', { name: label, exact: true }).click()
      await expect.poll(overviewQuery).toEqual({ start_date: start, end_date: end, include_planned: 'true' })
      await trigger.click()
      await expect(page.getByRole('dialog', { name: 'Date range', exact: true }).getByRole('switch', { name: 'Forecast' })).toHaveAttribute('aria-checked', 'true')
    }
    await page.getByRole('dialog', { name: 'Date range', exact: true }).getByRole('switch', { name: 'Forecast' }).click()
    await expect.poll(overviewQuery).toEqual({ start_date: '2026-01-01', end_date: '2026-10-15' })
    await page.keyboard.press('Escape')

    const navigate = async (label: string) => {
      await page.locator('.app-content').evaluate((node) => { node.scrollTop = 0 })
      if (width < 768) {
        await page.locator(`.app-bottom-nav button[data-nav-label="${label}"]`).click()
      } else {
        const sidebar = page.locator('.app-sidebar')
        if (await sidebar.evaluate((node) => node.classList.contains('app-sidebar-collapsed'))) {
          await sidebar.locator('.app-sidebar-toggle').click()
        }
        await sidebar.getByRole('button', { name: label, exact: true }).click()
      }
    }
    await navigate('Expenses')
    await expect.poll(expensesQuery).toEqual({ end_date: '2026-10-15' })
    await trigger.click()
    const forecast = page.getByRole('dialog', { name: 'Date range', exact: true }).getByRole('switch', { name: 'Forecast' })
    await expect(forecast).toHaveAttribute('aria-checked', 'false')
    await forecast.click()
    await expect.poll(expensesQuery).toEqual({})
    await expect(page.getByRole('switch', { name: 'Retired' })).toHaveAttribute('aria-checked', 'false')
    const separators = await page.getByRole('group', { name: 'Display options' }).evaluate((group) => ({
      group: getComputedStyle(group).borderTopWidth,
      switches: [...group.querySelectorAll('[role="switch"]')].map((node) => getComputedStyle(node).borderTopWidth),
    }))
    expect(separators).toEqual({ group: '1px', switches: ['0px', '0px'] })
    await page.screenshot({ path: `test-results/forecast-group-${width}.png` })
    await page.getByRole('option', { name: '6 months', exact: true }).click()
    await expect.poll(expensesQuery).toEqual({ start_date: '2026-05-01', end_date: '2027-04-30' })
    await trigger.click()
    await forecast.click()
    await expect.poll(expensesQuery).toEqual({ start_date: '2026-05-01', end_date: '2026-10-15' })
    await forecast.click()
    await page.keyboard.press('Escape')
    await navigate('Overview')
    await trigger.click()
    await expect(forecast).toHaveAttribute('aria-checked', 'false')
    await expect(page.getByRole('option', { name: 'YTD', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Escape')
    await navigate('Expenses')
    await trigger.click()
    await expect(forecast).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByRole('option', { name: '6 months', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Escape')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    expect(errors).toEqual([])
  })
}
