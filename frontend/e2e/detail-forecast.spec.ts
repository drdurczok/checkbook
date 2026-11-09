import { expect, test, type Locator, type Page } from '@playwright/test'

const session = {
  token: 'detail-forecast-test', expires_at: '2099-01-01T00:00:00Z',
  user: { id: 'u', email: 'test@example.com', full_name: 'Tester', picture_url: '' },
  household: { id: 'h', name: 'Forecast tests', base_currency: 'PLN', timezone: 'Europe/Warsaw' },
  membership: { id: 'm', role: 'owner', relationship_kind: 'owner' },
  settings: { id: 's', privacy_mode: 'household', allow_cross_member_visibility: true, projection_baseline_window_months: 12, projection_horizon_months: 24, savings_allocation_strategy: 'default', role_permissions: {} },
}
const property = {
  id: 'asset-1', name: 'Flat downtown', total_cost: 900000, original_total_cost: 950000,
  valuation_date: '2026-01-01', status: 'active', started_on: '2020-03-01', ended_on: null,
  notes: '', item_count: 0, completed_item_count: 0, completed_cost: 0, completion_percent: 0,
  kind: 'asset', category: 'property', depreciation_rate: -0.01, depreciation_enabled: true,
  utilities_enabled: false, projects_enabled: false, expenses_enabled: false,
}
const payments = [
  { id: 'payment-1', completed: true, date: '2026-01-05', payment: 3400, principal: 1600, interest: 1800, outstanding_loan_balance: 600000, projected: false },
  { id: 'payment-2', completed: true, date: '2026-02-05', payment: 3400, principal: 1700, interest: 1700, outstanding_loan_balance: 598300, projected: false },
  { id: 'payment-3', completed: false, date: '2026-03-05', payment: 3400, principal: 1800, interest: 1600, outstanding_loan_balance: 596500, projected: true },
  { id: 'payment-4', completed: false, date: '2026-04-05', payment: 3400, principal: 1900, interest: 1500, outstanding_loan_balance: 594600, projected: true },
]
const loan = {
  id: 'loan-1', name: 'Home mortgage', current_balance: 600000, monthly_payment: 3400,
  interest_rate: 0.0345, original_balance: 900000, start_date: '2020-03-01', end_date: null,
  notes: '', projected_payoff_months: 6, interest_remaining: null, linked_property_id: null,
  details: { fixed_monthly_payment: 3200, period_count: 360, payment_schedule: payments },
}
const dashboard = {
  metrics: [], net_worth_trend: [], net_worth_components: [], cash_flow_trend: [],
  cash_flow_components: [], income_breakdown: [], expense_breakdown: [],
  expense_trend_by_category: [], utility_trend: [], savings_allocation: [], loans: [loan],
  upcoming_planned_expenses: [], recent_activity: [], goals: [], last_successful_import: null,
}

export async function stubApi(page: Page) {
  let currentLoan = structuredClone({ ...loan, linked_property_id: property.id })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('requestfailed', (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`))
  page.on('response', (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
  await page.route('http://127.0.0.1:4174/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/household/loans/loan-1' && route.request().method() === 'PUT') {
      const payload = route.request().postDataJSON()
      currentLoan = { ...currentLoan, ...payload, details: { ...currentLoan.details, payment_schedule: payload.payment_schedule } }
      await route.fulfill({ json: currentLoan })
      return
    }
    const data = path === '/api/auth/session' ? session
      : path === '/api/household/settings' ? session.settings
        : path === '/api/household/assets' ? [property]
          : path === '/api/household/loans' ? [currentLoan]
            : path === '/api/dashboard/overview' ? { ...dashboard, loans: [currentLoan] }
              : path === '/api/household/assets/asset-1/valuations' ? [{ id: 'value-1', value: 925000, effective_date: '2026-02-01' }]
                : path === '/api/household/expenses/board' ? { groups: [], categories: [], monthly_totals: [] }
                  : path === '/api/household/utilities/board' ? {
                    subject: { id: property.id, kind: 'property', name: property.name, group_type: 'flat', started_on: null, ended_on: null, notes: '', tracked_fields: [] },
                    trend: [], months: [],
                  }
                    : []
    await route.fulfill({ json: data })
  })
  await page.addInitScript(() => localStorage.setItem('checkbook.session', 'detail-forecast-test'))
  await page.clock.setFixedTime(new Date('2026-02-15T12:00:00Z'))
  return errors
}

async function expectNoOverflow(page: Page, surface: Locator, control?: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const surfaceWidth = await surface.evaluate((node) => ({ scroll: node.scrollWidth, client: node.clientWidth }))
  expect(surfaceWidth.scroll).toBeLessThanOrEqual(surfaceWidth.client + 1)
  if (!control) return
  await expect(control).toBeVisible()
  const box = await control.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
}

for (const width of [390, 1280]) {
  test(`net worth adds and selects months at ${width}px`, async ({ page }, testInfo) => {
    const errors = await stubApi(page)
    const previousMonth = {
      period: '2026-01', completed: true, total: 723,
      investing: { total: 0, components: {} },
      savings: { total: 123, components: { 'Emergency fund': 123 } },
      non_liquid_assets: { total: 1000, components: {}, automatic_components: { Home: 1000 } },
      debt: { total: 400, components: {}, automatic_components: { Mortgage: 400 } },
    }
    await page.route('**/api/dashboard/overview*', async (route) => {
      await route.fulfill({ json: { ...dashboard, net_worth_components: [previousMonth] } })
    })
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    await page.getByRole('button', { name: 'Details', exact: true }).first().click()
    await page.getByRole('button', { name: 'Table options' }).click()
    await page.getByRole('menuitem', { name: 'Add month' }).click()
    const editor = page.locator('.net-worth-editor')
    await expect(editor.getByRole('button', { name: 'Change month, 2026-02' })).toBeVisible()
    // The new month inherits January's subgroups and pulls the automatic
    // debt and fixed-asset values forward.
    await expect(editor.getByLabel('Savings subgroup')).toHaveValue('Emergency fund')
    await expect(editor.getByLabel('Savings value')).toHaveValue('123')
    await expect(editor.getByLabel('Home automatic value')).toHaveText('1,000')
    await expect(editor.getByLabel('Mortgage automatic value')).toHaveText('400')
    await editor.getByRole('button', { name: 'Change month, 2026-02' }).click()
    await editor.getByLabel('Net worth month', { exact: true }).fill('2027-01')
    await expect(editor.getByRole('button', { name: 'Change month, 2027-01' })).toBeVisible()
    await expectNoOverflow(page, editor)
    await page.screenshot({ path: testInfo.outputPath(`net-worth-month-${width}.png`), fullPage: true })
    let savedPeriod = ''
    await page.route('**/api/household/net-worth/months/*', async (route) => {
      savedPeriod = new URL(route.request().url()).pathname.split('/').at(-1) ?? ''
      // The body must be a real JSON object: the client once double-encoded
      // this PUT, which the API rejected as invalid month details.
      const payload: unknown = route.request().postDataJSON()
      expect(payload, 'net worth month body must not be double-encoded').toEqual({
        completed: false,
        components: [{ group_key: 'savings', label: 'Emergency fund', value: 123 }],
      })
      await route.fulfill({ json: { period: savedPeriod } })
    })
    await editor.getByRole('button', { name: 'Save month' }).click()
    await expect(editor).toHaveCount(0)
    expect(savedPeriod).toBe('2027-01')
    expect(errors).toEqual([])
  })

  test(`overview uses shared loan summary cards at ${width}px`, async ({ page }, testInfo) => {
    const errors = await stubApi(page)
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    const card = page.getByRole('button', { name: 'Home mortgage', exact: true })
    await expect(card).toHaveClass('property-loans__card')
    const currency = card.locator('.property-loans__card-currency')
    await expect(currency).toHaveText('PLN')
    await expect(card.getByLabel('Amount paid')).toHaveText('300,000')
    await expect(card.getByLabel('Amount left')).toHaveText('600,000')
    await expect(card.getByLabel('Total loan amount')).toHaveText('900,000')
    const header = card.locator('.property-loans__card-head')
    const headerBox = await header.boundingBox()
    const currencyBox = await currency.boundingBox()
    expect(headerBox).not.toBeNull()
    expect(currencyBox).not.toBeNull()
    expect(Math.abs(currencyBox!.x + currencyBox!.width - headerBox!.x - headerBox!.width)).toBeLessThan(2)
    const currencyStyle = await currency.evaluate((node) => ({
      color: getComputedStyle(node).color,
      size: parseFloat(getComputedStyle(node).fontSize),
      headerSize: parseFloat(getComputedStyle(node.parentElement!).fontSize),
      mist: getComputedStyle(node).getPropertyValue('--mist').trim(),
    }))
    expect(currencyStyle.size).toBeLessThan(currencyStyle.headerSize)
    expect(currencyStyle.color).toBe(`rgb(${currencyStyle.mist.split(/\s+/).join(', ')})`)
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '33')
    await expectNoOverflow(page, card)
    await card.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`overview-loans-${width}.png`), fullPage: true })
    await card.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('.loan-detail-modal')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(card).toBeFocused()
    expect(errors).toEqual([])
  })

  test(`property edit preview forecast preserves history and fits at ${width}px`, async ({ page }, testInfo) => {
    const errors = await stubApi(page)
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    await page.getByRole('button', { name: /^Flat downtown/ }).click()
    await page.getByRole('button', { name: 'Flat downtown options' }).click()
    await page.getByRole('menuitem', { name: 'Edit' }).click()
    const surface = page.locator('.asset-detail-modal')
    const chart = surface.getByRole('img', { name: 'Value appreciation and depreciation outlook' })
    const forecast = surface.getByRole('switch', { name: 'Forecast' })
    await expect(chart).toBeVisible()
    await chart.scrollIntoViewIfNeeded()
    await expect(forecast).not.toBeChecked()
    await expect(chart.locator('.chart__hit')).toHaveCount(2)
    await expect(chart.locator('.loan-payoff-chart__future')).toHaveCount(0)
    await expectNoOverflow(page, surface, forecast)
    await page.screenshot({ path: testInfo.outputPath(`property-${width}-off.png`), fullPage: true })
    await forecast.click()
    await expect(forecast).toBeChecked()
    await expect(chart.locator('.chart__hit')).toHaveCount(26)
    await expect(chart.locator('.loan-payoff-chart__future')).toHaveCount(1)
    await expect(chart.locator('.chart-x-label').first()).toHaveText('2026-01')
    await expectNoOverflow(page, surface, forecast)
    await page.screenshot({ path: testInfo.outputPath(`property-${width}-on.png`), fullPage: true })
    await forecast.click()
    await expect(forecast).not.toBeChecked()
    await expect(chart.locator('.chart__hit')).toHaveCount(2)
    await expect(chart.locator('.loan-payoff-chart__future')).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.locator('.toast-banner--error')).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test(`property loan bars and payment sheets persist at ${width}px`, async ({ page }, testInfo) => {
    const errors = await stubApi(page)
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/assets')
    await page.getByRole('button', { name: /^Flat downtown/ }).click()
    await expect(page.getByRole('heading', { name: 'Loans', exact: true })).toBeVisible()
    const card = page.getByRole('button', { name: 'Home mortgage', exact: true })
    await expect(card.getByRole('progressbar')).toBeVisible()
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '33')
    await expect(card).not.toContainText('Current balance:')
    await expectNoOverflow(page, card)
    await page.screenshot({ path: testInfo.outputPath(`property-loans-${width}.png`), fullPage: true })
    await card.click()
    const dialog = page.locator('.loan-detail-modal')
    await dialog.getByRole('button', { name: 'Loan actions' }).click()
    await expect(dialog.getByRole('menuitem', { name: 'Edit table' })).toHaveCount(0)
    // Forecast is on by default: projected rows are already part of the table.
    await expect(dialog.getByRole('menuitemcheckbox', { name: 'Forecast', exact: true })).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('Escape')
    await dialog.getByRole('tab', { name: 'Table' }).click()
    const firstRow = dialog.getByRole('row', { name: 'Edit payment 2026-01-05' })
    const secondRow = dialog.getByRole('row', { name: 'Edit payment 2026-02-05' })
    await expect(firstRow).toHaveAttribute('tabindex', '0')
    await expect(firstRow).toHaveClass(/loan-schedule-table__row--completed/)
    await page.screenshot({ path: testInfo.outputPath(`loan-completed-table-${width}.png`), fullPage: true })
    await expect(dialog.locator('.loan-schedule-table__row')).toHaveCount(4)
    await firstRow.locator('td').first().click()
    const editSheet = page.getByRole('dialog', { name: 'Edit payment', exact: true })
    await expect(editSheet).toHaveClass(/modal-sheet/)
    await expect(editSheet.getByRole('form', { name: 'Edit loan payment' })).toBeVisible()
    await expect(editSheet.getByLabel('Date')).toHaveValue('2026-01-05')
    await expect(editSheet.getByRole('checkbox', { name: 'Completed' })).toBeChecked()
    await editSheet.getByLabel('Interest', { exact: true }).fill('9999')
    await editSheet.getByRole('button', { name: 'Close' }).click()
    await expect(editSheet).toHaveCount(0)
    await firstRow.focus()
    await page.keyboard.press('Enter')
    await expect(editSheet.getByLabel('Base payment', { exact: true })).toHaveValue('3400')
    await expect(editSheet.getByLabel('Balance', { exact: true })).toHaveValue('600000')
    // Layout contract: balance sits right of the base payment, interest right
    // of the principal; both derived fields are read-only and carry no
    // currency hints, the interest balance field is gone, and there is no
    // Cancel button — the three-dot menu beside the close button owns removal.
    // Wait out the sheet's open animation first: measuring mid-slide offsets
    // boxes captured a frame apart.
    await editSheet.evaluate((root) => Promise.all(
      root.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => undefined)),
    ))
    const box = async (label: string | { role: string; name: string }) =>
      await (typeof label === 'string'
        ? editSheet.getByLabel(label, { exact: true })
        : editSheet.getByRole(label.role, { name: label.name })).boundingBox()
    // The completed switch pill matches the date field's box and shares its row.
    const [dateFieldBox, statusBox] = await Promise.all([
      editSheet.locator('.form-grid > .outlined-field').first().boundingBox(),
      box({ role: 'checkbox', name: 'Completed' }),
    ])
    expect(Math.abs(statusBox!.y - dateFieldBox!.y)).toBeLessThanOrEqual(2)
    expect(Math.abs(statusBox!.height - dateFieldBox!.height)).toBeLessThanOrEqual(2)
    expect(statusBox!.x).toBeGreaterThan(dateFieldBox!.x)
    const [basePaymentBox, balanceBox, principalBox, interestBox] = await Promise.all([
      box('Base payment'), box('Balance'), box('Principal'), box('Interest'),
    ])
    expect(balanceBox!.y).toBeCloseTo(basePaymentBox!.y, 0)
    expect(balanceBox!.x).toBeGreaterThan(basePaymentBox!.x)
    expect(interestBox!.y).toBeCloseTo(principalBox!.y, 0)
    expect(interestBox!.x).toBeGreaterThan(principalBox!.x)
    await expect(editSheet.getByLabel('Base payment', { exact: true })).toHaveAttribute('readonly')
    await expect(editSheet.getByLabel('Balance', { exact: true })).toHaveAttribute('readonly')
    await expect(editSheet).not.toContainText('PLN')
    await expect(editSheet).not.toContainText('recalculated automatically')
    await expect(editSheet.getByLabel('Interest balance', { exact: true })).toHaveCount(0)
    await expect(editSheet.getByRole('button', { name: 'Cancel' })).toHaveCount(0)
    await expect(editSheet.getByRole('button', { name: 'Payment actions' })).toBeVisible()
    await editSheet.getByLabel('Interest', { exact: true }).fill('1900.25')
    await editSheet.getByLabel('Extra principal', { exact: true }).fill('100.25')
    await expectNoOverflow(page, editSheet, editSheet.getByRole('button', { name: 'Save payment' }))
    await page.screenshot({ path: testInfo.outputPath(`loan-edit-payment-${width}.png`), fullPage: true })
    const saveRequest = page.waitForRequest((request) => request.method() === 'PUT' && request.url().endsWith('/loans/loan-1'))
    await editSheet.getByRole('button', { name: 'Save payment' }).click()
    expect((await saveRequest).postDataJSON().payment_schedule).toEqual([
      { ...payments[0], payment: '3500.25', extra_principal: '100.25', principal: '1600', interest: '1900.25', outstanding_loan_balance: '599899.75' }, ...payments.slice(1),
    ])
    await expect(editSheet).toHaveCount(0)
    await secondRow.focus()
    await page.keyboard.press('Space')
    await expect(editSheet.getByLabel('Date')).toHaveValue('2026-02-05')
    const removeRequest = page.waitForRequest((request) => request.method() === 'PUT' && request.url().endsWith('/loans/loan-1'))
    await editSheet.getByRole('button', { name: 'Payment actions' }).click()
    await editSheet.getByRole('menuitem', { name: 'Remove row', exact: true }).click()
    expect((await removeRequest).postDataJSON().payment_schedule).toEqual([
      { ...payments[0], payment: '3500.25', extra_principal: '100.25', principal: '1600', interest: '1900.25', outstanding_loan_balance: '599899.75' }, ...payments.slice(2),
    ])
    await expect(secondRow).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Add row', exact: true }).click()
    const addSheet = page.getByRole('dialog', { name: 'Add payment', exact: true })
    await expect(addSheet).toHaveClass(/modal-sheet/)
    await expect(addSheet.getByLabel('Date')).toHaveValue('2026-05-01')
    await expect(addSheet.getByRole('button', { name: 'Payment actions' })).toHaveCount(0)
    const completionToggle = addSheet.getByRole('checkbox', { name: 'Completed' })
    await expect(completionToggle).not.toBeChecked()
    await completionToggle.focus()
    await page.keyboard.press('Space')
    await expect(completionToggle).toBeChecked()
    for (const label of ['Interest', 'Principal', 'Extra principal', 'Base payment']) {
      await expect(addSheet.getByLabel(label, { exact: true })).toHaveValue('')
    }
    // The new row continues from the last stored balance.
    await expect(addSheet.getByLabel('Balance', { exact: true })).toHaveValue('594600')
    await addSheet.getByLabel('Principal', { exact: true }).fill('1800.75')
    await addSheet.getByLabel('Interest', { exact: true }).fill('1800')
    await expect(addSheet.getByLabel('Base payment', { exact: true })).toHaveValue('3600.75')
    await expect(addSheet.getByLabel('Balance', { exact: true })).toHaveValue('592799.25')
    await expectNoOverflow(page, addSheet, addSheet.getByRole('button', { name: 'Save payment' }))
    await page.screenshot({ path: testInfo.outputPath(`loan-add-payment-${width}.png`), fullPage: true })
    const addRequest = page.waitForRequest((request) => request.method() === 'PUT' && request.url().endsWith('/loans/loan-1'))
    await addSheet.getByRole('button', { name: 'Save payment' }).click()
    expect((await addRequest).postDataJSON().payment_schedule).toEqual([
      { ...payments[0], payment: '3500.25', extra_principal: '100.25', principal: '1600', interest: '1900.25', outstanding_loan_balance: '599899.75' }, ...payments.slice(2),
      { date: '2026-05-01', payment: '3600.75', interest: '1800', principal: '1800.75', outstanding_loan_balance: '592799.25', completed: true, projected: false },
    ])
    await expect(addSheet).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Close loan details' }).click()
    await page.getByRole('button', { name: 'Dismiss success message' }).click()
    await expect(card.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '33')
    await card.click()
    await dialog.getByRole('tab', { name: 'Table' }).click()
    await expect(dialog.locator('.loan-schedule-table__row')).toHaveCount(4)
    await expect(secondRow).toHaveCount(0)
    await firstRow.click()
    await expect(editSheet.getByLabel('Base payment', { exact: true })).toHaveValue('3500.25')
    await expect(editSheet.getByLabel('Extra principal', { exact: true })).toHaveValue('100.25')
    await editSheet.getByRole('button', { name: 'Close' }).click()
    await dialog.getByRole('row', { name: 'Edit payment 2026-05-01' }).click()
    await expect(editSheet.getByLabel('Base payment', { exact: true })).toHaveValue('3600.75')
    await expect(editSheet.getByLabel('Balance', { exact: true })).toHaveValue('592799.25')
    await editSheet.getByRole('button', { name: 'Close' }).click()
    // Disabling Forecast leaves only the recorded payments.
    await dialog.getByRole('button', { name: 'Loan actions' }).click()
    await dialog.getByRole('menuitemcheckbox', { name: 'Forecast' }).click()
    await expect(dialog.locator('.loan-schedule-table__row')).toHaveCount(2)
    await dialog.getByRole('button', { name: 'Loan actions' }).click()
    await dialog.getByRole('menuitemcheckbox', { name: 'Forecast' }).click()
    await expect(dialog.locator('.loan-schedule-table__row')).toHaveCount(4)
    await dialog.getByRole('row', { name: 'Edit payment 2026-03-05' }).click()
    await expect(editSheet.getByLabel('Base payment', { exact: true })).toHaveValue('3400')
    await expect(editSheet.getByRole('checkbox', { name: 'Completed' })).not.toBeChecked()
    await editSheet.getByRole('checkbox', { name: 'Completed' }).check()
    const completeRequest = page.waitForRequest((request) => request.method() === 'PUT' && request.url().endsWith('/loans/loan-1'))
    await editSheet.getByRole('button', { name: 'Save payment' }).click()
    expect((await completeRequest).postDataJSON().payment_schedule[1]).toMatchObject({ id: 'payment-3', completed: true, projected: false })
    await expect(dialog.getByRole('row', { name: 'Edit payment 2026-03-05' })).toHaveClass(/loan-schedule-table__row--completed/)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.locator('.toast-banner--error')).toHaveCount(0)
    expect(errors).toEqual([])
  })

  test(`loan forecast keeps chart and table consistent at ${width}px`, async ({ page }, testInfo) => {
    const errors = await stubApi(page)
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    await page.getByRole('button', { name: /^Home mortgage/ }).click()
    const dialog = page.locator('.loan-detail-modal')
    const actions = dialog.getByRole('button', { name: 'Loan actions' })
    const menu = dialog.getByRole('menu')
    const forecast = menu.getByRole('menuitemcheckbox', { name: 'Forecast', exact: true })
    const chart = dialog.getByRole('img', { name: 'Loan payoff balance and interest outlook' })
    const summary = dialog.locator('.loan-progress')
    const values = summary.locator('.loan-progress__values')
    await expect(values.getByLabel('Amount paid')).toBeVisible()
    await expect(values.getByLabel('Amount left')).toBeVisible()
    await expect(values.getByLabel('Total loan amount')).toBeVisible()
    const layout = await values.evaluate((row) => {
      const paid = row.querySelector('.loan-progress__paid')!
      const total = row.querySelector('.loan-progress__amount')!
      const left = row.querySelector('.loan-progress__remaining')!
      const paidBox = paid.getBoundingClientRect()
      const totalBox = total.getBoundingClientRect()
      const leftBox = left.getBoundingClientRect()
      return {
        paidRight: paidBox.right, totalLeft: totalBox.left, totalRight: totalBox.right, leftLeft: leftBox.left,
        totalSize: parseFloat(getComputedStyle(total).fontSize), paidSize: parseFloat(getComputedStyle(paid).fontSize),
        totalColor: getComputedStyle(total).color, paidColor: getComputedStyle(paid).color,
      }
    })
    expect(layout.paidRight).toBeLessThanOrEqual(layout.totalLeft)
    expect(layout.totalRight).toBeLessThanOrEqual(layout.leftLeft)
    expect(layout.totalSize).toBeLessThan(layout.paidSize)
    expect(layout.totalColor).not.toBe(layout.paidColor)
    const expectMenuClosed = async () => {
      await expect(actions).toHaveAttribute('aria-expanded', 'false')
      await expect(menu).toHaveCount(0)
      await expect(dialog.getByText('Forecast', { exact: true })).toHaveCount(0)
      await expect(dialog.getByRole('switch', { name: 'Forecast' })).toHaveCount(0)
    }
    const openForecastMenu = async (checked: boolean) => {
      await actions.click()
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('menuitem', { name: 'Edit table' })).toHaveCount(0)
      await expect(menu.getByRole('menuitem', { name: 'Edit', exact: true })).toBeFocused()
      await page.keyboard.press('ArrowDown')
      await expect(forecast).toBeFocused()
      await expect(forecast).toHaveAttribute('aria-checked', String(checked))
      await expectNoOverflow(page, dialog, forecast)
      const menuBox = await menu.boundingBox()
      const itemBox = await forecast.boundingBox()
      expect(menuBox).not.toBeNull()
      expect(itemBox).not.toBeNull()
      expect(menuBox!.x).toBeGreaterThanOrEqual(0)
      expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(width)
      expect(itemBox!.x).toBeGreaterThanOrEqual(menuBox!.x)
      expect(itemBox!.x + itemBox!.width).toBeLessThanOrEqual(menuBox!.x + menuBox!.width)
      expect(itemBox!.y).toBeGreaterThanOrEqual(menuBox!.y)
      expect(itemBox!.y + itemBox!.height).toBeLessThanOrEqual(menuBox!.y + menuBox!.height)
    }
    await expectMenuClosed()
    // Forecast on by default: the chart carries recorded and projected months.
    await expect(chart.locator('.chart__hit')).toHaveCount(4)
    await expect(chart.locator('.loan-payoff-chart__future')).toHaveCount(1)
    const currentMetadata = await summary.innerText()
    await expectNoOverflow(page, dialog)
    await page.screenshot({ path: testInfo.outputPath(`loan-${width}-on.png`), fullPage: true })
    await dialog.getByRole('tab', { name: 'Table' }).click()
    await expect(dialog.locator('.loan-schedule-table__row')).toHaveCount(4)
    await expect(dialog.locator('.loan-schedule-table__row > th')).toHaveText(['1', '2', '3', '4'])
    await openForecastMenu(true)
    await page.screenshot({ path: testInfo.outputPath(`loan-menu-${width}-on.png`), fullPage: true })
    await forecast.click()
    await expectMenuClosed()
    await expect(actions).toBeFocused()
    await expect(dialog.locator('.loan-schedule-table__row')).toHaveCount(2)
    await expect(dialog.locator('.loan-schedule-table__row > th')).toHaveText(['1', '2'])
    await expectNoOverflow(page, dialog)
    await page.screenshot({ path: testInfo.outputPath(`loan-table-${width}-off.png`), fullPage: true })
    await dialog.getByRole('tab', { name: 'Summary' }).click()
    await expect(chart.locator('.chart__hit')).toHaveCount(2)
    await expect(chart.locator('.loan-payoff-chart__future')).toHaveCount(0)
    expect(await summary.innerText()).toBe(currentMetadata)
    await expectNoOverflow(page, dialog)
    await page.screenshot({ path: testInfo.outputPath(`loan-${width}-off.png`), fullPage: true })
    await openForecastMenu(false)
    await page.screenshot({ path: testInfo.outputPath(`loan-menu-${width}-off.png`), fullPage: true })
    await forecast.click()
    await expectMenuClosed()
    await expect(actions).toBeFocused()
    await expect(chart.locator('.chart__hit')).toHaveCount(4)
    await expect(chart.locator('.loan-payoff-chart__future')).toHaveCount(1)
    await dialog.getByRole('tab', { name: 'Table' }).click()
    await expect(dialog.locator('.loan-schedule-table__row')).toHaveCount(4)
    await expect(dialog.locator('.loan-schedule-table__row > th')).toHaveText(['1', '2', '3', '4'])
    await openForecastMenu(true)
    await page.keyboard.press('Escape')
    await expectMenuClosed()
    await expect(actions).toBeFocused()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.locator('.toast-banner--error')).toHaveCount(0)
    expect(errors).toEqual([])
  })
}
