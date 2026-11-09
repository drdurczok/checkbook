import { test, expect, type Locator } from '@playwright/test'

const settings = { id: 's', privacy_mode: 'private_joint', allow_cross_member_visibility: false, projection_baseline_window_months: 6, projection_horizon_months: 18, savings_allocation_strategy: 'keep_cash_positive', role_permissions: {} }
const session = { token: 'inputs', expires_at: '2099-01-01T00:00:00Z', user: { id: 'u', email: 'u@example.com', full_name: 'User', picture_url: '' }, household: { id: 'h', name: 'House', base_currency: 'PLN', timezone: 'Europe/Warsaw' }, membership: { id: 'm', role: 'owner', relationship_kind: 'owner' }, settings }

async function assertFields(container: Locator) {
  // Bounding boxes during a translated sheet entrance can have fractional noise.
  // Wait at the shared measurement boundary, including every modal using it.
  await container.evaluate(async (node) => {
    await Promise.all(node.getAnimations({ subtree: true })
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined)))
  })
  const fields = container.locator('.outlined-field:visible')
  expect(await fields.count()).toBeGreaterThan(0)
  const measurements = await fields.evaluateAll((elements) => elements.map((field) => {
    const shell = field.querySelector('.outlined-field__shell')!, input = field.querySelector('.outlined-field__input')!
    const s = shell.getBoundingClientRect(), i = input.getBoundingClientRect()
    return { multiline: field.classList.contains('is-multiline'), layoutHeight: getComputedStyle(shell).height, height: s.height, center: Math.abs(s.top + s.height / 2 - i.top - i.height / 2), border: getComputedStyle(input).borderTopWidth, background: getComputedStyle(input).backgroundColor, outside: s.right > window.innerWidth + 1 }
  }))
  for (const m of measurements) {
    expect(m.border).toBe('0px')
    expect(m.background).toBe('rgba(0, 0, 0, 0)')
    expect(m.outside).toBe(false)
    if (!m.multiline) { expect(m.layoutHeight).toBe('56px'); expect(m.height).toBeCloseTo(56, 2); expect(m.center).toBeLessThan(1) }
  }
}

test('shared field geometry waits for a translated mobile sheet entrance', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.setContent(`
    <style>
      @keyframes enter { from { transform: translateY(100px); } to { transform: translateY(0); } }
      .sheet { animation: enter 1s linear; }
      .outlined-field__shell { display: flex; align-items: center; height: 56px; }
      .outlined-field__input { height: 44px; border: 0; background: transparent; }
    </style>
    <div class="sheet"><div class="outlined-field">
      <div class="outlined-field__shell"><input class="outlined-field__input" aria-label="Name"></div>
    </div></div>
  `)
  const sheet = page.locator('.sheet')
  expect(await sheet.evaluate((node) => node.getAnimations().some((animation) => animation.playState === 'running'))).toBe(true)
  await assertFields(sheet)
  expect(await sheet.evaluate((node) => getComputedStyle(node).transform)).toBe('none')
})

for (const width of [390, 1280]) {
  test(`shared inputs in settings and property creation at ${width}px`, async ({ page }) => {
    const browserErrors: string[] = []
    page.on('pageerror', (error) => browserErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') browserErrors.push(message.text())
    })
    page.on('response', (response) => {
      if (response.status() >= 400) browserErrors.push(`${response.status()} ${response.url()}`)
    })
    await page.setViewportSize({ width, height: 900 })
    await page.route('http://127.0.0.1:4174/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      await route.fulfill({ json: path === '/api/auth/session' ? session : path === '/api/settings' ? settings : path === '/api/household/expenses/board' ? { groups: [], categories: [], monthly_totals: [] } : path === '/api/dashboard/overview' ? { expense_breakdown: [], expense_trend_by_category: [] } : [] })
    })
    await page.addInitScript(() => localStorage.setItem('checkbook.session', 'inputs'))
    await page.goto('/settings')
    await expect(page.getByLabel('Privacy mode', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Baseline window (months)', { exact: true })).toHaveValue('6')
    await expect(page.getByLabel('Projection horizon (months)', { exact: true })).toHaveValue('18')
    await assertFields(page.locator('.page-stack'))
    await page.screenshot({ path: `test-results/shared-settings-${width}.png` })
    await page.getByLabel('Privacy mode', { exact: true }).selectOption('shared_household')
    await expect(page.getByLabel('Privacy mode', { exact: true })).toHaveValue('shared_household')
    await page.goto('/assets')
    // Chrome stays opaque white around the tinted workspace at every width.
    const topbarBackground = await page.locator('.app-topbar').evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(topbarBackground).toBe('rgb(255, 255, 255)')
    await page.getByRole('button', { name: 'Add asset, utility, or project' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await assertFields(dialog)
    await expect(dialog).toHaveCSS('transform', 'none')
    // Start/end date pairs sit side by side at every width — mobile included.
    const fromBox = await dialog.getByLabel('From', { exact: true }).boundingBox()
    const toBox = await dialog.getByLabel('To', { exact: true }).boundingBox()
    expect(fromBox!.y).toBeCloseTo(toBox!.y, 0)
    expect(toBox!.x).toBeGreaterThan(fromBox!.x + fromBox!.width / 2)
    const saveBackground = await dialog
      .locator('.quick-add-actions button[type="submit"]')
      .evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(saveBackground).toBe('rgb(30, 111, 214)')
    await dialog.getByLabel('Name', { exact: true }).fill('Test property')
    await assertFields(dialog)
    await page.screenshot({ path: `test-results/shared-property-${width}.png` })
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.goto('/expenses')
    await page.getByRole('button', { name: 'Add expense', exact: true }).click()
    await expect(dialog).toBeVisible()
    await assertFields(dialog)
    await expect(dialog).toHaveCSS('transform', 'none')
    const panel = await dialog.locator('.form-grid').evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        border: style.borderTopWidth,
        background: style.backgroundColor,
        shadow: style.boxShadow,
        padding: style.padding,
      }
    })
    expect(panel).toEqual({ border: '0px', background: 'rgba(0, 0, 0, 0)', shadow: 'none', padding: '0px' })
    expect(browserErrors).toEqual([])
  })
}
