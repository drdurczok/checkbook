import { expect, test, type Page, type Route } from '@playwright/test'

const settings = { id: 's', privacy_mode: 'private_joint', allow_cross_member_visibility: false, projection_baseline_window_months: 6, projection_horizon_months: 18, savings_allocation_strategy: 'keep_cash_positive', role_permissions: {} }
const session = { token: 'expense-suggestions', expires_at: '2099-01-01T00:00:00Z', user: { id: 'u', email: 'u@example.com', full_name: 'User', picture_url: '' }, household: { id: 'h', name: 'House', base_currency: 'PLN', timezone: 'Europe/Warsaw' }, membership: { id: 'm', role: 'owner', relationship_kind: 'owner' }, settings }
const groups = [
  { id: 'food', name: 'Food', color: '217 119 6', notes: '', sort_order: 0, is_retired: false, can_delete: false, is_source_linked: false },
  { id: 'transport', name: 'Transport', color: '', notes: '', sort_order: 1, is_retired: false, can_delete: false, is_source_linked: false },
]
const categories = [
  { id: 'other', name: 'Other expenses', expense_group_id: null },
  { id: 'coffee', name: 'Coffee', expense_group_id: 'food' },
  { id: 'bakery', name: 'Bakery', expense_group_id: 'food' },
  { id: 'fuel', name: 'Fuel', expense_group_id: 'transport' },
  { id: 'repairs', name: 'Repairs', expense_group_id: 'transport' },
].map((category, sort_order) => ({ ...category, parent_id: null, sort_order, is_system: false, is_retired: false, can_delete: true, is_source_linked: false, total_amount: 25, monthly_average: 25, entry_count: 1, last_entry_date: '2026-06-01' }))
const coffeeSuggestions = [
  { description: 'Coffee shop', category_id: 'coffee', category_name: 'Coffee', expense_group_id: 'food' },
  { description: 'Coffee service', category_id: 'repairs', category_name: 'Repairs', expense_group_id: 'transport' },
]
const bakerySuggestions = [{ description: 'Bakery visit', category_id: 'bakery', category_name: 'Bakery', expense_group_id: 'food' }]

async function setup(page: Page, baseURL: string | undefined, width: number, suggestionRoute?: (route: Route, query: string) => Promise<void>) {
  const errors: string[] = []
  const unexpectedRequests: string[] = []
  const queries: string[] = []
  const submitted: Record<string, unknown>[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
  page.on('requestfailed', (request) => errors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`))
  await page.setViewportSize({ width, height: 900 })
  await page.route(`${baseURL}/api/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/api/household/expenses/suggestions') {
      expect(request.method()).toBe('GET')
      const query = url.searchParams.get('query') ?? ''
      queries.push(query)
      if (suggestionRoute) return suggestionRoute(route, query)
      return route.fulfill({ json: query.startsWith('co') ? coffeeSuggestions : query.startsWith('ba') ? bakerySuggestions : [] })
    }
    if (url.pathname === '/api/household/expenses' && request.method() === 'POST') {
      submitted.push(request.postDataJSON())
      return route.fulfill({ json: { id: 'added', record_type: 'expense', name: submitted.at(-1)?.description } })
    }
    const responses: Record<string, unknown> = {
      '/api/auth/session': session,
      '/api/household/settings': settings,
      '/api/household/expenses/board': { groups, categories, monthly_totals: [] },
      '/api/household/expenses/recurring': [],
      '/api/household/categories': [],
      '/api/household/assets': [],
      '/api/backups/config': { path: '', retention: 0 },
    }
    if (!(url.pathname in responses)) unexpectedRequests.push(`${request.method()} ${url.pathname}`)
    await route.fulfill({ json: responses[url.pathname] ?? [] })
  })
  await page.addInitScript(() => localStorage.setItem('checkbook.session', 'expense-suggestions'))
  await page.goto('/expenses')
  await page.getByRole('button', { name: 'Add expense', exact: true }).click()
  return { errors, unexpectedRequests, queries, submitted }
}

for (const width of [1280, 390]) {
  test(`historical expense names support accessible keyboard and pointer selection at ${width}px`, async ({ page, baseURL }) => {
    const logs = await setup(page, baseURL, width)
    const dialog = page.getByRole('dialog')
    const name = dialog.getByRole('combobox', { name: 'Name', exact: true })
    const listbox = dialog.getByRole('listbox', { name: 'Expense name suggestions' })
    const category = dialog.getByRole('combobox', { name: 'Category', exact: true })
    const group = dialog.getByRole('combobox', { name: 'Group', exact: true })
    await expect(category).toHaveValue('')
    await expect(group).toHaveValue('Other expenses')
    await name.fill('co')
    await expect(listbox).toBeVisible()
    await expect(name).toHaveAttribute('aria-autocomplete', 'list')
    await expect(name).toHaveAttribute('aria-expanded', 'true')
    await expect(name).toHaveAttribute('aria-controls', await listbox.getAttribute('id') ?? '')
    const options = listbox.getByRole('option')
    await expect(options).toHaveCount(2)
    await expect(options.nth(0)).toContainText('Coffee shop')
    await expect(options.nth(0)).toContainText('Food / Coffee')
    await expect(options.nth(1)).toContainText('Transport / Repairs')
    await expect(name).toHaveValue('co')
    await expect(category).toHaveValue('food')
    await expect(group).toHaveValue('Coffee')
    await name.press('ArrowDown')
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true')
    await name.press('ArrowDown')
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
    await name.press('ArrowUp')
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true')
    await expect(name).toHaveAttribute('aria-activedescendant', await options.nth(0).getAttribute('id') ?? '')
    await page.screenshot({ path: `test-results/expense-name-suggestions-${width}.png`, fullPage: true })
    const geometry = await listbox.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right, viewport: window.innerWidth, overflow: element.scrollWidth > element.clientWidth + 1 }
    })
    expect(geometry.left).toBeGreaterThanOrEqual(0)
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport)
    expect(geometry.overflow).toBe(false)
    await name.press('Enter')
    await expect(name).toHaveValue('Coffee shop')
    await expect(name).toBeFocused()
    await expect(listbox).toHaveCount(0)
    await expect(dialog).toBeVisible()
    expect(logs.submitted).toEqual([])
    await name.fill('co')
    await expect(listbox).toBeVisible()
    await name.press('Escape')
    await expect(listbox).toHaveCount(0)
    await expect(name).toHaveAttribute('aria-expanded', 'false')
    await expect(dialog).toBeVisible()
    await name.press('ArrowDown')
    await expect(listbox).toBeVisible()
    await options.nth(1).click()
    await expect(name).toHaveValue('Coffee service')
    await expect(category).toHaveValue('transport')
    await expect(group).toHaveValue('Repairs')
    await expect(listbox).toHaveCount(0)
    await expect(name).toBeFocused()
    expect(logs.unexpectedRequests).toEqual([])
    expect(logs.errors).toEqual([])
  })

  test(`manual category or group locks both fields until a fresh expense at ${width}px`, async ({ page, baseURL }) => {
    const logs = await setup(page, baseURL, width)
    const dialog = page.getByRole('dialog')
    const name = dialog.getByRole('combobox', { name: 'Name', exact: true })
    const category = dialog.getByRole('combobox', { name: 'Category', exact: true })
    const group = dialog.getByRole('combobox', { name: 'Group', exact: true })
    const listbox = dialog.getByRole('listbox', { name: 'Expense name suggestions' })
    await name.fill('co')
    await expect(category).toHaveValue('food')
    await expect(group).toHaveValue('Coffee')
    await category.selectOption('transport')
    await expect(group).toHaveValue('Fuel')
    await name.fill('ba')
    await expect(listbox).toBeVisible()
    await expect(category).toHaveValue('transport')
    await expect(group).toHaveValue('Fuel')
    await listbox.getByRole('option', { name: /Bakery visit/ }).click()
    await expect(name).toHaveValue('Bakery visit')
    await expect(category).toHaveValue('transport')
    await expect(group).toHaveValue('Fuel')
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: 'Add expense', exact: true }).click()
    await expect(name).toHaveValue('')
    await name.fill('co')
    await expect(category).toHaveValue('food')
    await expect(group).toHaveValue('Coffee')
    await group.selectOption('Bakery')
    await name.fill('')
    await expect(listbox).toHaveCount(0)
    await name.fill('co')
    await listbox.getByRole('option', { name: /Coffee service/ }).click()
    await expect(name).toHaveValue('Coffee service')
    await expect(category).toHaveValue('food')
    await expect(group).toHaveValue('Bakery')
    await dialog.getByRole('textbox', { name: 'Amount', exact: true }).fill('12.50')
    await dialog.getByRole('button', { name: 'Add Expense', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    expect(logs.submitted).toHaveLength(1)
    expect(logs.submitted[0]).toMatchObject({ description: 'Coffee service', category_name: 'Bakery', amount: 12.5 })
    await page.getByRole('button', { name: 'Add expense', exact: true }).click()
    await name.fill('co')
    await expect(category).toHaveValue('food')
    await expect(group).toHaveValue('Coffee')
    expect(logs.unexpectedRequests).toEqual([])
    expect(logs.errors).toEqual([])
  })
}

test('expense history queries debounce at the 200ms boundary', async ({ page, baseURL }) => {
  const logs = await setup(page, baseURL, 1280)
  await page.clock.install({ time: new Date('2026-06-15T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-06-15T12:00:01Z'))
  const name = page.getByRole('dialog').getByRole('combobox', { name: 'Name', exact: true })
  await name.fill('c')
  await page.clock.runFor(500)
  expect(logs.queries).toEqual([])
  await name.fill('co')
  await page.clock.runFor(199)
  expect(logs.queries).toEqual([])
  await page.clock.runFor(1)
  await expect.poll(() => logs.queries).toEqual(['co'])
  expect(logs.unexpectedRequests).toEqual([])
  expect(logs.errors).toEqual([])
})

test('expense history ignores stale results and never runs for loan names', async ({ page, baseURL }) => {
  let releaseStale: (() => void) | undefined
  const staleGate = new Promise<void>((resolve) => { releaseStale = resolve })
  const logs = await setup(page, baseURL, 1280, async (route, query) => {
    if (query === 'co') {
      await staleGate
      await route.fulfill({ json: coffeeSuggestions })
    } else {
      await route.fulfill({ json: query === 'ba' ? bakerySuggestions : [] })
    }
  })
  // Keep real timers for network delivery, Query notifications and React rendering.
  const dialog = page.getByRole('dialog')
  const name = dialog.getByRole('combobox', { name: 'Name', exact: true })
  const listbox = dialog.getByRole('listbox', { name: 'Expense name suggestions' })
  await name.fill('co')
  await expect.poll(() => logs.queries).toEqual(['co'])
  await name.fill('ba')
  await expect(listbox.getByRole('option')).toContainText(['Bakery visit'])
  await expect(dialog.getByRole('combobox', { name: 'Group', exact: true })).toHaveValue('Bakery')
  const staleResponse = page.waitForResponse((response) => new URL(response.url()).searchParams.get('query') === 'co')
  releaseStale?.()
  await (await staleResponse).finished()
  // Observe beyond the debounce interval so a late notification cannot pass unnoticed.
  await page.waitForTimeout(500)
  await expect(name).toHaveValue('ba')
  await expect(listbox.getByRole('option')).toContainText(['Bakery visit'])
  await expect(dialog.getByRole('combobox', { name: 'Group', exact: true })).toHaveValue('Bakery')
  await dialog.getByRole('button', { name: 'Expense', exact: true }).click()
  await dialog.getByRole('option', { name: 'Loan', exact: true }).click()
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Coffee loan')
  // A negative request assertion must span the full debounce window.
  await page.waitForTimeout(500)
  await expect(listbox).toHaveCount(0)
  expect(logs.queries).toEqual(['co', 'ba'])
  expect(logs.unexpectedRequests).toEqual([])
  expect(logs.errors).toEqual([])
})
