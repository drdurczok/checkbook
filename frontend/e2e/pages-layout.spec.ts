import { expect, test, type Page } from '@playwright/test'

const session = {
  token: 'layout-test', expires_at: '2099-01-01T00:00:00Z',
  user: { id: 'u', email: 'test@example.com', full_name: 'Tester', picture_url: '' },
  household: { id: 'h', name: 'Layout tests', base_currency: 'PLN', timezone: 'Europe/Warsaw' },
  membership: { id: 'm', role: 'owner', relationship_kind: 'owner' },
  settings: { id: 's', privacy_mode: 'household', allow_cross_member_visibility: true, projection_baseline_window_months: 12, projection_horizon_months: 24, savings_allocation_strategy: 'default', role_permissions: {} },
}

const incomeSource = {
  id: 'source-1', name: 'Software Engineer', source_type: 'employment', owner_scope: 'self',
  started_on: '2025-08-01', ended_on: null, notes: '',
  lines: [{ id: 'line-1', label: 'Base salary', amount: 12000, started_on: '2025-08-01', ended_on: null, owner_scope: null, category: null, fields: [{ label: 'Employer', value: 'Acme Corp' }] }],
  fields: [{ label: 'Employer', value: 'Acme Corp' }], milestones: [], sort_order: 0,
  annual_total: 144000, actual_total: 96000, line_count: 1, entries: [],
}

const asset = {
  id: 'asset-1', name: 'Flat downtown', total_cost: 900000, valuation_date: '2026-01-01',
  status: 'active', started_on: '2020-03-01', ended_on: null, notes: '', item_count: 0,
  completed_item_count: 0, completed_cost: 0, completion_percent: 0, kind: 'asset',
  category: 'property', utilities_enabled: true,
}

const trackedFields = [
  { key: 'electricity', label: 'Electricity', kind: 'metered' as const, unit: 'kWh' },
  { key: 'gas', label: 'Gas', kind: 'metered' as const, unit: 'm³' },
]

const utilityBoard = {
  subject: { id: 'asset-1', kind: 'property' as const, name: 'Flat downtown', group_type: 'flat', started_on: null, ended_on: null, notes: '', tracked_fields: trackedFields },
  trend: [],
  months: [
    { month: '2025-12', values: { electricity: { amount: 190 }, gas: { amount: 70 } }, total: 260 },
    { month: '2026-03', values: { electricity: { amount: 200, usage_amount: 400 }, gas: { amount: 80, usage_amount: 25 } }, total: 280 },
    { month: '2026-04', values: { electricity: { amount: 210, usage_amount: 420 }, gas: { amount: 90, usage_amount: 30 } }, total: 300 },
  ],
}

// A 37-month schedule (2023-01..2026-01) so the table overflows its shell and
// the last months are projected payoff rows.
const paymentSchedule = Array.from({ length: 37 }, (_, index) => ({
  date: `${2023 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-05`,
  payment: 3400,
  interest: 1700 - index * 10,
  principal: 1500 + index * 10,
  extra_principal: 200,
  outstanding_loan_balance: 610000 - index * 2800,
  interest_balance: 12000 - index * 250,
  projected: index >= 30,
}))

const loan = {
  id: 'loan-1', name: 'Home mortgage', current_balance: 600000, monthly_payment: 3400,
  interest_rate: 0.0345, original_balance: 900000, start_date: '2020-03-01', end_date: null,
  notes: 'Refinanced in 2022, extra principal paid quarterly.', projected_payoff_months: 6, interest_remaining: null, linked_property_id: null,
  details: {
    fixed_monthly_payment: 3200,
    period_count: 360,
    payment_schedule: paymentSchedule,
  },
}

const loanWithoutNotes = { ...loan, id: 'loan-2', name: 'Car loan', notes: '' }

const dashboardWithLoan = {
  metrics: [], net_worth_trend: [], net_worth_components: [], cash_flow_trend: [],
  cash_flow_components: [], income_breakdown: [], expense_breakdown: [],
  expense_trend_by_category: [], utility_trend: [], savings_allocation: [],
  loans: [loan], upcoming_planned_expenses: [], recent_activity: [], goals: [],
  last_successful_import: null,
}

async function stubApi(page: Page, extra: Record<string, unknown> = {}) {
  await page.route('http://127.0.0.1:4174/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const data = path in extra ? extra[path]
      : path === '/api/auth/session' ? session
      : path === '/api/household/settings' ? session.settings
        : path === '/api/household/income-sources' ? [incomeSource]
          : path === '/api/household/assets' ? [asset]
            : path === '/api/household/categories' ? []
              : path === '/api/household/utility-field-catalog' ? trackedFields
                : path === '/api/household/utilities/board' ? utilityBoard
                  : path === '/api/household/expenses/board' ? { groups: [], categories: [], monthly_totals: [] }
                    : []
    await route.fulfill({ json: data })
  })
  await page.addInitScript(() => localStorage.setItem('checkbook.session', 'layout-test'))
}

/** Shared fixture bundle for sibling scratch/spec reuse. */
export const pagesLayoutFixtures = {
  session,
  incomeSource,
  asset,
  trackedFields,
  utilityBoard,
  loan,
  dashboardWithLoan,
  stubApi,
}

test('income history drops the type legend and tucks in closer', async ({ page }) => {
  await stubApi(page, {
    // A closed role that started later than the active one: the active
    // role still leads the timeline.
    '/api/household/income-sources': [
      incomeSource,
      { ...incomeSource, id: 'source-2', name: 'Consulting', started_on: '2025-09-01', ended_on: '2026-05-31' },
    ],
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/income')
  await expect(page.locator('.income-timeline__card').first()).toBeVisible()
  await expect(page.locator('.income-timeline__legend')).toHaveCount(0)
  const entries = page.locator('.income-timeline__entry')
  await expect(entries).toHaveCount(2)
  await expect(entries.first()).toHaveClass(/is-active/)
  await expect(entries.nth(1)).not.toHaveClass(/is-active/)
  const spacing = await page.locator('.income-history-panel').evaluate((panel) => {
    const metrics = panel.previousElementSibling?.getBoundingClientRect()
    if (!metrics) return null
    return Math.round(panel.getBoundingClientRect().top - metrics.bottom)
  })
  expect(spacing).not.toBeNull()
  expect(spacing!).toBeLessThanOrEqual(18)
})

for (const width of [1440, 390]) {
  test(`property section headings include counts and right-aligned totals at ${width}px`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
    await stubApi(page, {
      '/api/household/assets': [
        asset,
        { ...asset, id: 'asset-2', name: 'Garden plot', total_cost: 100000 },
        { ...asset, id: 'vehicle-1', name: 'Family car', category: 'vehicle', total_cost: 75000 },
        { ...asset, id: 'project-1', name: 'Renovation', kind: 'project', linked_asset_id: asset.id, status: 'planned' },
      ],
      '/api/household/loans': [
        { ...loan, linked_property_id: asset.id },
        { ...loan, id: 'loan-2', linked_property_id: asset.id },
        { ...loan, id: 'loan-3', linked_property_id: 'vehicle-1' },
        { ...loan, id: 'loan-4', linked_property_id: null },
      ],
    })
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/assets')
    const panels = page.locator('.properties-page > .panel')
    await expect(panels).toHaveCount(3)
    await expect(panels.nth(2).getByRole('heading', { name: '0 Accounts', exact: true })).toBeVisible()
    await expect(panels.nth(0).getByRole('heading', { name: '2 Properties', exact: true })).toBeVisible()
    await expect(panels.nth(1).getByRole('heading', { name: '1 Vehicle', exact: true })).toBeVisible()
    await expect(panels.nth(0).getByLabel('Properties total value')).toHaveText(/PLN\s*1,000,000/)
    await expect(panels.nth(1).getByLabel('Vehicles total value')).toHaveText(/PLN\s*75,000/)
    await expect(panels.locator('.metric-grid')).toHaveCount(0)
    await expect(panels.nth(0).locator('.property-card')).toHaveCount(2)
    await expect(panels.nth(1).locator('.property-card')).toHaveCount(1)

    const cards = page.locator('.property-card')
    await expect(cards.nth(0).locator('.property-card__stats')).toHaveText('1project2loans2utilities')
    await expect(cards.nth(1).locator('.property-card__stats')).toHaveText('0projects0loans2utilities')
    await expect(cards.nth(2).locator('.property-card__stats')).toHaveText('0projects1loan')
    await expect(cards.locator('.property-card__foot')).toHaveCount(0)
    await expect(cards.getByText(/categor|in projects|No linked projects/)).toHaveCount(0)
    const statsRows = await cards.locator('.property-card__stats').evaluateAll((rows) => rows.map((row) => {
      const bounds = row.getBoundingClientRect()
      const first = row.firstElementChild!.getBoundingClientRect()
      const last = row.lastElementChild!.getBoundingClientRect()
      return { rowCenter: (bounds.left + bounds.right) / 2, countsCenter: (first.left + last.right) / 2 }
    }))
    for (const row of statsRows) expect(row.countsCenter).toBeCloseTo(row.rowCenter, 0)

    const headers = await panels.locator('.panel__header').evaluateAll((items) => items.map((header) => {
      const heading = header.querySelector('h2')!.getBoundingClientRect()
      const total = header.querySelector('.property-list-panel__total')!.getBoundingClientRect()
      const bounds = header.getBoundingClientRect()
      return { headingRight: heading.right, headingTop: heading.top, totalLeft: total.left, totalTop: total.top, totalRight: total.right, headerRight: bounds.right }
    }))
    for (const header of headers) {
      expect(Math.abs(header.headingTop - header.totalTop)).toBeLessThanOrEqual(2)
      expect(header.totalLeft).toBeGreaterThanOrEqual(header.headingRight)
      expect(header.totalRight).toBeCloseTo(header.headerRight, 0)
      expect(header.totalRight).toBeLessThanOrEqual(width)
    }
    const flush = await panels.first().evaluate((panel) => ({
      borderTop: getComputedStyle(panel).borderTopWidth,
      headerPaddingTop: getComputedStyle(panel.querySelector('.panel__header')!).paddingTop,
    }))
    expect(flush.borderTop).toBe('0px')
    expect(flush.headerPaddingTop).toBe('0px')
    expect(errors).toEqual([])
    await page.screenshot({ path: `../target/properties-headings-${width}.png`, fullPage: true })
  })
}

test('assets combines selected asset details and utilities', async ({ page }) => {
  await stubApi(page, {
    '/api/household/assets': [asset, { ...asset, id: 'asset-2', name: 'Cottage' }],
    '/api/household/loans': [{ ...loan, linked_property_id: asset.id }],
    '/api/dashboard/overview': dashboardWithLoan,
    '/api/household/utilities/form': { fields: [] },
    '/api/household/utilities/board': utilityBoard,
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.clock.setFixedTime(new Date('2026-04-15T12:00:00Z'))
  await page.goto('/assets')

  const selector = page.getByRole('button', { name: 'Asset', exact: true })
  await expect(selector).toContainText('All assets')
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Add asset, utility, or project' }).click()
  await page.getByRole('dialog').locator('.record-add-kind-toggle').click()
  await expect(page.getByRole('listbox', { name: 'Add type' }).getByRole('option')).toHaveText(['Property', 'Account'])
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await selector.click()
  const list = page.getByRole('listbox', { name: 'Asset' })
  await expect(list.getByRole('option').first()).toContainText('All assets')
  await list.getByRole('option', { name: 'Flat downtown' }).click()
  // The name lives in the header dropdown only; the body starts at the
  // summary cards, not a repeated heading.
  await expect(selector).toContainText('Flat downtown')
  await expect(page.getByRole('heading', { name: 'Flat downtown' })).toHaveCount(0)
  const summary = page.getByRole('region', { name: 'Property summary' })
  await expect(summary).toContainText('Valuation')
  await expect(summary).toContainText('Mandatory costs')
  await expect(summary).not.toContainText('Utilities only')
  await expect(summary).not.toContainText('/ month')
  await expect(page.locator('.properties-page > .panel > .panel__header').getByRole('button', { name: 'Details', exact: true })).toHaveCount(1)
  const projectsPanel = page.locator('.panel').filter({ has: page.getByRole('heading', { name: 'Projects' }) })
  await expect(projectsPanel.getByText('No projects for this property')).toBeVisible()
  const loansPanel = page.locator('.properties-page--selected > .panel').filter({ has: page.getByRole('heading', { name: 'Loans', exact: true }) })
  const utilitiesPanel = page.locator('.properties-page--selected > .subject-utilities-panel')
  await expect(utilitiesPanel).toBeVisible()
  for (const section of [utilitiesPanel, projectsPanel, loansPanel]) {
    await expect(section).toHaveCSS('border-top-width', '0px')
  }
  await expect(projectsPanel.locator('.panel__header')).toHaveCSS('padding-top', '0px')
  await expect(loansPanel.locator('.panel__header')).toHaveCSS('padding-top', '0px')
  await expect(utilitiesPanel.locator('.panel__header')).toHaveCSS('padding-top', '16.8px')
  const mandatoryValue = summary.locator('.property-summary__amount').nth(1)
  await expect(mandatoryValue).toHaveText(await page.evaluate(() => new Intl.NumberFormat(undefined, {
    style: 'currency', currency: 'PLN', minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(3470)))
  const stackGap = await page.locator('.properties-page--selected').evaluate((element) => Number.parseFloat(getComputedStyle(element).rowGap))
  expect(stackGap).toBeLessThan(24)
  const summaryBox = await summary.boundingBox()
  const utilitiesBox = await utilitiesPanel.boundingBox()
  expect(summaryBox).not.toBeNull()
  expect(utilitiesBox).not.toBeNull()
  const gapDetails = await utilitiesPanel.evaluate((element) => ({
    marginTop: getComputedStyle(element).marginTop,
    previousMarginBottom: getComputedStyle(element.previousElementSibling!).marginBottom,
    rowGap: getComputedStyle(element.parentElement!).rowGap,
  }))
  expect(utilitiesBox!.y - (summaryBox!.y + summaryBox!.height), JSON.stringify(gapDetails)).toBeLessThanOrEqual(stackGap + 1)
  await utilitiesPanel.getByRole('button', { name: 'Details', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: /^Utilities\b/ })).toBeVisible()
  await page.keyboard.press('Escape')

  const options = page.getByRole('button', { name: 'Flat downtown options' })
  await expect(options).toBeVisible()
  await options.click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem')).toHaveText(['Edit', 'Configuration', 'Notes'])
  await menu.getByRole('menuitem', { name: 'Edit' }).click()
  await expect(page.locator('.asset-detail-modal')).toBeVisible()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Add asset, utility, or project' }).click()
  const addDialog = page.getByRole('dialog')
  await expect(addDialog.getByRole('heading', { name: 'Project', exact: true })).toBeVisible()
  await addDialog.getByRole('button', { name: 'Project', exact: true }).click()
  const addTypes = addDialog.getByRole('listbox', { name: 'Add type' })
  await expect(addTypes.getByRole('option')).toHaveText(['Project', 'Utility values'])
  await addTypes.getByRole('option', { name: 'Project' }).click()
  await expect(addDialog.getByLabel('Name')).toBeVisible()
  await expect(addDialog.getByText('Links to Flat downtown')).toBeVisible()
  await page.keyboard.press('Escape')
  await options.click()
  await menu.getByRole('menuitem', { name: 'Configuration' }).click()
  await page.getByRole('button', { name: 'Utility contracts options' }).click()
  await page.getByRole('menuitem', { name: 'New utility contract' }).click()
  const utilityAddDialog = page.getByRole('dialog')
  await expect(utilityAddDialog.getByLabel('Name')).toBeVisible()
  await expect(utilityAddDialog.getByLabel('Kind')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await options.click()
    const menuBox = await menu.boundingBox()
    expect(menuBox!.x).toBeGreaterThanOrEqual(0)
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(width)
    await page.keyboard.press('Escape')
    await expect(options).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  }
  await expect(utilitiesPanel.getByRole('button', { name: 'Add utility values' })).toHaveCount(0)
  await expect(utilitiesPanel.getByRole('button', { name: /Move utilities/ })).toHaveCount(0)
  expect((await utilitiesPanel.boundingBox())!.y).toBeLessThan((await projectsPanel.boundingBox())!.y)
  await page.getByRole('button', { name: 'Add asset, utility, or project' }).click()
  await page.getByRole('dialog').locator('.record-add-kind-toggle').click()
  await page.getByRole('listbox', { name: 'Add type' }).getByRole('option', { name: 'Utility values', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')

  // The route itself is gone; stale /utilities links resolve to Overview.
  await page.route('http://127.0.0.1:4174/api/dashboard/overview', async (route) => {
    await route.fulfill({ json: dashboardWithLoan })
  })
  await page.goto('/utilities')
  await expect(page.locator('.overview-page')).toBeVisible()
})

test('loan details share the modal chrome, progress summary, and month table', async ({ page }) => {
  await stubApi(page, {
    '/api/dashboard/overview': dashboardWithLoan,
    '/api/household/loans': [loan, loanWithoutNotes],
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Home mortgage' }).click()
  const dialog = page.locator('.loan-detail-modal')
  await expect(dialog).toBeVisible()

  // Header: just the loan name, closed by the same bare x as other modals.
  await expect(dialog.getByRole('heading')).toContainText('Home mortgage')
  // Currency lives once in the title chip; table cells carry bare numbers.
  // The chip reads small, inline, and untransformed — the same seat it has
  // in the net worth, cash flow, and utilities detail headers, not a block
  // line stacking under the title.
  const currencyChip = dialog.locator('.net-worth-modal__currency')
  await expect(currencyChip).toHaveText('PLN')
  await expect(currencyChip).toHaveCSS('display', 'inline')
  await expect(currencyChip).toHaveCSS('text-transform', 'none')
  const close = dialog.getByRole('button', { name: 'Close loan details' })
  await expect(close).toHaveText('x')
  expect(await close.evaluate((element) => getComputedStyle(element).borderWidth)).toBe('0px')

  // Summary: balances above the bar; payment + rate join the dates below it,
  // both as bare numbers without a currency denotation.
  const progress = dialog.locator('.loan-progress')
  await expect(progress).toBeVisible()
  const values = progress.locator('.loan-progress__values')
  const formatAmount = (amount: number) => new Intl.NumberFormat(undefined, {
    style: 'currency', currency: 'PLN', maximumFractionDigits: 0,
  }).format(amount)
  await expect(values.getByLabel('Amount paid', { exact: true })).toHaveText(formatAmount(loan.original_balance - loan.current_balance))
  await expect(values.getByLabel('Amount left', { exact: true })).toHaveText(formatAmount(loan.current_balance))
  await expect(values.getByLabel('Total loan amount', { exact: true })).toContainText(formatAmount(loan.original_balance))
  // The schedule's total interest (forecasts included) rides after the amount
  // as a bare number — the amount beside it already carries the currency.
  const totalInterest = paymentSchedule.reduce((sum, row) => sum + row.interest, 0)
  await expect(progress.locator('.loan-progress__interest')).toHaveText(
    `+ ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(totalInterest)}`,
  )
  await expect(progress.locator('.loan-progress__track')).toHaveAttribute('aria-valuenow', '33')
  // The fixed formula payment (3,200, not the planned 3,400) carries the
  // up-arrow and no currency: only the balances above the bar carry it.
  const payment = progress.locator('.loan-progress__payment')
  await expect(payment.locator('svg')).toHaveCount(1)
  await expect(payment).toHaveText(
    `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(loan.details.fixed_monthly_payment)} / mo`,
  )
  await expect(progress).toContainText(`${(loan.interest_rate * 100).toFixed(2)}%`)

  // No placeholder values: absent end_date falls back to the calculated
  // payoff month (now + 6 projected months), never "Not set" or "-".
  const now = new Date()
  const calculatedEnd = new Date(now.getFullYear(), now.getMonth() + 6, 1)
    .toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
  const dates = progress.locator('.loan-progress__dates > span')
  await expect(dates).toHaveCount(3)
  await expect(dates.last()).toHaveText(calculatedEnd)
  // The payment and rate figures sit below the bar with the dates.
  const [trackBox, metaBox] = await Promise.all([
    progress.locator('.loan-progress__track').boundingBox(),
    progress.locator('.loan-progress__meta').boundingBox(),
  ])
  expect(metaBox!.y).toBeGreaterThanOrEqual(trackBox!.y + trackBox!.height - 1)
  await expect(dialog.locator('.loan-summary-panel')).not.toContainText('Not set')
  // The imported period count survives as its own row.
  await expect(dialog.locator('.detail-row', { hasText: 'Periods' })).toContainText('360')

  // Notes collapse into their own card below the chart, collapsed by default.
  const notesCard = dialog.locator('.loan-notes-card')
  await expect(notesCard).toBeVisible()
  const notesToggle = notesCard.getByRole('button', { name: 'Notes' })
  await expect(notesToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(notesCard.locator('.loan-notes-card__body')).toBeHidden()
  const [graphBox, notesBox] = await Promise.all([
    page.locator('.loan-summary-graph').boundingBox(),
    notesCard.boundingBox(),
  ])
  expect(graphBox).not.toBeNull()
  expect(notesBox).not.toBeNull()
  expect(notesBox!.y).toBeGreaterThanOrEqual(graphBox!.y + graphBox!.height - 1)
  await notesToggle.click()
  await expect(notesToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(notesCard.locator('.loan-notes-card__body')).toBeVisible()
  await expect(notesCard).toContainText('Refinanced in 2022')

  // Include projected months when checking the full schedule layout.
  const loanActions = dialog.getByRole('button', { name: 'Loan actions' })
  // Unified table-modal header: options far left, then the title with its
  // currency, then the close — one row, nothing wrapping.
  const loanHeaderOrder = await dialog.locator('.drive-picker__header').evaluate((element) => {
    const pick = (selector: string) => {
      const box = element.querySelector(selector)!.getBoundingClientRect()
      return { left: box.left, right: box.right, centerY: (box.top + box.bottom) / 2 }
    }
    return {
      options: pick('.nw-options__trigger'),
      title: pick('h2'),
      currency: pick('.net-worth-modal__currency'),
      close: pick('.nw-close'),
      overflow: element.scrollWidth - element.clientWidth,
    }
  })
  expect(loanHeaderOrder.options.right).toBeLessThanOrEqual(loanHeaderOrder.title.left + 1)
  expect(loanHeaderOrder.currency.right).toBeGreaterThan(loanHeaderOrder.title.left)
  expect(loanHeaderOrder.close.left).toBeGreaterThanOrEqual(loanHeaderOrder.currency.right)
  for (const control of [loanHeaderOrder.title, loanHeaderOrder.close]) {
    expect(Math.abs(control.centerY - loanHeaderOrder.options.centerY)).toBeLessThanOrEqual(3)
  }
  expect(loanHeaderOrder.overflow).toBeLessThanOrEqual(1)
  await expect(dialog.getByRole('switch', { name: 'Forecast' })).toHaveCount(0)
  await expect(dialog.getByText('Forecast', { exact: true })).toHaveCount(0)
  await loanActions.click()
  // Forecast is on by default, so the full schedule is already visible.
  const forecast = dialog.getByRole('menuitemcheckbox', { name: 'Forecast', exact: true })
  await expect(forecast).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(dialog.getByRole('menu')).toHaveCount(0)
  await expect(loanActions).toBeFocused()
  // Table: the shared month table with year dividers and bare month numbers.
  await dialog.getByRole('tab', { name: 'Table' }).click()
  const table = dialog.locator('.loan-schedule-table')
  await expect(table).toBeVisible()
  await expect(table).not.toContainText('PLN')
  await expect(table.locator('.net-worth-table__year-row')).toHaveCount(4)
  await expect(table.locator('thead th')).toHaveText(['M', 'Payment', 'Interest', 'Principal', 'Extra principal', 'Balance'])
  await expect(table.locator('tbody tr').nth(1).locator('th')).toHaveText('1')
  await expect(table.locator('.loan-schedule-table__row').last().locator('th')).toHaveText('1')
  // The add-row affordance closes the table as its own final row.
  await expect(table.locator('.loan-schedule-table__add-row')).toContainText('Add row')
  await expect(table.locator('.loan-schedule-table__add-row > td')).toHaveAttribute('colspan', '6')

  // The table spans exactly the tab selector's row: shared left edge, and
  // the right edge stops at the modal padding instead of scrolling past it.
  const [tabsBox, shellBox, dialogBox] = await Promise.all([
    page.locator('.loan-detail-tabs').boundingBox(),
    page.locator('.loan-detail-modal .net-worth-table-shell').boundingBox(),
    dialog.boundingBox(),
  ])
  expect(tabsBox).not.toBeNull()
  expect(shellBox).not.toBeNull()
  expect(dialogBox).not.toBeNull()
  expect(Math.abs(shellBox!.x - tabsBox!.x)).toBeLessThanOrEqual(1)
  expect(dialogBox!.x + dialogBox!.width - (shellBox!.x + shellBox!.width)).toBeLessThanOrEqual(18)

  // The modal spans to the bottom of the viewport and only the table shell
  // scrolls — the modal itself never becomes the scroll container.
  expect(dialogBox!.y + dialogBox!.height).toBeGreaterThanOrEqual(880)
  const desktopScroll = await dialog.evaluate((root) => {
    const shell = root.querySelector('.net-worth-table-shell')
    return {
      modalScrolls: root.scrollHeight > root.clientHeight + 1,
      shellScrolls: shell ? shell.scrollHeight > shell.clientHeight + 1 : false,
    }
  })
  expect(desktopScroll.modalScrolls).toBe(false)
  expect(desktopScroll.shellScrolls).toBe(true)

  // Narrow screens: the schedule table fits the tab selector's row exactly —
  // shared left and right edges, no horizontal scroll — while the modal stays
  // pinned and only the shell scrolls vertically.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(table).toBeVisible()
  const mobileScroll = await dialog.evaluate((root) => {
    const shell = root.querySelector('.net-worth-table-shell')
    const tabs = root.querySelector('.loan-detail-tabs')
    const shellBox = shell?.getBoundingClientRect()
    const tabsBox = tabs?.getBoundingClientRect()
    return {
      modalScrolls: root.scrollHeight > root.clientHeight + 1,
      shellScrolls: shell ? shell.scrollHeight > shell.clientHeight + 1 : false,
      shellScrollsX: shell ? shell.scrollWidth > shell.clientWidth + 1 : false,
      shellLeft: shellBox ? shellBox.left : null,
      shellRight: shellBox ? shellBox.right : null,
      tabsLeft: tabsBox ? tabsBox.left : null,
      tabsRight: tabsBox ? tabsBox.right : null,
    }
  })
  expect(mobileScroll.modalScrolls).toBe(false)
  expect(mobileScroll.shellScrolls).toBe(true)
  expect(mobileScroll.shellScrollsX).toBe(false)
  expect(Math.abs(mobileScroll.shellLeft! - mobileScroll.tabsLeft!)).toBeLessThanOrEqual(1)
  expect(Math.abs(mobileScroll.shellRight! - mobileScroll.tabsRight!)).toBeLessThanOrEqual(1)

  // Scrolling pins the year divider under the header: the floating strip
  // aligns with the table's content box and mirrors the in-flow divider
  // pixel-for-pixel — same edges, same height, no border overpaint, no
  // sideways label jump when the pin takes over.
  await page.evaluate(() => {
    const shell = document.querySelector('.loan-detail-modal .net-worth-table-shell') as HTMLElement
    shell.scrollTop = 400
    shell.dispatchEvent(new Event('scroll'))
  })
  const pinned = await page.evaluate(() => {
    const shell = document.querySelector('.loan-detail-modal .net-worth-table-shell') as HTMLElement
    const indicator = shell.parentElement!.querySelector('.net-worth-table__year-sticky') as HTMLElement
    const strip = indicator.getBoundingClientRect()
    const label = indicator.querySelector('.net-worth-table__year-label')!.getBoundingClientRect()
    const shellBox = shell.getBoundingClientRect()
    const scs = getComputedStyle(shell)
    const row = shell.querySelector('tr.net-worth-table__year-row') as HTMLElement
    const rowLabel = row.querySelector('.net-worth-table__year-label')!.getBoundingClientRect()
    return {
      display: getComputedStyle(indicator).display,
      stripLeft: strip.left,
      stripRight: strip.right,
      contentLeft: shellBox.left + parseFloat(scs.borderLeftWidth),
      contentRight: shellBox.right - parseFloat(scs.borderRightWidth),
      stripHeight: strip.height,
      rowHeight: row.getBoundingClientRect().height,
      labelLeft: label.left,
      rowLabelLeft: rowLabel.left,
    }
  })
  expect(pinned.display).toBe('block')
  expect(Math.abs(pinned.stripLeft - pinned.contentLeft)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(pinned.stripRight - pinned.contentRight)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(pinned.stripHeight - pinned.rowHeight)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(pinned.labelLeft - pinned.rowLabelLeft)).toBeLessThanOrEqual(0.5)

  // Summary stays a full-page modal, and the graph card keeps a constant
  // height: the stage sizes to the chart's aspect ratio and the legend sits
  // right under the plot instead of a viewport-scaled card with gaps.
  await dialog.getByRole('tab', { name: 'Summary' }).click()
  const summaryBox = await dialog.boundingBox()
  expect(summaryBox).not.toBeNull()
  expect(summaryBox!.y).toBeLessThanOrEqual(1)
  expect(summaryBox!.y + summaryBox!.height).toBeGreaterThanOrEqual(843)
  const graph = await page.locator('.loan-summary-graph').evaluate((card) => {
    const stage = card.querySelector('.chart-stage')
    const legend = card.querySelector('.loan-payoff-chart__legend')
    const cardBox = card.getBoundingClientRect()
    const stageBox = stage?.getBoundingClientRect()
    const legendBox = legend?.getBoundingClientRect()
    return {
      cardHeight: cardBox.height,
      gapAboveStage: stageBox ? stageBox.top - cardBox.top : null,
      gapStageToLegend: stageBox && legendBox ? legendBox.top - stageBox.bottom : null,
    }
  })
  expect(graph.cardHeight).toBeLessThan(352)
  expect(graph.gapAboveStage!).toBeLessThanOrEqual(14)
  expect(graph.gapStageToLegend!).toBeLessThanOrEqual(13)
  const progressBox = await progress.boundingBox()
  expect(progressBox).not.toBeNull()
  expect(progressBox!.x).toBeGreaterThanOrEqual(0)
  expect(progressBox!.x + progressBox!.width).toBeLessThanOrEqual(390)

  // A loan without notes renders no notes card at all.
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'Car loan' }).click()
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.loan-notes-card')).toHaveCount(0)

  // Loan details keep their full-page seat on phones (unlike property
  // details, which must hug its rows).
  await page.setViewportSize({ width: 390, height: 844 })
  const mobileSeat = await dialog.evaluate((root) => {
    const box = root.getBoundingClientRect()
    return { top: box.top, bottom: box.bottom, radius: getComputedStyle(root).borderRadius }
  })
  expect(mobileSeat.top).toBeLessThanOrEqual(1)
  expect(mobileSeat.bottom).toBeGreaterThanOrEqual(843)
  expect(mobileSeat.radius).toBe('0px')
})

test('overview desktop cards have no separators and single-card rows stay left aligned', async ({ page }) => {
  const errors: string[] = []
  const failedRequests: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('response', (response) => { if (response.status() >= 400) failedRequests.push(response.url()) })
  page.on('requestfailed', (request) => failedRequests.push(request.url()))
  await stubApi(page, {
    '/api/dashboard/overview': { ...dashboardWithLoan, utility_trend: [{ period: '2026-01', total: 200, values: { Electricity: 200 }, usage: {}, units: {} }] },
    '/api/household/loans': [loan],
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Expense mix', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Utilities', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Utility chart metric' })).toHaveCount(0)
  for (const width of [1101, 1440, 2560]) {
    await page.setViewportSize({ width, height: 900 })
    const panels = await page.locator('.overview-page > .grid > .panel').evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return {
        width: box.width, left: box.left, top: box.top,
        parentLeft: element.parentElement!.getBoundingClientRect().left,
        borderTop: style.borderTopWidth, borderLeft: style.borderLeftWidth,
        paddingLeft: style.paddingLeft,
      }
    }))
    expect(panels).toHaveLength(7)
    for (const panel of panels) {
      expect(panel.width).toBeCloseTo(panels[0].width, 0)
      expect(panel.width).toBeLessThanOrEqual(640)
      expect(panel.borderTop).toBe('0px')
      expect(panel.borderLeft).toBe('0px')
      expect(panel.paddingLeft).toBe('0px')
    }
    expect(panels[0].top).toBeCloseTo(panels[1].top, 0)
    expect(panels[1].left).toBeGreaterThan(panels[0].left)
    expect(panels[2].left).toBeCloseTo(panels[2].parentLeft, 0)
    expect(panels[2].left).toBeCloseTo(panels[0].left, 0)
    if (width === 2560) expect(panels[0].width).toBe(640)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: 'test-results/overview-desktop.png', fullPage: true })

  for (const width of [320, 390, 1100]) {
    await page.setViewportSize({ width, height: 900 })
    const panels = await page.locator('.overview-page > .grid > .panel').evaluateAll((elements) => elements.map((element) => {
      const box = element.getBoundingClientRect()
      return { width: box.width, left: box.left, top: box.top, bottom: box.bottom, parentWidth: element.parentElement!.getBoundingClientRect().width }
    }))
    for (const [index, panel] of panels.entries()) {
      expect(panel.width).toBeCloseTo(panel.parentWidth, 0)
      expect(panel.left).toBeCloseTo(panels[0].left, 0)
      if (index > 0) expect(panel.top).toBeGreaterThanOrEqual(panels[index - 1].bottom)
    }
    await expect(page.locator('.overview-page > .grid').first().locator('.panel').nth(1)).toHaveCSS('border-top-width', '1px')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: 'test-results/overview-mobile.png', fullPage: true })
  expect(errors).toEqual([])
  expect(failedRequests).toEqual([])
})

test('property notes use a compact popup and Edit opens directly', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await stubApi(page, {
    '/api/household/assets': [{ ...asset, notes: 'Roof warranty expires in 2030', linked_category_ids: ['maintenance'], linked_expense_total: 450 }],
    '/api/household/categories': [{ id: 'maintenance', name: 'Property maintenance', kind: 'expense' }],
    '/api/household/assets/asset-1/valuations': [{ id: 'v1', value: 850000, effective_date: '2025-06-01' }],
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/assets')
  await page.locator('.property-card').first().click()
  await expect(page.getByRole('heading', { name: 'Property information' })).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Flat downtown options' }).click()
  await page.getByRole('menuitem', { name: 'Notes', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Notes', exact: true })).toContainText('Roof warranty expires in 2030')
  await page.keyboard.press('Escape')
  const summary = page.getByRole('region', { name: 'Property summary' })
  await expect(summary.getByText('How this is calculated')).toHaveCount(0)
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 })
    const items = await summary.locator('.property-summary__item').evaluateAll((nodes) => nodes.map((node) => {
      const box = node.getBoundingClientRect()
      return { top: box.top, right: box.right, left: box.left }
    }))
    expect(items[0].top).toBe(items[1].top)
    expect(Math.abs(items[1].left - items[0].right)).toBeLessThanOrEqual(1)
    expect(items[1].right).toBeLessThanOrEqual(width)
    await expect(summary).toHaveCSS('border-top-width', '1px')
    await expect(summary.locator('.property-summary__item + .property-summary__item')).toHaveCSS('border-left-width', '1px')
    // The valuation info trigger and its popup are gone: the label stands alone.
    await expect(summary.getByRole('button', { name: 'Valuation details' })).toHaveCount(0)
  }
  await page.screenshot({ path: 'test-results/property-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Flat downtown options' }).click()
  await page.screenshot({ path: 'test-results/property-mobile.png', fullPage: true })
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
  await page.getByRole('button', { name: 'Flat downtown options' }).click()
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
  const dialog = page.locator('.asset-detail-modal')
  await expect(dialog.getByRole('heading', { name: 'Edit property' })).toBeVisible()
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Flat downtown')
  await expect(dialog.getByRole('button', { name: 'Save property', exact: true })).toBeVisible()
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    expect(await dialog.boundingBox()).toEqual({ x: 0, y: 0, ...viewport })
    const kind = await dialog.getByLabel('Kind', { exact: true }).boundingBox()
    const name = await dialog.getByLabel('Name', { exact: true }).boundingBox()
    const from = await dialog.getByLabel('From', { exact: true }).boundingBox()
    expect(kind!.y).toBeGreaterThanOrEqual(name!.y + name!.height)
    expect(from!.y).toBeGreaterThanOrEqual(kind!.y + kind!.height)
    const projects = dialog.locator('.property-edit-section--projects')
    await projects.getByRole('button', { name: 'Link project', exact: true }).scrollIntoViewIfNeeded()
    const box = await projects.boundingBox()
    const link = await projects.getByRole('button', { name: 'Link project', exact: true }).boundingBox()
    expect(link!.y + link!.height).toBeLessThanOrEqual(box!.y + box!.height)
  }
  const header = dialog.locator('.drive-picker__header')
  await expect(header.getByRole('button')).toHaveCount(2)
  await expect(header.getByRole('button', { name: 'Cancel editing property' })).toHaveCount(0)
  await expect(header.getByRole('button', { name: 'Close property details' })).toHaveCount(0)
  await expect(header.getByRole('button', { name: 'Save property' })).toHaveCSS('border-width', '0px')
  await header.getByRole('button', { name: 'Property actions' }).click()
  await expect(header.getByRole('menuitem')).toHaveText(['Delete'])
  await header.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Property information' })).toHaveCount(0)
})

for (const hasOwnBreakdown of [false, true]) {
  test(`property information omits project breakdowns with own breakdown ${hasOwnBreakdown}`, async ({ page }) => {
    const room = (name: string, itemName: string) => ({
      name, total: 100, sections: [{ name: `${name} section`, total: 100, items: [{ name: itemName, total_cost: 100 }] }],
    })
    const property = { ...asset, details: { rooms: hasOwnBreakdown ? [room('Property inventory', 'Owned fixture')] : [] } }
    const project = {
      ...asset, id: 'project-1', name: 'Kitchen renovation', kind: 'project', linked_asset_id: asset.id,
      started_on: '2026-01-01', ended_on: '2026-06-01',
      details: { linked_asset_id: asset.id, linked_section_path: '0', rooms: [room('Project inventory', 'Project-only cabinet')] },
    }
    await stubApi(page, { '/api/household/assets': [property, project] })
    await page.goto('/assets')
    await page.locator('.property-card').first().click()
    await expect(page.locator('.property-information-panel')).toHaveCount(0)
    await expect(page.getByText('No dates yet')).toHaveCount(0)
    const projects = page.locator('.panel').filter({ has: page.getByRole('heading', { name: 'Projects', exact: true }) })
    await expect(projects.getByRole('button', { name: /Kitchen renovation/ }).first()).toBeVisible()
    await projects.getByRole('button', { name: /Kitchen renovation/ }).first().click()
    await expect(page.getByRole('dialog')).toBeVisible()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Project inventory', { exact: false }).first()).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Close project details' })).toHaveCSS('border-width', '0px')
    expect(await dialog.evaluate((node) => getComputedStyle(node, '::-webkit-scrollbar-track').backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    await dialog.getByRole('button', { name: 'Project actions' }).click()
    await expect(dialog.getByRole('menuitem', { name: 'Edit', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Project actions' }).click()
    await dialog.getByRole('menuitem', { name: 'Edit', exact: true }).click()
    await expect(dialog.getByRole('button', { name: 'Save project' })).toBeVisible()
  })
}

for (const width of [320, 390, 1280]) {
  test(`project categories contain groups and pricing shares a row at ${width}px`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    const failedRequests: string[] = []
    page.on('response', (response) => { if (response.status() >= 400) failedRequests.push(response.url()) })
    const project = {
      ...asset, id: 'project-layout', name: 'Kitchen renovation', kind: 'project', linked_asset_id: asset.id,
      details: { linked_section_path: '0', rooms: [
        { name: 'Kitchen', sections: [
          { name: 'Cabinets', items: [{ name: 'Shelving with a long descriptive name', quantity: 4, unit_price: 2500, completed: false }] },
          { name: 'Lighting', items: [{ name: 'Pendant', total_cost: 100, completed: false }] },
        ] },
        { name: 'Bathroom', sections: [{ name: 'Fixtures', items: [{ name: 'Sink', total_cost: 300, completed: false }] }] },
      ] },
    }
    await stubApi(page, { '/api/household/assets': [asset, project] })
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/assets')
    await page.locator('.property-card').first().click()
    await page.getByRole('button', { name: /Kitchen renovation/ }).first().click()
    const dialog = page.getByRole('dialog')
    const kitchen = dialog.getByRole('region', { name: 'Kitchen', exact: true })
    await expect(dialog.locator('.project-room')).toHaveCount(2)
    await expect(kitchen.locator('.project-group')).toHaveCount(2)
    await expect(kitchen.getByRole('button', { name: /Fixtures/ })).toHaveCount(0)
    await expect(dialog.locator('.project-hero-link-slot, .project-link-chip')).toHaveCount(0)
    await expect(kitchen).toHaveCSS('border-top-width', '1px')
    await kitchen.getByRole('button', { name: /Cabinets/ }).click()
    await kitchen.getByRole('button', { name: /Lighting/ }).click()
    const calculatedItem = kitchen.locator('.project-item').first()
    const calculation = await calculatedItem.locator('.project-item__calculation').boundingBox()
    const total = await calculatedItem.locator('.project-item__total').boundingBox()
    expect(calculation).not.toBeNull()
    expect(total).not.toBeNull()
    expect(Math.abs(calculation!.y + calculation!.height - total!.y - total!.height)).toBeLessThan(4)
    expect(calculation!.x + calculation!.width).toBeLessThanOrEqual(total!.x)
    for (const pricing of await kitchen.locator('.project-item__pricing').all()) {
      const box = await pricing.boundingBox()
      const item = await pricing.locator('..').boundingBox()
      expect(box!.x + box!.width).toBeLessThanOrEqual(item!.x + item!.width)
      const amount = await pricing.locator('.project-item__total').boundingBox()
      expect(Math.abs(box!.x + box!.width - amount!.x - amount!.width)).toBeLessThan(1)
    }
    if (width < 540) {
      const title = await calculatedItem.locator('.project-item__title').boundingBox()
      expect(calculation!.y).toBeGreaterThanOrEqual(title!.y + title!.height)
    }
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
    await page.screenshot({ path: `test-results/project-grouping-${width}.png`, fullPage: true })
    expect(errors).toEqual([])
    expect(failedRequests).toEqual([])
  })
}

for (const width of [390, 1280]) {
  test(`utility value entry scrolls and has one close control at ${width}px`, async ({ page }) => {
    const fields = Array.from({ length: 12 }, (_, index) => ({
      key: `meter-${index}`, label: `Meter ${index}`, kind: 'metered', unit: 'kWh',
      amount: null, meter_reading: null, previous_amount: 100, previous_meter_reading: 200,
    }))
    await stubApi(page, { '/api/household/utilities/form': { fields } })
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/assets')
    await page.locator('.property-card').first().click()
    await page.getByRole('button', { name: 'Add asset, utility, or project' }).click()
    await page.getByRole('dialog').locator('.record-add-kind-toggle').click()
    await page.getByRole('option', { name: 'Utility values', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Utility values' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toHaveCount(1)
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0)
    // The sheet scrolls as one on phones; desktop keeps the inner body as
    // the scroller around the pinned footer.
    const body = dialog.locator(width < 768 ? '.utility-values-form' : '.utility-values-form__body')
    await dialog.getByRole('button', { name: 'Edit Meter 11', exact: true }).click()
    await expect(dialog.getByLabel('Meter 11 meter reading', { exact: true })).toBeAttached()
    expect(await body.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true)
    await dialog.getByLabel('Meter 11 meter reading', { exact: true }).scrollIntoViewIfNeeded()
    expect(await body.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
    await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeInViewport()
    const box = await dialog.boundingBox()
    expect(box!.width).toBeLessThanOrEqual(width)
    const footer = await dialog.locator('.utility-values-form__footer').boundingBox()
    const border = await dialog.evaluate((node) => parseFloat(getComputedStyle(node).borderBottomWidth))
    expect(footer!.y + footer!.height).toBeCloseTo(box!.y + box!.height - border, 0)
    const amount = await dialog.getByLabel('Meter 11 amount', { exact: true }).boundingBox()
    const meter = await dialog.getByLabel('Meter 11 meter reading', { exact: true }).boundingBox()
    expect(amount!.y).toBeCloseTo(meter!.y, 0)
    expect(meter!.x).toBeGreaterThan(amount!.x)
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
    if (width < 768) {
      await expect
        .poll(() => dialog.evaluate((node) => getComputedStyle(node).transform))
        .toBe('none')
      await page.screenshot({ path: 'test-results/utility-sheet-mobile.png' })
    }
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`loan editing links and unlinks a property at ${viewport.width}px`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('requestfailed', (request) => errors.push(`${request.method()} ${request.url()}`))
    await stubApi(page, { '/api/dashboard/overview': dashboardWithLoan })
    let currentLoan = { ...loan }
    await page.route('http://127.0.0.1:4174/api/household/loans', (route) => route.fulfill({ json: [currentLoan] }))
    await page.route('http://127.0.0.1:4174/api/household/loans/loan-1', async (route) => {
      expect(route.request().method()).toBe('PUT')
      const payload = route.request().postDataJSON()
      expect(payload).not.toHaveProperty('current_balance')
      expect(payload).not.toHaveProperty('monthly_payment')
      currentLoan = { ...currentLoan, ...payload }
      await route.fulfill({ json: currentLoan })
    })
    await page.setViewportSize(viewport)
    await page.goto('/')
    const editLoan = async () => {
      await page.getByRole('button', { name: 'Home mortgage', exact: true }).click()
      const dialog = page.locator('.loan-detail-modal')
      await dialog.getByRole('button', { name: 'Loan actions' }).focus()
      await page.keyboard.press('ArrowDown')
      await expect(dialog.getByRole('menuitem', { name: 'Edit', exact: true })).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(dialog.getByRole('button', { name: 'Loan actions' })).toBeFocused()
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: 'Loan actions' }).click()
      await dialog.getByRole('menuitem', { name: 'Edit', exact: true }).click()
      return dialog
    }
    const dialog = await editLoan()
    await dialog.getByLabel('Linked property').selectOption(asset.id)
    await expect(dialog.getByRole('form', { name: 'Edit loan' })).toBeVisible()
    await expect(dialog.getByLabel('Current balance', { exact: true })).toHaveCount(0)
    await expect(dialog.getByLabel('Monthly payment', { exact: true })).toHaveCount(0)
    const overflow = await dialog.evaluate((node) => node.scrollWidth > node.clientWidth)
    expect(overflow).toBe(false)
    await page.screenshot({ path: `test-results/loan-edit-${viewport.width}.png`, fullPage: true })
    await dialog.getByRole('button', { name: 'Save loan' }).click()
    await expect(dialog.getByRole('form', { name: 'Edit loan' })).toHaveCount(0)
    expect(currentLoan.linked_property_id).toBe(asset.id)
    await dialog.getByRole('button', { name: 'Close loan details' }).click()
    await page.goto('/assets')
    await page.locator('.property-card').first().click()
    await expect(page.getByRole('heading', { name: 'Loans', exact: true })).toBeVisible()
    const loanCard = page.getByRole('button', { name: 'Home mortgage', exact: true })
    await expect(loanCard).toBeVisible()
    const projectsHeading = page.getByRole('heading', { name: 'No projects for this property' })
    expect(await projectsHeading.evaluate((heading) => Boolean(heading.compareDocumentPosition(document.querySelector('.property-loans')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true)
    await expect(loanCard).toHaveAttribute('aria-haspopup', 'dialog')
    await page.screenshot({ path: `test-results/property-loan-${viewport.width}.png`, fullPage: true })
    await loanCard.focus()
    await page.keyboard.press('Enter')
    const propertyLoanDialog = page.locator('.loan-detail-modal')
    await expect(propertyLoanDialog).toBeVisible()
    await expect(propertyLoanDialog.getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-selected', 'true')
    expect(await propertyLoanDialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
    await page.screenshot({ path: `test-results/property-loan-dialog-${viewport.width}.png`, fullPage: true })
    await page.keyboard.press('Escape')
    await expect(propertyLoanDialog).toHaveCount(0)
    await expect(loanCard).toBeFocused()
    await page.goto('/')
    const unlinkDialog = await editLoan()
    await unlinkDialog.getByLabel('Linked property').selectOption('')
    await unlinkDialog.getByRole('button', { name: 'Save loan' }).click()
    await expect(unlinkDialog.getByRole('form', { name: 'Edit loan' })).toHaveCount(0)
    expect(currentLoan.linked_property_id).toBeNull()
    await page.goto('/assets')
    await page.locator('.property-card').first().click()
    await expect(page.getByRole('heading', { name: 'Loans', exact: true })).toHaveCount(0)
    expect(errors).toEqual([])
  })
}

test('mobile property and project add footers stay at bottom', async ({ page }) => {
  await stubApi(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/assets')
  const add = page.getByRole('button', { name: 'Add asset, utility, or project' })
  expect((await add.boundingBox())!.x).toBeGreaterThan(195)
  await add.click()
  const checkFooter = async () => {
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0)
    // Wait out the sheet's rise-from-bottom entrance before measuring.
    await expect
      .poll(() => dialog.evaluate((node) => getComputedStyle(node).transform))
      .toBe('none')
    const footer = await dialog.locator('.quick-add-actions').boundingBox()
    expect(footer!.y + footer!.height).toBeCloseTo(844, 0)
    const save = await dialog.getByRole('button', { name: 'Save', exact: true }).boundingBox()
    expect(save!.height).toBeLessThanOrEqual(36)
  }
  await checkFooter()
  await page.keyboard.press('Escape')
  await page.locator('.property-card').first().click()
  await add.click()
  await expect(page.getByRole('dialog', { name: 'Project', exact: true })).toBeVisible()
  await checkFooter()
})
