import { test, expect } from '@playwright/test'

const settings = { id: 's', privacy_mode: 'private_joint', allow_cross_member_visibility: false, projection_baseline_window_months: 6, projection_horizon_months: 18, savings_allocation_strategy: 'keep_cash_positive', role_permissions: {} }
const session = { token: 'presentation', expires_at: '2099-01-01T00:00:00Z', user: { id: 'u', email: 'u@example.com', full_name: 'User', picture_url: '' }, household: { id: 'h', name: 'House', base_currency: 'PLN', timezone: 'Europe/Warsaw' }, membership: { id: 'm', role: 'owner', relationship_kind: 'owner' }, settings }

for (const width of [390, 1280]) {
  test(`expense charts, inherited labels and header layout at ${width}px`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
    const groups = [
      { id: 'property', name: 'Family home', color: '217 119 6', notes: '', sort_order: 0, is_retired: false, can_delete: false, is_source_linked: true },
      { id: 'living', name: 'Living', color: '', notes: '', sort_order: 1, is_retired: false, can_delete: false, is_source_linked: false },
    ]
    const categories = [
      { id: 'mortgage', name: 'Mortgage', expense_group_id: 'property', is_system: false, is_retired: false, can_delete: false, is_source_linked: true, sort_order: 0, total_amount: 6000, monthly_average: 1000, entry_count: 6 },
      { id: 'groceries', name: 'Groceries', expense_group_id: 'living', is_system: false, is_retired: false, can_delete: false, is_source_linked: false, sort_order: 1, total_amount: 500, monthly_average: 100, entry_count: 5 },
      { id: 'other', name: 'Other expenses', expense_group_id: null, is_system: false, is_retired: false, can_delete: true, is_source_linked: false, sort_order: 2, total_amount: 75, monthly_average: 75, entry_count: 1 },
    ]
    const monthlyTotals = [
      ...Array.from({ length: 6 }, (_, index) => ({ category_id: 'mortgage', period: `2026-0${index + 1}`, value: 1000 })),
      ...Array.from({ length: 5 }, (_, index) => ({ category_id: 'groceries', period: `2026-0${index + 1}`, value: 100 })),
      { category_id: 'other', period: '2026-06', value: 75 },
    ]
    await page.setViewportSize({ width, height: 900 })
    await page.route('http://127.0.0.1:4174/api/**', async (route) => {
      const url = new URL(route.request().url())
      const json = url.pathname === '/api/auth/session' ? session
        : url.pathname === '/api/household/expenses/board' ? { groups, categories, monthly_totals: url.searchParams.has('start_date') ? monthlyTotals.filter((point) => point.period === '2026-06') : monthlyTotals }
        : url.pathname === '/api/household/expense-categories/mortgage' ? {
          ...categories[0], subcategories: [], monthly_totals: [{ period: '2026-06', value: 1000 }],
          entries: Array.from({ length: 6 }, (_, month) => Array.from({ length: 4 }, (_, day) => ({
            id: `payment-${month}-${day}`, description: 'Mortgage', amount: 250,
            entry_date: `2026-0${month + 1}-${String(day + 1).padStart(2, '0')}`,
            owner_scope: 'joint', notes: '', data_source: 'loan_schedule',
          }))).flat(),
        } : []
      await route.fulfill({ json })
    })
    await page.addInitScript(() => localStorage.setItem('checkbook.session', 'presentation'))
    await page.goto('/expenses')
    await expect(page.getByRole('heading', { name: 'Spending trend', exact: true })).toBeAttached()
    await expect(page.locator('.expense-chart-filter-pill')).toHaveCount(0)
    const toggle = page.getByRole('button', { name: 'Expand quick filters' })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    const chipRow = page.getByRole('group', { name: 'Filter by category' })
    expect(await chipRow.evaluate((node) => node.clientHeight)).toBeLessThanOrEqual(33)
    // Collapsed, every category chip is just its colored dot; only All keeps its label.
    const livingChip = chipRow.getByRole('button', { name: 'Living', exact: true })
    await expect(livingChip).toHaveCSS('width', '32px')
    expect(await chipRow.getByRole('button', { name: 'All', exact: true }).evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(32)
    // Selecting a collapsed dot must not expand the row.
    await chipRow.getByRole('button', { name: 'All', exact: true }).click()
    await expect(chipRow).not.toHaveClass('is-expanded')
    await toggle.click()
    await expect(page.getByRole('button', { name: 'Collapse quick filters' })).toHaveAttribute('aria-expanded', 'true')
    await expect(livingChip.locator('.expense-filter-label')).toBeVisible()
    await page.getByRole('button', { name: 'Collapse quick filters' }).click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.click()
    for (const panel of await page.locator('.expenses-page .panel').all()) {
      await expect(panel).toHaveCSS('border-top-width', '0px')
      await expect(panel).toHaveCSS('border-left-width', '0px')
    }
    if (width < 768) {
      const track = page.locator('.expense-chart-track')
      await expect(track).toHaveCSS('scroll-snap-type', 'x mandatory')
      // Both plots must start at the same height below their panel titles.
      const plotTop = (index: number) => page.locator('.expense-chart-slide').nth(index).locator('.chart-tick line').evaluateAll(
        (nodes) => Math.min(...nodes.map((node) => node.getBoundingClientRect().top)))
      expect(Math.abs((await plotTop(0)) - (await plotTop(1)))).toBeLessThan(10)
      const mixDot = page.getByRole('button', { name: 'Show expense mix' })
      const trendDot = page.getByRole('button', { name: 'Show spending trend' })
      await expect(mixDot).toBeVisible()
      expect(await mixDot.locator('.expense-chart-pager-dot').evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(30, 111, 214)')
      expect(await mixDot.locator('.expense-chart-pager-dot').evaluate((node) => node.getBoundingClientRect().width)).toBeLessThanOrEqual(6)
      expect(await trendDot.locator('.expense-chart-pager-dot').evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(91, 107, 128)')
      await trendDot.click()
      await expect(trendDot).toHaveAttribute('aria-current', 'true')
      await expect.poll(() => track.evaluate((node) => node.scrollLeft)).toBeGreaterThan(100)
      await mixDot.click()
      await expect(mixDot).toHaveAttribute('aria-current', 'true')
      await expect.poll(() => track.evaluate((node) => node.scrollLeft)).toBeLessThan(2)
    }
    const property = page.locator('.expense-group-panel').filter({ has: page.locator('.expense-group-name', { hasText: 'Family home' }) })
    await expect(property.getByRole('img', { name: 'Inherited from a source' })).toHaveCount(2)
    const manual = page.locator('.expense-group-panel').filter({ has: page.locator('.expense-group-name', { hasText: 'Living' }) })
    await expect(manual.getByRole('img', { name: 'Inherited from a source' })).toHaveCount(0)
    const menu = await property.getByRole('button', { name: 'Category options for Family home' }).boundingBox()
    const amount = await property.locator('.expense-group-monthly').boundingBox()
    expect(menu).not.toBeNull()
    expect(amount).not.toBeNull()
    expect(amount!.y).toBeGreaterThanOrEqual(menu!.y + menu!.height)
    expect(Math.abs(amount!.x + amount!.width - menu!.x - menu!.width)).toBeLessThan(2)
    const filters = page.getByRole('group', { name: 'Filter by category' })
    const uncategorized = filters.getByRole('button', { name: 'Uncategorized', exact: true })
    await expect(uncategorized.locator('i')).toHaveCSS('background-color', 'rgb(91, 107, 128)')
    await expect(page.locator('.expense-group-title').filter({ hasText: 'Uncategorized' }).locator('i')).toHaveCSS('background-color', 'rgb(91, 107, 128)')
    await uncategorized.click()
    await expect(page.locator('.stacked-chart__segment')).toHaveCount(1)
    await expect(page.locator('.stacked-chart__segment')).toHaveCSS('fill', 'rgb(91, 107, 128)')
    await page.screenshot({ path: `test-results/expense-uncategorized-${width}.png`, fullPage: true })
    await filters.getByRole('button', { name: 'Living', exact: true }).click()
    await expect(page.getByRole('heading', { name: /Spending trend/ })).toHaveCount(0)
    await filters.getByRole('button', { name: 'Family home', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Spending trend', exact: true })).toBeVisible()
    const filterPill = page.locator('.expense-chart-filter-pill')
    await expect(filterPill).toHaveText('Family home')
    await expect(filterPill.locator('i')).toHaveCSS('background-color', 'rgb(217, 119, 6)')
    await expect(page.locator('.chart--line .chart__line').first()).toHaveCSS('stroke', 'rgb(217, 119, 6)')
    // The pill centers horizontally in the footer, with the pager dots below it.
    const footer = page.locator('.expense-chart-footer')
    const pillBox = await filterPill.boundingBox()
    const footerBox = await footer.boundingBox()
    expect(pillBox).not.toBeNull()
    expect(footerBox).not.toBeNull()
    expect(Math.abs((pillBox!.x + pillBox!.width / 2) - (footerBox!.x + footerBox!.width / 2))).toBeLessThan(2)
    if (width < 768) {
      const pagerBox = await page.locator('.expense-chart-pager').boundingBox()
      expect(pagerBox).not.toBeNull()
      expect(pagerBox!.y).toBeGreaterThanOrEqual(pillBox!.y + pillBox!.height - 1)
    }
    const colors = await page.locator('.stacked-chart__segment').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('fill')))
    expect(colors).toHaveLength(6)
    expect(colors.every((color) => color === 'rgb(217 119 6)')).toBe(true)
    await expect(page.locator('.expenses-page')).toHaveJSProperty('scrollWidth', await page.locator('.expenses-page').evaluate((node) => node.clientWidth))
    await page.screenshot({ path: `test-results/expense-presentation-${width}.png`, fullPage: true })
    await property.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `test-results/expense-category-layout-${width}.png`, fullPage: true })
    await page.getByText('Mortgage', { exact: true }).click()
    const dialog = page.getByRole('dialog')
    const history = dialog.getByRole('region', { name: 'Expenses transaction history' })
    await expect(history).toBeVisible()
    await expect(history.getByRole('heading', { level: 3 })).toHaveText([
      'June 2026', 'May 2026', 'April 2026', 'March 2026', 'February 2026', 'January 2026',
    ])
    await expect(history.locator('.entry-month')).toHaveCount(6)
    await expect(history.locator('.entry-row')).toHaveCount(24)
    await expect(history.locator('button.entry-month-header, [aria-expanded]')).toHaveCount(0)
    await expect(history.getByText('Scheduled loan payment')).toHaveCount(24)
    await expect(dialog.getByRole('img', { name: 'Inherited from a source' })).toHaveCount(25)
    for (const surface of [dialog, history]) {
      expect(await surface.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    }
    expect(await history.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true)
    await expect(history).not.toHaveAttribute('tabindex')
    await expect(history.locator('.entry-day, .entry-check, .entry-actions, [role=checkbox], input[type=checkbox]')).toHaveCount(0)
    await expect(history.locator('button.entry-row')).toHaveCount(24)
    await history.getByRole('heading', { name: 'June 2026' }).click()
    await expect(history.locator('.entry-row')).toHaveCount(24)
    await history.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `test-results/expense-inherited-detail-${width}.png`, fullPage: true })
    const detailScroller = dialog.locator(':scope > .page-stack')
    expect(await detailScroller.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true)
    await detailScroller.evaluate((node) => node.scrollTo(0, node.scrollHeight))
    expect(await detailScroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
    expect(await history.evaluate((node) => node.scrollTop)).toBe(0)
    await history.locator('.entry-row').last().scrollIntoViewIfNeeded()
    await expect(history.getByRole('heading', { name: 'January 2026' })).toBeInViewport()
    await expect(history.locator('.entry-row').last()).toBeInViewport()
    await page.screenshot({ path: `test-results/expense-history-oldest-${width}.png`, fullPage: true })
    await page.keyboard.press('Escape')
    await page.route('http://127.0.0.1:4174/api/household/expense-categories/groceries', async (route) => {
      await route.fulfill({ json: {
        ...categories[1], subcategories: [], monthly_totals: [],
        entries: [{ id: 'manual', description: 'Weekly groceries and household essentials with a deliberately long transaction name', amount: 12345.67, entry_date: '2026-06-15', owner_scope: 'spouse', notes: 'A long receipt note covering food, cleaning supplies, and other household purchases', data_source: 'app_manual' }],
      } })
    })
    await page.getByRole('group', { name: 'Filter by category' }).getByRole('button', { name: 'Living', exact: true }).click()
    await page.getByText('Groceries', { exact: true }).click()
    const manualHistory = page.getByRole('region', { name: 'Expenses transaction history' })
    const manualRow = manualHistory.locator('.entry-row')
    await manualRow.scrollIntoViewIfNeeded()
    await expect(manualRow).toHaveJSProperty('tagName', 'BUTTON')
    await expect(manualRow.locator('button, .entry-day, .entry-check, .entry-actions, [role=checkbox], input[type=checkbox]')).toHaveCount(0)
    await expect(manualRow.locator('.entry-owner')).toBeVisible()
    await expect(manualRow.locator('.entry-note')).toBeVisible()
    const titleBox = await manualRow.locator('.entry-name').boundingBox()
    const amountBox = await manualRow.locator('.entry-amount').boundingBox()
    expect(titleBox).not.toBeNull()
    expect(amountBox).not.toBeNull()
    expect(Math.abs(titleBox!.y - amountBox!.y)).toBeLessThan(3)
    expect(amountBox!.x).toBeGreaterThan(titleBox!.x + titleBox!.width - 1)
    const rowBox = await manualRow.boundingBox()
    expect(rowBox!.x + rowBox!.width - amountBox!.x - amountBox!.width).toBeLessThan(24)
    for (const surface of [page.getByRole('dialog'), manualHistory, manualRow]) {
      expect(await surface.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    }
    await page.screenshot({ path: `test-results/expense-history-manual-${width}.png`, fullPage: true })
    await manualRow.click()
    const actions = page.getByRole('dialog', { name: 'Expense actions' })
    await expect(actions.getByRole('button', { name: 'Delete expense' })).toBeVisible()
    if (width < 600) {
      const sheet = await actions.boundingBox()
      expect(sheet).not.toBeNull()
      expect(sheet!.height).toBeLessThan(900)
      await expect.poll(async () => {
        const box = await actions.boundingBox()
        return box ? Math.abs(box.y + box.height - 900) : Infinity
      }).toBeLessThan(2)
    }
    await page.screenshot({ path: `test-results/expense-actions-${width}.png`, fullPage: true })
    await actions.getByRole('button', { name: 'Edit expense' }).click()
    const editor = page.getByRole('dialog', { name: 'Edit expense' })
    await expect(editor.getByRole('textbox', { name: 'Description (optional)' })).toHaveValue('Weekly groceries and household essentials with a deliberately long transaction name')
    await page.screenshot({ path: `test-results/expense-edit-${width}.png`, fullPage: true })
    await page.route('http://127.0.0.1:4174/api/household/expenses/manual', async (route) => route.fulfill({ json: {} }))
    const update = page.waitForRequest((request) => request.method() === 'PUT' && request.url().includes('/manual'))
    await editor.getByRole('button', { name: 'Update expense' }).click()
    await update
    await expect(editor).toHaveCount(0)

    await manualRow.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: 30, clientY: 30 })
    await manualRow.dispatchEvent('pointermove', { pointerId: 1, pointerType: 'touch', clientX: 30, clientY: 60 })
    await page.waitForTimeout(600)
    await manualRow.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch' })
    await expect(page.getByRole('button', { name: 'Exit selection' })).toHaveCount(0)
    await manualRow.dispatchEvent('pointerdown', { pointerId: 2, pointerType: 'touch', isPrimary: true, button: 0, clientX: 30, clientY: 30 })
    await manualRow.dispatchEvent('pointercancel', { pointerId: 2, pointerType: 'touch' })
    await page.waitForTimeout(600)
    await expect(page.getByRole('button', { name: 'Exit selection' })).toHaveCount(0)
    await manualRow.dispatchEvent('pointerdown', { pointerId: 3, pointerType: 'touch', isPrimary: true, button: 0, clientX: 30, clientY: 30 })
    await page.waitForTimeout(600)
    await manualRow.dispatchEvent('pointerup', { pointerId: 3, pointerType: 'touch' })
    await manualRow.dispatchEvent('click')
    await expect(manualRow).toHaveAttribute('aria-pressed', 'true')
    await expect(actions).toHaveCount(0)
    await page.getByRole('button', { name: 'Clear all', exact: true }).click()
    await expect(manualRow).toHaveAttribute('aria-pressed', 'false')
    await page.getByRole('button', { name: 'Select all', exact: true }).click()
    await expect(manualRow).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Exit selection' }).click()
    await manualRow.focus()
    await page.keyboard.press('Shift+Space')
    await expect(manualRow).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Exit selection' }).click()
    await manualRow.click({ button: 'right' })
    await expect(manualRow).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Exit selection' }).click()
    await manualRow.click()
    page.once('dialog', (dialog) => dialog.accept())
    const deletion = page.waitForRequest((request) => request.method() === 'DELETE' && request.url().includes('/manual'))
    await actions.getByRole('button', { name: 'Delete expense' }).click()
    await deletion
    await expect(actions).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button', { name: 'Dismiss success message' }).click()
    await page.locator('.app-content').evaluate((node) => node.scrollTo(0, 0))
    await page.getByRole('button', { name: 'Date range', exact: true }).click()
    await page.getByRole('option', { name: 'Current month', exact: true }).click()
    await expect(page.getByRole('heading', { name: /Spending trend/ })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Expense mix', exact: true })).toBeVisible()
    expect(errors).toEqual([])
  })
}

test('collapsed quick-filter dots scroll horizontally when they overflow', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
    const groups = Array.from({ length: 24 }, (_, index) => ({
      id: `group-${index}`, name: `Category ${String(index + 1).padStart(2, '0')}`,
      color: `${(index * 9) % 255} ${(index * 5) % 255} ${(index * 11) % 255}`,
      notes: '', sort_order: index, is_retired: false, can_delete: true, is_source_linked: false,
    }))
    const categories = groups.map((group, index) => ({
      id: `cat-${index}`, name: `Category ${String(index + 1).padStart(2, '0')}`, expense_group_id: group.id,
      is_system: false, is_retired: false, can_delete: true, is_source_linked: false,
      sort_order: index, total_amount: 60, monthly_average: 10, entry_count: 6,
    }))
    const monthlyTotals = groups.flatMap((group, index) =>
      Array.from({ length: 6 }, (_, month) => ({ category_id: `cat-${index}`, period: `2026-0${month + 1}`, value: 10 })))
    await page.setViewportSize({ width: 390, height: 900 })
    await page.route('http://127.0.0.1:4174/api/**', async (route) => {
      const url = new URL(route.request().url())
      const json = url.pathname === '/api/auth/session' ? session
        : url.pathname === '/api/household/expenses/board' ? { groups, categories, monthly_totals: monthlyTotals }
        : []
      await route.fulfill({ json })
    })
    await page.addInitScript(() => localStorage.setItem('checkbook.session', 'presentation'))
    await page.goto('/expenses')
    const chipRow = page.getByRole('group', { name: 'Filter by category' })
    await expect(chipRow).toBeVisible()
    // One 2rem-tall row that overflows, scrolls horizontally, and shows no scrollbar.
    expect(await chipRow.evaluate((node) => node.clientHeight)).toBeLessThanOrEqual(33)
    expect(await chipRow.evaluate((node) => node.scrollWidth)).toBeGreaterThan(await chipRow.evaluate((node) => node.clientWidth))
    await expect(chipRow).toHaveCSS('overflow-x', 'auto')
    await expect(chipRow).toHaveCSS('scrollbar-width', 'none')
    await chipRow.evaluate((node) => { node.scrollLeft = node.scrollWidth })
    expect(await chipRow.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0)
    expect(errors).toEqual([])
  })
