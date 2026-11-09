import { expect, test } from '@playwright/test'

const settings = { id: 's', privacy_mode: 'private_joint', allow_cross_member_visibility: false, projection_baseline_window_months: 6, projection_horizon_months: 18, savings_allocation_strategy: 'keep_cash_positive', role_permissions: {} }
const session = { token: 'category-labels', expires_at: '2099-01-01T00:00:00Z', user: { id: 'u', email: 'u@example.com', full_name: 'User', picture_url: '' }, household: { id: 'h', name: 'House', base_currency: 'PLN', timezone: 'Europe/Warsaw' }, membership: { id: 'm', role: 'owner', relationship_kind: 'owner' }, settings }
const labels = [
  { id: 'short', name: 'Food', is_source_linked: false, is_retired: false },
  { id: 'medium', name: 'Household essentials', is_source_linked: false, is_retired: false },
  { id: 'inherited', name: 'Inherited family home mortgage and maintenance expenses with an exceptionally long category label', is_source_linked: true, is_retired: false },
  { id: 'retired', name: 'Retired inherited investment property mortgage and renovation expenses with an exceptionally long category label', is_source_linked: true, is_retired: true },
]
const monthlyAverage = 1_234_567

for (const width of [1280, 390]) {
  test(`expense category labels use the full title row at ${width}px`, async ({ page }) => {
    const errors: string[] = []
    const unexpectedRequests: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
    page.on('requestfailed', (request) => errors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`))
    await page.setViewportSize({ width, height: 900 })
    await page.clock.setFixedTime(new Date('2026-06-15T12:00:00Z'))
    const groups = labels.map((label, sort_order) => ({ ...label, sort_order, color: '217 119 6', notes: '', can_delete: false }))
    const categories = groups.map((group) => ({
      id: `${group.id}-entry`, name: 'Monthly expenses', parent_id: null, expense_group_id: group.id,
      is_system: false, is_retired: group.is_retired, is_source_linked: group.is_source_linked,
      can_delete: false, sort_order: group.sort_order, total_amount: monthlyAverage,
      monthly_average: monthlyAverage, entry_count: 1, last_entry_date: '2026-06-01',
    }))
    await page.route('http://127.0.0.1:4174/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      const responses: Record<string, unknown> = {
        '/api/auth/session': session,
        '/api/household/settings': settings,
        '/api/household/expenses/board': { groups, categories, monthly_totals: categories.flatMap((category) => ['2026-03', '2026-04', '2026-05'].map((period) => ({ category_id: category.id, period, value: monthlyAverage }))) },
        '/api/household/expenses/recurring': [],
        '/api/household/categories': [],
        '/api/household/assets': [],
        '/api/backups/config': { path: '', retention: 0 },
      }
      if (!(path in responses)) unexpectedRequests.push(`${route.request().method()} ${path}`)
      await route.fulfill({ json: responses[path] ?? [] })
    })
    await page.addInitScript(() => localStorage.setItem('checkbook.session', 'category-labels'))
    await page.goto('/expenses')
    await expect(page.locator('.expense-group-panel')).toHaveCount(3)
    await page.getByRole('button', { name: 'Date range', exact: true }).click()
    await page.getByRole('switch', { name: 'Retired', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(page.locator('.expense-group-panel')).toHaveCount(4)

    const expectedTotal = `${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'PLN', maximumFractionDigits: 0 }).format(monthlyAverage)} / mo`
    for (const label of labels) {
      const panel = page.locator('.expense-group-panel').filter({ has: page.locator('.expense-group-name', { hasText: label.name }) })
      await panel.scrollIntoViewIfNeeded()
      const name = panel.locator('.expense-group-name')
      const menu = panel.getByRole('button', { name: `Category options for ${label.name}`, exact: true })
      const total = panel.locator(':scope > .expense-group-monthly')
      await expect(name).toHaveText(label.name)
      await expect(total).toBeVisible()
      await expect(total).toHaveText(expectedTotal)
      await expect(menu).toBeVisible()
      await expect(panel.locator('.expense-group-title .expense-inherited-icon')).toHaveCount(label.is_source_linked ? 1 : 0)
      await expect(panel.locator('.expense-group-title .expense-retired-label')).toHaveCount(label.is_retired ? 1 : 0)
      const geometry = await panel.evaluate((node) => {
        const required = (selector: string) => {
          const element = node.querySelector<HTMLElement>(selector)
          if (!element) throw new Error(`Missing layout element: ${selector}`)
          return element
        }
        const header = required('.panel__header')
        const title = required('.expense-group-title')
        const name = required('.expense-group-name')
        const menu = required('.panel__actions button')
        const total = required(':scope > .expense-group-monthly')
        const titleRect = title.getBoundingClientRect()
        const nameRect = name.getBoundingClientRect()
        const menuRect = menu.getBoundingClientRect()
        const totalRect = total.getBoundingClientRect()
        const badges = [...title.querySelectorAll('.expense-inherited-icon, .expense-retired-label')].map((badge) => badge.getBoundingClientRect())
        return {
          menuGap: menuRect.left - titleRect.right,
          nameRight: nameRect.right, menuLeft: menuRect.left,
          titleBottom: titleRect.bottom, totalTop: totalRect.top,
          headerBottom: header.getBoundingClientRect().bottom,
          totalRight: totalRect.right, menuRight: menuRect.right,
          nameWidth: name.clientWidth, textWidth: name.scrollWidth,
          ellipsis: getComputedStyle(name).textOverflow,
          totalFits: total.scrollWidth <= total.clientWidth,
          badgesClear: badges.every((badge) => badge.left >= nameRect.right - 1 && badge.right <= menuRect.left),
        }
      })
      // The title gets all space up to the normal header gap, not a total-width reservation.
      expect(geometry.menuGap).toBeGreaterThanOrEqual(0)
      expect(geometry.menuGap).toBeLessThanOrEqual(17)
      expect(geometry.nameRight).toBeLessThanOrEqual(geometry.menuLeft)
      expect(geometry.badgesClear).toBe(true)
      expect(geometry.totalTop).toBeGreaterThanOrEqual(geometry.headerBottom)
      expect(geometry.totalTop).toBeGreaterThan(geometry.titleBottom)
      expect(Math.abs(geometry.totalRight - geometry.menuRight)).toBeLessThan(2)
      expect(geometry.totalFits).toBe(true)
      if (label.id === 'short' || label.id === 'medium') {
        expect(geometry.textWidth).toBeLessThanOrEqual(geometry.nameWidth + 1)
      } else {
        expect(geometry.textWidth).toBeGreaterThan(geometry.nameWidth)
        expect(geometry.ellipsis).toBe('ellipsis')
      }
      await menu.click()
      await expect(page.getByRole('menuitem', { name: 'Edit category', exact: true })).toBeVisible()
      await expect(page.getByRole('menuitem', { name: label.is_retired ? 'Unretire category' : 'Retire category', exact: true })).toBeVisible()
      await page.getByRole('menuitem', { name: 'Edit category', exact: true }).click()
      const editor = page.getByRole('dialog', { name: 'Edit category', exact: true })
      await expect(editor).toBeVisible()
      await expect(editor.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(label.name)
      await page.keyboard.press('Escape')
      await expect(editor).toHaveCount(0)
    }
    const panels = page.locator('.grid').filter({ has: page.locator(':scope > .expense-group-panel') })
    await panels.screenshot({ path: `test-results/expense-category-labels-${width}.png` })
    for (const selector of ['html', '.app-content', '.expenses-page', '.expense-group-panel']) {
      const overflows = await page.locator(selector).evaluateAll((nodes) => nodes.filter((node) => node.scrollWidth > node.clientWidth + 1).length)
      expect(overflows, `${selector} must not overflow horizontally`).toBe(0)
    }
    expect(unexpectedRequests).toEqual([])
    expect(errors).toEqual([])
  })
}
