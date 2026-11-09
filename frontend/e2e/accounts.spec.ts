import { expect, test } from '@playwright/test'
import type { AssetSummary } from '../src/contracts/assets'

const session = {
  token: 'accounts-test', expires_at: '2099-01-01T00:00:00Z',
  user: { id: 'u', email: 'test@example.com', full_name: 'Tester', picture_url: '' },
  household: { id: 'h', name: 'Accounts tests', base_currency: 'EUR', timezone: 'Europe/Warsaw' },
  membership: { id: 'm', role: 'owner', relationship_kind: 'owner' },
  settings: { id: 's', privacy_mode: 'household', allow_cross_member_visibility: true, projection_baseline_window_months: 12, projection_horizon_months: 24, savings_allocation_strategy: 'default', role_permissions: {} },
}

for (const width of [1440, 390]) {
  test(`accounts holding lifecycle and grouped selector at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('requestfailed', (request) => errors.push(request.failure()?.errorText ?? request.url()))
    const assets: AssetSummary[] = [
      { id: 'home', name: 'Home', category: 'property', kind: 'asset', total_cost: 2000, valuation_date: '2026-01-01' },
      { id: 'car', name: 'Car', category: 'vehicle', kind: 'asset', total_cost: 500, valuation_date: '2026-01-01' },
      { id: 'account', name: 'Retirement stocks', category: 'account', kind: 'asset', total_cost: 300,
        account_type: 'stocks', account_registration: 'retirement', valuation_date: '2026-01-01', holdings: [
          { id: 'existing', name: 'Existing lot', value: 100, notes: '' },
        ] },
    ]
    const writes: unknown[] = []
    await page.route('**/api/**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      if (path === '/api/household/assets/account' && request.method() === 'PUT') {
        const body = request.postDataJSON()
        writes.push(body)
        Object.assign(assets[2], body, { holdings: body.holdings.map((holding: object, index: number) => ({ ...holding, id: `lot-${index}` })) })
        await route.fulfill({ json: assets[2] })
        return
      }
      if (path.endsWith('/holding-prices')) {
        await route.fulfill({ json: { prices: [] } })
        return
      }
      const data = path === '/api/auth/session' ? session
        : path === '/api/household/settings' ? session.settings
        : path === '/api/household/assets' ? assets : []
      await route.fulfill({ json: data })
    })
    await page.addInitScript(() => localStorage.setItem('checkbook.session', 'accounts-test'))
    await page.goto('/assets')
    const selector = page.getByRole('button', { name: 'Asset', exact: true })
    await selector.click()
    const menu = page.getByRole('listbox', { name: 'Asset', exact: true })
    await expect(menu.getByRole('option')).toHaveText(['All assets', 'Home', 'Car', 'Retirement stocks', '+ New asset'])
    await expect(menu.getByRole('separator')).toHaveCount(4)
    await page.screenshot({ path: testInfo.outputPath(`selector-${width}.png`), fullPage: true })
    await menu.getByRole('option', { name: 'Retirement stocks' }).click()
    await expect(page.getByRole('heading', { name: 'Holdings', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Add holding', exact: true }).click()
    let dialog = page.getByRole('dialog')
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveCount(0)
    await dialog.getByLabel('US ticker', { exact: true }).fill('vti')
    await dialog.getByLabel('Value', { exact: true }).fill('200')
    await dialog.getByLabel('Quantity', { exact: true }).fill('2')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('row', { name: /VTI/ })).toBeVisible()
    expect(writes[0]).toMatchObject({ account_type: 'stocks', account_registration: 'retirement', holdings: [{ name: 'Existing lot' }, { name: 'VTI', value: 200, quantity: 2 }] })
    await page.getByRole('button', { name: 'Edit VTI', exact: true }).click()
    dialog = page.getByRole('dialog')
    await dialog.getByLabel('Sell value', { exact: true }).fill('250')
    await dialog.getByLabel('Sold', { exact: true }).fill('2026-02-01')
    await dialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByLabel('Realized profit and loss')).toContainText('50')
    const remove = page.getByRole('button', { name: 'Delete VTI', exact: true })
    await remove.focus()
    await page.keyboard.down('Enter')
    await expect(page.getByRole('row', { name: /VTI/ })).toHaveCount(0)
    await page.keyboard.up('Enter')
    await expect(page.getByRole('row', { name: /Existing lot/ })).toBeVisible()
    await expect.poll(() => page.locator('.holdings-table-shell').evaluate((shell) => shell.scrollLeft)).toBe(0)
    expect(writes).toHaveLength(3)
    expect(writes[2]).toMatchObject({ holdings: [{ name: 'Existing lot' }] })
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`holdings-${width}.png`), fullPage: true })
    expect(errors).toEqual([])
  })
}
