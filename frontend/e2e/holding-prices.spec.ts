import { expect, test } from '@playwright/test'

for (const width of [1440, 390]) {
  test(`daily close ticker save and stale workflow at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 960 })
    const errors: string[] = []
    const failedRequests: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('requestfailed', (request) => failedRequests.push(request.url()))
    const session = {
      token: 'prices-test', expires_at: '2099-01-01T00:00:00Z',
      user: { id: 'u', email: 'prices@example.com', full_name: 'Tester', picture_url: '' },
      household: { id: 'h', name: 'Prices tests', base_currency: 'PLN', timezone: 'Europe/Warsaw' },
      membership: { id: 'm', role: 'owner', relationship_kind: 'owner' },
      settings: { id: 's', privacy_mode: 'household', allow_cross_member_visibility: true, role_permissions: {} },
    }
    let account = {
      id: 'brokerage', name: 'US portfolio', kind: 'asset', category: 'account', account_type: 'stocks', account_registration: 'regular', total_cost: 0, valuation_date: '2026-11-01',
      holdings: [
        { id: 'open', name: 'Berkshire', ticker: null as string | null, value: 100, quantity: 0.1, sold_on: null, sell_value: null as number | null },
        { id: 'sold', name: 'Sold lot', ticker: 'AAPL', value: 200, quantity: 2, sold_on: null, sell_value: 0 },
      ],
    }
    let priceRequests = 0
    let savedTicker: string | null = null
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith('/holding-prices')) {
        priceRequests++
        await route.fulfill({ json: { prices: [{ ticker: 'BRK-B', currency: 'USD', close: 501.25, price_date: '2026-11-03', fetched_at: '2026-11-04T12:30:00Z', stale: priceRequests > 1, error: priceRequests > 1 ? 'Yahoo unavailable; retaining last successful close' : null }] } })
        return
      }
      if (path === '/api/household/assets/brokerage' && route.request().method() === 'PUT') {
        const payload = route.request().postDataJSON()
        savedTicker = payload.holdings[0].ticker
        account = { ...account, ...payload, holdings: payload.holdings.map((holding: object, index: number) => ({ ...holding, id: `lot-${index}` })) }
        await route.fulfill({ json: account })
        return
      }
      const data = path === '/api/auth/session' ? session : path === '/api/household/settings' ? session.settings : path === '/api/household/assets' ? [account] : []
      await route.fulfill({ json: data })
    })
    await page.addInitScript(() => localStorage.setItem('checkbook.session', 'prices-test'))
    await page.goto('/assets')
    await page.getByRole('button', { name: 'Asset', exact: true }).click()
    await page.getByRole('option', { name: 'US portfolio', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Holdings', exact: true })).toBeVisible()
    expect(priceRequests).toBe(0)
    await page.getByRole('button', { name: 'Edit Berkshire' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveCount(0)
    await dialog.getByLabel('US ticker').fill('brk-b')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect(page.getByText('Close: USD 501.25', { exact: true })).toBeVisible()
    expect(savedTicker).toBe('BRK-B')
    await expect(page.getByText('Market value: USD 50.13', { exact: true })).toBeVisible()
    await expect(page.getByText(/Trading date:/)).toContainText('2026')
    await expect(page.getByText('Sold - not priced')).toBeVisible()
    await page.getByRole('button', { name: 'Refresh prices', exact: true }).click()
    await expect(page.getByText('Stale - last successful close retained', { exact: true })).toBeVisible()
    expect(account.total_cost).toBe(0)
    expect(account.holdings[0].name).toBe('BRK-B')
    await expect(page.getByRole('region', { name: 'Account summary' })).toContainText('50.13')
    expect(account.holdings[0].value).toBe(100)
    expect(priceRequests).toBe(2)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(errors).toEqual([])
    expect(failedRequests).toEqual([])
    await page.screenshot({ path: testInfo.outputPath(`holding-prices-${width}.png`), fullPage: true })
    await testInfo.attach('browser-diagnostics', { body: JSON.stringify({ errors, failedRequests, priceRequests, savedTicker }), contentType: 'application/json' })
  })
}
