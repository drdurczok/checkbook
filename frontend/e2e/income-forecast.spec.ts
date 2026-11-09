import { expect, test } from '@playwright/test'

const session = {
  token: 'income-forecast', expires_at: '2099-01-01T00:00:00Z',
  user: { id: 'u', email: 'test@example.com', full_name: 'Tester', picture_url: '' },
  household: { id: 'h', name: 'Forecast tests', base_currency: 'PLN', timezone: 'Europe/Warsaw' },
  membership: { id: 'm', role: 'owner', relationship_kind: 'owner' },
  settings: { id: 's', privacy_mode: 'household', allow_cross_member_visibility: true, projection_baseline_window_months: 12, projection_horizon_months: 24, savings_allocation_strategy: 'default', role_permissions: {} },
}
const source = {
  id: 'salary', name: 'Forecast salary', source_type: 'employment', owner_scope: 'self',
  started_on: '2026-01-01', ended_on: null, notes: '', sort_order: 0,
  annual_total: 120000, lines: [], fields: [], milestones: [],
  entries: [
    { id: 'today', entry_date: '2026-10-15', amount: 7000, description: 'Current payment', notes: '', owner_scope: 'self', extra_payload: { payslip: { period: 'Current payslip', basePay: 10000, grossPay: 10000, taxAdvance: 3000, netPayable: 7000 } } },
    { id: 'future', entry_date: '2026-10-20', amount: 8000, description: 'Forecast payment', notes: '', owner_scope: 'self', extra_payload: { payslip: { period: 'Future payslip', basePay: 11000, grossPay: 11000, taxAdvance: 3000, netPayable: 8000 } } },
  ],
}

for (const width of [390, 1280]) {
  test(`Income Forecast filters summary and payslip ledger at ${width}px`, async ({ page }) => {
    const errors: string[] = []
    const apiRequests: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
    page.on('requestfailed', (request) => errors.push(`${request.method()} ${request.url()} ${request.failure()?.errorText}`))
    await page.setViewportSize({ width, height: 900 })
    await page.clock.setFixedTime(new Date('2026-10-15T12:00:00Z'))
    await page.route('http://127.0.0.1:4174/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      apiRequests.push(`${route.request().method()} ${path}`)
      await route.fulfill({ json: path === '/api/auth/session' ? session
        : path === '/api/household/income-sources' ? [source] : [] })
    })
    await page.addInitScript(() => localStorage.setItem('checkbook.session', 'income-forecast'))
    await page.goto('/income')
    const sourceButton = page.getByRole('button', { name: /Forecast salary/ })
    await expect(sourceButton).toBeVisible()
    const annual = page.locator('.income-metric__gross strong')
    const lifetime = page.locator('.income-history-stats > div').filter({ hasText: 'Lifetime earned' }).locator('strong')
    const originalAnnual = await annual.innerText()
    const originalLifetime = await lifetime.innerText()
    expect(originalAnnual).toContain('120,000')
    await page.getByRole('button', { name: 'Date range', exact: true }).click()
    await expect(page.getByRole('option', { name: 'All time', exact: true })).toHaveAttribute('aria-selected', 'true')
    const forecast = page.getByRole('switch', { name: 'Forecast', exact: true })
    await expect(forecast).toHaveAttribute('aria-checked', 'false')
    await page.keyboard.press('Escape')
    await sourceButton.click()
    await expect(page.getByRole('button', { name: 'Current payslip', exact: true })).toBeVisible()
    await expect(page.getByText('Future payslip', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'New payslip' })).toBeEnabled()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Date range', exact: true }).click()
    await forecast.click()
    await expect(forecast).toHaveAttribute('aria-checked', 'true')
    await expect(annual).toHaveText(originalAnnual)
    await expect(lifetime).not.toHaveText(originalLifetime)
    await page.keyboard.press('Escape')
    await page.screenshot({ path: `test-results/income-forecast-summary-${width}.png` })
    await sourceButton.click()
    await expect(page.getByRole('button', { name: 'Future payslip', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Current payslip', exact: true })).toBeVisible()
    await page.screenshot({ path: `test-results/income-forecast-ledger-${width}.png` })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Date range', exact: true }).click()
    await forecast.click()
    await expect(forecast).toHaveAttribute('aria-checked', 'false')
    await expect(annual).toHaveText(originalAnnual)
    await expect(lifetime).toHaveText(originalLifetime)
    await page.keyboard.press('Escape')
    await sourceButton.click()
    await expect(page.getByText('Future payslip', { exact: true })).toHaveCount(0)
    expect(apiRequests).toContain('GET /api/household/income-sources')
    expect(apiRequests.every((request) => request.startsWith('GET '))).toBe(true)
    expect(errors).toEqual([])
  })
}
