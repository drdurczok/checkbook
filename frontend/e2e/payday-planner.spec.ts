import Decimal from 'decimal.js'
import { expect, test, type Locator, type Page } from '@playwright/test'
import type { AllocationInput, PaydayPlanner, PlannerAllocation, PlannerSuggestion } from '../src/contracts/payday-planner'

const session = {
  token: 'e2e-token', expires_at: '2099-01-01T00:00:00Z',
  user: { id: 'user-1', email: 'owner@example.com', full_name: 'Test Owner', picture_url: '' },
  household: { id: 'house-1', name: 'Test Household', base_currency: 'USD', timezone: 'Pacific/Kiritimati' },
  membership: { id: 'membership-1', role: 'owner', relationship_kind: 'owner' },
  settings: { id: 'settings-1', privacy_mode: 'household', allow_cross_member_visibility: true, projection_baseline_window_months: 12, projection_horizon_months: 24, savings_allocation_strategy: 'default', role_permissions: {} },
}
const rent: PlannerAllocation = { id: 'rent', title: 'Rent', section: 'mandatory', kind: 'expense', category_id: 'home', subcategory_id: 'rent-category', category_name: 'Home', subcategory_name: 'Rent', amount: '1200.00', notes: 'Due on the first', source: 'template', template_id: 'template-rent', completed: false, completed_at: null, actual_amount: '1200.00', difference: '0.00', percentage: '0.00' }
const suggestions: PlannerSuggestion[] = [
  { key: 'food', title: 'Groceries', section: 'monthly', kind: 'expense', category_id: 'food', subcategory_id: null, category_name: 'Food', subcategory_name: null, amount: '200.00', notes: '', template_id: null, reason: 'Average spending over the last three months' },
  { key: 'savings', title: 'Emergency fund', section: 'flexible', kind: 'savings', category_id: null, subcategory_id: null, category_name: null, subcategory_name: null, amount: '100.00', notes: '', template_id: null, reason: 'Previous month allocation' },
]

async function setup(page: Page, options: { suggestions?: PlannerSuggestion[]; allocations?: PlannerAllocation[] } = {}) {
  const errors: string[] = []
  const months: (string | null)[] = []
  const writes: { path: string; method: string; body: Record<string, unknown> }[] = []
  const plans = new Map<string, PlannerAllocation[]>([['2026-12', options.allocations ?? [{ ...rent }]]])
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
  page.on('requestfailed', (request) => errors.push(`${request.failure()?.errorText} ${request.url()}`))
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()
    const body = method === 'GET' || method === 'DELETE' ? {} : request.postDataJSON() as Record<string, unknown>
    const month = typeof body.month === 'string' ? body.month : url.searchParams.get('month') ?? '2026-12'
    const list = plans.get(month) ?? []
    const bundle = (): PaydayPlanner => {
      const total = list.reduce((sum, item) => sum.plus(item.amount), new Decimal(0))
      return { month, current_month: '2026-12', currency: 'USD', provisional: true, income: '1000.00', total_allocated: total.toFixed(2), remaining: new Decimal('1000.00').minus(total).toFixed(2), completed_total: list.filter((item) => item.completed).reduce((sum, item) => sum.plus(item.amount), new Decimal(0)).toFixed(2), actual_total: '1215.00', unplanned_actual_total: '15.00', allocations: list, templates: Array.from({ length: 1 }, (_, index) => ({ ...rent, id: `template-${index}`, title: index ? `Template ${index + 1}` : rent.title })), suggestions: options.suggestions ?? suggestions, unplanned_actuals: [{ category_id: null, subcategory_id: null, category_name: 'Uncategorized', subcategory_name: null, amount: '15.00' }] }
    }
    if (path === '/api/auth/session') return route.fulfill({ json: session })
    if (path === '/api/household/settings') return route.fulfill({ json: session.settings })
    if (path === '/api/household/expenses/board') return route.fulfill({ json: { groups: [{ id: 'essentials', name: 'Essentials', is_retired: false }], categories: [{ id: 'home', name: 'Home', expense_group_id: 'essentials', is_retired: false }, { id: 'food', name: 'Food', expense_group_id: 'essentials', is_retired: false }], monthly_totals: [] } })
    if (path.includes('/household/expense-categories/')) return route.fulfill({ json: { subcategories: [{ id: 'rent-category', name: 'Rent' }], entries: [] } })
    if (path === '/api/payday-planner' && method === 'GET') {
      months.push(url.searchParams.get('month'))
      return route.fulfill({ json: bundle() })
    }
    if (path.startsWith('/api/payday-planner/')) {
      writes.push({ path, method, body })
      if (path.endsWith('/apply')) {
        for (const suggestion of body.items as PlannerSuggestion[]) {
          if (!list.some((item) => item.title === suggestion.title)) list.push({ ...suggestion, id: suggestion.key, source: 'suggestion', completed: false, completed_at: null, actual_amount: null, difference: null, percentage: null })
        }
      } else if (path.includes('/allocations') && method === 'POST') {
        list.push({ ...(body as unknown as AllocationInput), id: `new-${writes.length}`, source: 'manual', template_id: body.recurring ? `template-new-${writes.length}` : null, expense_group_name: body.expense_group_id === 'essentials' ? 'Essentials' : null, category_name: body.category_id === 'home' ? 'Home' : body.category_id === 'food' ? 'Food' : null, subcategory_name: null, completed: false, completed_at: null, actual_amount: null, difference: null, percentage: null })
      } else if (path.includes('/allocations/') && method === 'PUT') {
        const index = list.findIndex((item) => item.id === path.split('/').pop())
        list[index] = { ...list[index], ...body, template_id: typeof body.recurring === 'boolean' ? body.recurring ? list[index].template_id ?? `template-${list[index].id}` : null : list[index].template_id } as PlannerAllocation
      } else if (path.includes('/allocations/') && method === 'DELETE') {
        for (const entries of plans.values()) {
          const index = entries.findIndex((item) => item.id === path.split('/').pop())
          if (index >= 0) entries.splice(index, 1)
        }
      }
      plans.set(month, list)
      return route.fulfill({ json: method === 'DELETE' ? { ok: true } : bundle() })
    }
    return route.fulfill({ json: [] })
  })
  await page.addInitScript(() => localStorage.setItem('checkbook.session', 'e2e-token'))
  return { errors, months, writes }
}

async function expectDialogScroll(page: Page, dialog: Locator, body: Locator) {
  await expect(dialog).toBeVisible()
  await expect(page.locator('.app-content')).toHaveCSS('overflow', 'hidden')
  const header = dialog.locator('.drive-picker__header, .record-add-header')
  await dialog.evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished)) })
  const bounds = await dialog.boundingBox()
  const viewport = page.viewportSize()
  if (!bounds || !viewport) throw new Error('Expected a visible dialog in a fixed viewport')
  expect(bounds.y).toBeGreaterThanOrEqual(0)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height)
  const headerBounds = await header.boundingBox()
  if (!headerBounds) throw new Error('Expected a visible dialog header')
  const headerTop = headerBounds.y
  expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  await body.hover()
  await page.mouse.wheel(0, 10000)
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect(header.getByRole('button', { name: 'Close', exact: true })).toBeInViewport()
  expect((await header.boundingBox())?.y).toBe(headerTop)
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
}

async function expectPlanningNavigation(page: Page) {
  const navigation = page.locator('.app-bottom-nav')
  await expect(navigation.locator('button[data-nav-label="Planning"]')).toHaveClass('is-active')
  await expect(navigation.locator('button[data-nav-label="Income"]')).not.toHaveClass('is-active')
}

function allocationCard(page: Page, title: string) {
  return page.locator('.planner-item__card').filter({ has: page.locator('.planner-item__title', { hasText: new RegExp('^' + title + '$') }) })
}

async function openAllocationEditor(page: Page, title: string) {
  const card = allocationCard(page, title)
  await card.scrollIntoViewIfNeeded()
  await card.hover()
  await page.mouse.down()
  try {
    // Wait for the real 500ms pointer hold instead of dispatching a click.
    await expect(page.getByRole('dialog')).toBeVisible()
  } finally {
    await page.mouse.up()
  }
  return page.getByRole('dialog')
}

async function expectEditorFooter(dialog: Locator, action: 'Done' | 'Create') {
  const footer = dialog.locator('.planner-form__actions')
  const submit = footer.getByRole('button', { name: action, exact: true })
  const repeat = footer.getByRole('button', { name: 'Repeat every month', exact: true })
  await expect(submit).toBeVisible()
  const footerBounds = await footer.boundingBox()
  const submitBounds = await submit.boundingBox()
  const repeatBounds = await repeat.boundingBox()
  if (!footerBounds || !submitBounds || !repeatBounds) throw new Error('Expected visible allocation footer controls')
  expect(Math.abs(submitBounds.x + submitBounds.width / 2 - (footerBounds.x + footerBounds.width / 2))).toBeLessThanOrEqual(1)
  expect(Math.abs(repeatBounds.y + repeatBounds.height / 2 - (submitBounds.y + submitBounds.height / 2))).toBeLessThanOrEqual(1)
  expect(repeatBounds.x).toBeGreaterThan(submitBounds.x + submitBounds.width)
  const remove = footer.getByRole('button', { name: 'Delete allocation', exact: true })
  if (action === 'Done') {
    await expect(remove).toBeVisible()
    await expect(remove).toHaveAttribute('title', 'Delete allocation')
    await expect(remove.locator('svg')).toBeVisible()
    expect(await remove.textContent()).toBe('')
    const deleteBounds = await remove.boundingBox()
    if (!deleteBounds) throw new Error('Expected visible delete allocation icon')
    expect(deleteBounds.width).toBe(deleteBounds.height)
    expect(deleteBounds.x + deleteBounds.width).toBeLessThan(submitBounds.x)
    expect(Math.abs(deleteBounds.y + deleteBounds.height / 2 - (submitBounds.y + submitBounds.height / 2))).toBeLessThanOrEqual(1)
  } else await expect(remove).toHaveCount(0)
}

async function expectPlannerMonthHeader(page: Page) {
  const picker = page.locator('.planner-month__picker')
  await expect(picker).toHaveText('December 2026')
  await expect(picker.locator('svg')).toBeVisible()
  await expect(page.getByLabel('Month and year')).toHaveValue('2026-12')
  await expect(page.getByRole('link', { name: 'Back to Planning' })).toHaveCount(0)
  const previous = await page.getByRole('button', { name: 'Previous month', exact: true }).boundingBox()
  const next = await page.getByRole('button', { name: 'Next month', exact: true }).boundingBox()
  const label = await picker.boundingBox()
  const profile = await page.locator('.app-topbar-profile').boundingBox()
  const header = await page.locator('.app-topbar').boundingBox()
  if (!previous || !next || !label || !header) throw new Error('Expected visible month controls')
  expect(previous.x).toBeLessThan(header.x + header.width / 4)
  expect(next.x).toBeGreaterThan(header.x + header.width * .65)
  expect(previous.x + previous.width).toBeLessThanOrEqual(label.x)
  expect(label.x + label.width).toBeLessThanOrEqual(next.x)
  if (profile) expect(next.x + next.width).toBeLessThanOrEqual(profile.x)
  await expect(picker).toHaveCSS('border-top-width', '0px')
}

test('Planning navigation, household month, allocation CRUD and completion', async ({ page }) => {
  const state = await setup(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/planning')
  await expect(page).toHaveURL(/\/planning$/)
  await expectPlanningNavigation(page)
  await expect(page.locator('.payday-planner h1')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Current month', exact: true })).toHaveCount(0)
  await expect(page.locator('.planner-balance')).toHaveCount(0)
  await expect(page.getByLabel('Month and year')).toHaveValue('2026-12')
  expect(state.months[0]).toBeNull()
  await expect(page.locator('.planner-summary')).toContainText('-200.00')
  await expect(page.locator('.app-topbar').getByLabel('Month and year')).toBeVisible()
  await expectPlannerMonthHeader(page)
  const rentCard = allocationCard(page, 'Rent')
  await expect(rentCard).toContainText('Rent')
  await expect(rentCard.locator('.planner-item__amount')).toHaveText('1200.00')
  await expect(rentCard.locator('..')).toHaveCSS('border-top-width', '0px')
  await expect(rentCard.locator('.planner-item__currency')).toHaveCount(0)
  await expect(page.getByRole('table')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Analyze', exact: true })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Difference %', exact: true })).toHaveCount(0)
  await expect(page.locator('.planner-item input[type="checkbox"]')).toHaveCount(0)
  await rentCard.click()
  await expect(rentCard).toHaveAttribute('aria-pressed', 'true')
  await rentCard.click()
  await expect(rentCard).toHaveAttribute('aria-pressed', 'false')
  await page.screenshot({ path: 'test-results/payday-planner-desktop.png', fullPage: true })
  await page.getByRole('button', { name: 'Next month', exact: true }).click()
  await expect(page.getByLabel('Month and year')).toHaveValue('2027-01')
  expect(state.months).toContain('2027-01')
  await page.getByRole('button', { name: 'Previous month', exact: true }).click()
  await expect(page.getByLabel('Month and year')).toHaveValue('2026-12')
  await rentCard.click()
  await expect(rentCard).toHaveAttribute('aria-pressed', 'true')
  await expect(rentCard.locator('..')).toHaveClass(/planner-item--completed/)
  expect(state.writes.some((write) => write.method === 'PUT' && write.body.completed === true)).toBe(true)
  await rentCard.click()
  await expect(rentCard).toHaveAttribute('aria-pressed', 'false')
  await expect(rentCard.locator('..')).not.toHaveClass(/planner-item--completed/)
  expect(state.writes.some((write) => write.method === 'PUT' && write.body.completed === false)).toBe(true)
  const rentEditor = await openAllocationEditor(page, 'Rent')
  await expect(rentEditor.getByLabel('Notes', { exact: true })).toHaveValue('Due on the first')
  await expectEditorFooter(rentEditor, 'Done')
  await rentEditor.getByRole('button', { name: 'Done', exact: true }).click()
  await page.locator('.panel').filter({ has: page.getByRole('heading', { name: 'Flexible Allocations', exact: true }) }).getByRole('button', { name: 'Add', exact: true }).click()
  const editor = page.getByRole('dialog')
  await expect(editor.getByLabel('Section', { exact: true })).toHaveCount(0)
  await expect(editor.getByRole('option', { name: 'Whole category', exact: true })).toHaveCount(0)
  await expect(editor.getByLabel('Notes', { exact: true })).toHaveCount(0)
  await expect(editor.getByRole('button', { name: 'Add notes', exact: true })).toBeVisible()
  await expectEditorFooter(editor, 'Create')
  await editor.getByLabel('Name', { exact: true }).fill('Holiday fund')
  await editor.getByLabel('Amount', { exact: true }).fill('25.67')
  await editor.getByLabel('Type', { exact: true }).selectOption('savings')
  await editor.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(editor).not.toBeVisible()
  await expect(allocationCard(page, 'Holiday fund')).toBeVisible()
  await openAllocationEditor(page, 'Holiday fund')
  await page.getByRole('dialog').getByLabel('Amount', { exact: true }).fill('26.78')
  await page.getByRole('dialog').getByLabel('Name', { exact: true }).click()
  await expect.poll(() => state.writes.filter((write) => write.method === 'PUT').at(-1)?.body.amount).toBe('26.78')
  await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click()
  const deleteEditor = await openAllocationEditor(page, 'Holiday fund')
  await deleteEditor.getByRole('button', { name: 'Delete allocation', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm delete' }).click()
  await expect(allocationCard(page, 'Holiday fund')).toHaveCount(0)
  await page.locator('.app-sidebar-toggle').click()
  await page.locator('.app-sidebar').getByRole('button', { name: 'Planning', exact: true }).click()
  await expect(page).toHaveURL(/\/planning$/)
  expect(state.errors).toEqual([])
})

test('allocation positions persist on create and edit and reorder after reload', async ({ page }) => {
  const state = await setup(page, { allocations: [
    { ...rent, id: 'later', title: 'Later payment', position: 8 },
    { ...rent, id: 'earlier', title: 'Earlier payment', position: 2 },
  ] })
  await page.goto('/planning')
  const titles = page.locator('.planner-item__title')
  await expect(titles).toHaveText(['Earlier payment', 'Later payment'])
  await page.locator('.panel').filter({ has: page.getByRole('heading', { name: 'Mandatory Payments', exact: true }) }).getByRole('button', { name: 'Add', exact: true }).click()
  const editor = page.getByRole('dialog')
  await expect(editor.getByRole('spinbutton', { name: 'Position', exact: true })).toHaveValue('9')
  await editor.getByLabel('Category', { exact: true }).selectOption('essentials')
  await editor.getByLabel('Group', { exact: true }).selectOption('home')
  await editor.getByLabel('Name', { exact: true }).fill('Middle payment')
  await editor.getByLabel('Amount', { exact: true }).fill('10.00')
  await editor.getByRole('spinbutton', { name: 'Position', exact: true }).fill('4')
  await editor.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(editor).not.toBeVisible()
  expect(state.writes.find((write) => write.method === 'POST')?.body.position).toBe(4)
  await expect(titles).toHaveText(['Earlier payment', 'Middle payment', 'Later payment'])
  const edit = await openAllocationEditor(page, 'Later payment')
  await expect(edit.getByRole('spinbutton', { name: 'Position', exact: true })).toHaveValue('8')
  await edit.getByRole('spinbutton', { name: 'Position', exact: true }).fill('1')
  await edit.getByLabel('Name', { exact: true }).click()
  await expect.poll(() => state.writes.filter((write) => write.method === 'PUT').at(-1)?.body.position).toBe(1)
  await edit.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(titles).toHaveText(['Later payment', 'Earlier payment', 'Middle payment'])
  await page.reload()
  await expect(titles).toHaveText(['Later payment', 'Earlier payment', 'Middle payment'])
  expect(state.errors).toEqual([])
})

test.describe('touch payments', () => {
  // Real touch input: browsers fire pointerleave after pointerup, just before the tap's click.
  test.use({ hasTouch: true })

  test('tapping a payment toggles completion while holding opens the editor', async ({ page }) => {
    const state = await setup(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/planning')
    const rentCard = allocationCard(page, 'Rent')
    await expect(rentCard.locator('.planner-item__amount')).toHaveText('1200.00')
    await rentCard.tap()
    await expect(rentCard).toHaveAttribute('aria-pressed', 'true')
    await rentCard.tap()
    await expect(rentCard).toHaveAttribute('aria-pressed', 'false')
    const editor = await openAllocationEditor(page, 'Rent')
    await expectEditorFooter(editor, 'Done')
    // The hold that opened the editor must not leave a native text selection on its labels.
    await expect.poll(() => page.evaluate(() => String(document.getSelection()))).toBe('')
    expect(state.errors).toEqual([])
  })
})

test('mobile analysis routing preserves month, clean cards and layout', async ({ page }) => {
  const state = await setup(page, { allocations: [{ ...rent, notes: '' }] })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/planning')
  await expectPlannerMonthHeader(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/payday-planner-planning-entry-mobile.png', fullPage: true })
  await expect(page).toHaveURL(/\/planning$/)
  await expectPlanningNavigation(page)
  await expect(page.locator('.planner-summary')).toContainText('-200.00')
  await expect(page.getByText('Provisional - actual spending may still change')).toHaveCount(0)
  await expect(page.getByRole('columnheader', { name: 'Difference %', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Use Suggested', exact: true })).toHaveCount(0)
  await expect(page.getByRole('table')).toHaveCount(0)
  await expect(page.locator('.planner-section.card')).toHaveCount(3)
  await page.getByRole('link', { name: 'Analyze', exact: true }).click()
  await expect(page).toHaveURL(/\/planning\/analyze\?month=2026-12$/)
  await expect(page.getByRole('table')).toBeVisible()
  await page.getByRole('tab', { name: 'Unplanned Actual' }).click()
  await expect(page.getByRole('table')).toHaveCount(0)
  await expect(page.getByRole('tabpanel')).toContainText('$15.00')
  await page.getByRole('button', { name: 'Next month', exact: true }).click()
  await expect(page.getByLabel('Month and year')).toHaveValue('2027-01')
  await page.getByRole('link', { name: 'Close analysis' }).click()
  await expect(page).toHaveURL(/\/planning\?month=2027-01$/)
  await page.getByRole('button', { name: 'Previous month', exact: true }).click()
  await expect(page.getByLabel('Month and year')).toHaveValue('2026-12')
  expect(state.writes).toHaveLength(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expectPlannerMonthHeader(page)
  await page.screenshot({ path: 'test-results/payday-planner-mobile.png', fullPage: true })
  const editor = await openAllocationEditor(page, 'Rent')
  await expectEditorFooter(editor, 'Done')
  await expect(editor.getByLabel('Notes', { exact: true })).toHaveCount(0)
  await editor.getByRole('button', { name: 'Add notes', exact: true }).click()
  await expect(editor.getByLabel('Notes', { exact: true })).toBeVisible()
  await expect(editor).toHaveClass(/modal-sheet/)
  const editorBounds = await editor.boundingBox()
  if (!editorBounds) throw new Error('Expected visible allocation sheet')
  expect(editorBounds.height).toBeLessThan(844)
  expect(editorBounds.y).toBeGreaterThan(0)
  const categoryBounds = await editor.getByLabel('Category', { exact: true }).boundingBox()
  const groupBounds = await editor.getByLabel('Group', { exact: true }).boundingBox()
  expect(categoryBounds?.y).toBe(groupBounds?.y)
  await page.screenshot({ path: 'test-results/payday-planner-mobile-editor.png', fullPage: true })
  await page.keyboard.press('Escape')
  expect(state.errors).toEqual([])
})

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`comparison amounts omit currency and only percentages carry difference colors at ${viewport.width}px`, async ({ page }) => {
    const allocations = [
      { ...rent, id: 'over', title: 'Over budget', actual_amount: '1440.00', difference: '240.00', percentage: '20.00' },
      { ...rent, id: 'under', title: 'Under budget', actual_amount: '1140.00', difference: '-60.00', percentage: '-5.00' },
    ]
    const state = await setup(page, { allocations })
    await page.setViewportSize(viewport)
    await page.goto('/planning/analyze?month=2026-12')
    const table = page.getByRole('table')
    await expect(table).toBeVisible()
    const tabs = page.getByRole('tablist', { name: 'Plan analysis view' })
    const close = page.getByRole('link', { name: 'Close analysis' })
    await expect(close).toHaveText('')
    const tabsBox = await tabs.boundingBox()
    const closeBox = await close.boundingBox()
    expect(tabsBox).not.toBeNull()
    expect(closeBox).not.toBeNull()
    if (tabsBox && closeBox) {
      expect(Math.abs(tabsBox.y + tabsBox.height / 2 - closeBox.y - closeBox.height / 2)).toBeLessThan(2)
      expect(closeBox.x).toBeGreaterThanOrEqual(tabsBox.x + tabsBox.width)
    }
    await expect(page.locator('.planner-analysis__panel')).toHaveCSS('border-top-width', '0px')
    await expect(table).not.toContainText(/\$|USD/)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    if (viewport.width < 600) {
      const scroller = page.locator('.planner-table-wrap')
      expect(await scroller.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
      await scroller.evaluate((element) => { element.scrollLeft = element.scrollWidth })
      await expect(page.getByRole('columnheader', { name: 'Difference', exact: true })).toBeInViewport()
      await expect(table.getByText('(20.00%)', { exact: true })).toBeInViewport()
      await scroller.evaluate((element) => { element.scrollLeft = 0 })
    }
    await page.screenshot({ path: `test-results/payday-planner-analysis-${viewport.width}.png`, fullPage: true })
    await page.getByRole('tab', { name: 'Planned vs Actual' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('tab', { name: 'Unplanned Actual' })).toBeFocused()
    await expect(page.getByRole('tabpanel')).toContainText('$15.00')
    await page.screenshot({ path: `test-results/payday-planner-unplanned-${viewport.width}.png`, fullPage: true })
    await page.keyboard.press('Home')
    await expect(page.getByRole('tab', { name: 'Planned vs Actual' })).toBeFocused()
    for (const [title, actual, difference, percentage, tone] of [
      ['Over budget', '1440.00', '240.00', '20.00', 'over'],
      ['Under budget', '1140.00', '-60.00', '-5.00', 'under'],
    ]) {
      const row = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: title, exact: true }) })
      const cells = row.getByRole('cell')
      await expect(cells.nth(0)).toHaveText('1200.00')
      await expect(cells.nth(1)).toHaveText(actual)
      await expect(cells.nth(2)).toHaveText(`${difference} (${percentage}%)`)
      const percent = cells.nth(2).locator('.planner-difference')
      await expect(percent).toHaveText(`(${percentage}%)`)
      await expect(percent).toHaveClass(new RegExp(`planner-difference--${tone}`))
      await expect(cells.nth(2)).not.toHaveClass(/planner-difference--/)
      expect(await cells.nth(2).evaluate((element) => getComputedStyle(element).color)).toBe(await cells.nth(0).evaluate((element) => getComputedStyle(element).color))
      expect(await percent.evaluate((element) => getComputedStyle(element).color)).not.toBe(await cells.nth(2).evaluate((element) => getComputedStyle(element).color))
    }
    expect(state.errors).toEqual([])
  })
}

test('legacy Income planner link retains Planning navigation and returns to Planning', async ({ page }) => {
  const state = await setup(page)
  await page.goto('/income/payday-planner')
  await expect(page.getByLabel('Month and year')).toHaveValue('2026-12')
  await expectPlanningNavigation(page)
  await page.locator('.app-sidebar-toggle').click()
  await page.locator('.app-sidebar').getByRole('button', { name: 'Planning', exact: true }).click()
  await expect(page).toHaveURL(/\/planning$/)
  await expectPlannerMonthHeader(page)
  expect(state.errors).toEqual([])
})

for (const viewport of [{ width: 1280, height: 480 }, { width: 390, height: 480 }]) {
  test(`planner dialogs scroll independently at ${viewport.width}px`, async ({ page }) => {
    const state = await setup(page)
    await page.setViewportSize(viewport)
    await page.goto('/planning')
    await expectPlanningNavigation(page)
    await expect(page.locator('.app-topbar').getByLabel('Month and year')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const dialog = page.getByRole('dialog')

    for (const section of ['Mandatory Payments', 'Additional Payments', 'Flexible Allocations']) {
      const add = page.locator('.panel').filter({ has: page.getByRole('heading', { name: section, exact: true }) }).getByRole('button', { name: 'Add', exact: true })
      await add.click()
      const picker = dialog.locator('.record-add-kind-toggle')
      const eyebrow = dialog.locator('.drive-picker__header-title > span')
      await expect(eyebrow).toHaveText('Add Allocation')
      await expect(picker).toBeVisible()
      expect(await dialog.evaluate((element) => {
        const title = element.querySelector('.drive-picker__header-title > span')?.getBoundingClientRect()
        const picker = element.querySelector('.record-add-kind-toggle')?.getBoundingClientRect()
        return Boolean(title && picker && picker.top >= title.bottom)
      })).toBe(true)
      await picker.click()
      await expect(dialog.getByRole('listbox', { name: 'Allocation section' })).toBeVisible()
      await expect(dialog.getByRole('option', { name: 'Flexible allocation', exact: true })).toBeInViewport()
      await page.keyboard.press('Escape')
      await expect(dialog.getByRole('listbox')).toHaveCount(0)
      await expect(dialog).toBeVisible()
      await expect(dialog.getByLabel('Section', { exact: true })).toHaveCount(0)
      await expect(dialog.getByRole('option', { name: 'Whole category', exact: true })).toHaveCount(0)
      await expect(dialog.getByLabel('Notes', { exact: true })).toHaveCount(0)
      await dialog.getByRole('button', { name: 'Add notes', exact: true }).click()
      await expectDialogScroll(page, dialog, dialog.locator('.planner-form'))
      const notes = dialog.getByLabel('Notes', { exact: true })
      await notes.focus()
      await expect(notes).toBeFocused()
      await expect(notes).toBeInViewport()
      await notes.fill('The last field remains reachable in a short viewport.')
      if (section === 'Mandatory Payments') await page.screenshot({ path: `test-results/payday-planner-editor-${viewport.width}.png`, fullPage: true })
      await expectEditorFooter(dialog, 'Create')
      await dialog.getByRole('button', { name: 'Create', exact: true }).focus()
      await page.keyboard.press('Tab')
      await expect(dialog.getByRole('button', { name: 'Repeat every month', exact: true })).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(picker).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(dialog).not.toBeVisible()
      await expect(add).toBeFocused()
    }

    await expect(page.getByRole('button', { name: 'Manage mandatory templates' })).toHaveCount(0)
    await expect(page.locator('.app-content')).not.toHaveCSS('overflow', 'hidden')
    expect(state.errors).toEqual([])
  })
}

for (const section of ['mandatory', 'monthly', 'flexible']) {
  test('recurring and automatic names persist for ' + section, async ({ page }) => {
    const state = await setup(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/planning')
    await page.locator('.planner-section').first().getByRole('button', { name: 'Add', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Mandatory payment', exact: true }).click()
    await dialog.getByRole('option', { name: { mandatory: 'Mandatory payment', monthly: 'Additional payment', flexible: 'Flexible allocation' }[section], exact: true }).click()
    await dialog.getByLabel('Category', { exact: true }).selectOption('essentials')
    const name = dialog.getByLabel('Name', { exact: true })
    await expect(name).toHaveValue('Essentials')
    await expect(dialog.locator('.planner-name--automatic')).toBeVisible()
    await dialog.getByLabel('Group', { exact: true }).selectOption('home')
    await expect(name).toHaveValue('Home')
    await name.fill('Custom home')
    await dialog.getByLabel('Group', { exact: true }).selectOption('food')
    await expect(name).toHaveValue('Custom home')
    await name.fill('')
    await dialog.getByLabel('Amount', { exact: true }).click()
    await expect(name).toHaveValue('Food')
    const repeat = dialog.getByRole('button', { name: 'Repeat every month', exact: true })
    await expect(repeat).toHaveAttribute('aria-pressed', 'false')
    await repeat.click()
    await expect(repeat).toHaveAttribute('aria-pressed', 'true')
    const repeatBounds = await repeat.boundingBox()
    const createBounds = await dialog.getByRole('button', { name: 'Create', exact: true }).boundingBox()
    if (!repeatBounds || !createBounds) throw new Error('Expected footer buttons')
    expect(repeatBounds.width).toBe(repeatBounds.height)
    expect(repeatBounds.x).toBeGreaterThan(createBounds.x)
    expect(state.writes).toHaveLength(0)
    await dialog.getByLabel('Amount', { exact: true }).fill('42.50')
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    expect(state.writes.at(-1)?.body).toMatchObject({ title: 'Food', section, recurring: true, expense_group_id: 'essentials', category_id: 'food' })
    await openAllocationEditor(page, 'Food')
    await expectEditorFooter(dialog, 'Done')
    await expect(repeat).toHaveAttribute('aria-pressed', 'true')
    await repeat.click()
    await expect.poll(() => state.writes.at(-1)?.body.recurring).toBe(false)
    await expect(repeat).toHaveAttribute('aria-pressed', 'false')
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    expect(state.errors).toEqual([])
  })
}
