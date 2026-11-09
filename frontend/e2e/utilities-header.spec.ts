import { expect, test, type Page } from '@playwright/test'
import type { UtilityBoard } from '../src/contracts/utilities'

const session = {
  token: 'utilities-header-test', expires_at: '2099-01-01T00:00:00Z',
  user: { id: 'u', email: 'test@example.com', full_name: 'Tester', picture_url: '' },
  household: { id: 'h', name: 'Utilities header tests', base_currency: 'PLN', timezone: 'Europe/Warsaw' },
  membership: { id: 'm', role: 'owner', relationship_kind: 'owner' },
  settings: { id: 's', privacy_mode: 'household', allow_cross_member_visibility: true, projection_baseline_window_months: 12, projection_horizon_months: 24, savings_allocation_strategy: 'default', role_permissions: {} },
}

const property = {
  id: 'asset-1', name: 'Flat downtown', total_cost: 900000, valuation_date: '2026-01-01',
  status: 'active', started_on: '2020-03-01', ended_on: null, notes: '', item_count: 0,
  completed_item_count: 0, completed_cost: 0, completion_percent: 0, kind: 'asset',
  category: 'property', utilities_enabled: true,
}

const utilityBoard: UtilityBoard = {
  subject: {
    id: property.id, kind: 'property', name: property.name, group_type: 'flat', notes: '',
    tracked_fields: [
      { key: 'electricity', label: 'Electricity', kind: 'metered', unit: 'kWh', color: '#087f8c' },
      { key: 'gas', label: 'Gas', kind: 'metered', unit: 'm3' },
    ],
  },
  trend: [
    { period: '2024-12', values: { electricity: 190, gas: 70 }, usage: { electricity: 380, gas: 20 }, units: { electricity: 'kWh', gas: 'm3' }, total: 260 },
    { period: '2026-03', values: { electricity: 200, gas: 80 }, usage: { electricity: 400, gas: 25 }, units: { electricity: 'kWh', gas: 'm3' }, total: 280 },
    { period: '2027-04', values: { electricity: 210, gas: 90 }, usage: { electricity: 420, gas: 30 }, units: { electricity: 'kWh', gas: 'm3' }, total: 300 },
  ],
  months: [
    { month: '2024-12', values: { electricity: { amount: 190, usage_amount: 380 }, gas: { amount: 70, usage_amount: 20 } }, total: 260 },
    { month: '2026-03', values: { electricity: { amount: 200, usage_amount: 400 }, gas: { amount: 80, usage_amount: 25 } }, total: 280 },
    { month: '2027-04', values: { electricity: { amount: 210, usage_amount: 420 }, gas: { amount: 90, usage_amount: 30 } }, total: 300 },
  ],
}

async function stubApi(page: Page, unexpectedRequests: string[], boardRequests: string[]) {
  const board = structuredClone(utilityBoard)
  const catalog = board.subject.tracked_fields.map((field) => ({ ...field, retired: false, hidden: false, has_data: true, entry_mode: 'meter', unit_rate: field.key === 'electricity' ? 0.25 : null }))
  const contracts = catalog.map((field, index) => ({ ...field, id: field.key, property_id: property.id, tracking_mode: 'meter', start_date: '2024-01-01', end_date: null, sort_order: index }))
  const prices = [{ id: 'price-1', effective_on: '2026-03-01', price: 0.25 }]
  const responses: Record<string, unknown> = {
    '/api/household/utilities/contracts': contracts,
    '/api/household/utilities/contracts/electricity/prices': prices,
    '/api/auth/session': session,
    '/api/backups/config': { path: '', retention: 0 },
    '/api/household/settings': session.settings,
    '/api/household/assets': [property],
    '/api/household/categories': [],
    '/api/household/loans': [],
    '/api/household/groups': [],
    '/api/household/utility-field-catalog': catalog,
    '/api/household/utilities/board': board,
    '/api/household/utility-field-catalog/electricity/audit': [{ id: 'audit-1', actor_user_id: 'u', created_at: '2026-03-01T12:00:00Z', old_config: null, new_config: { label: 'Electricity', unit: 'kWh', entry_mode: 'meter', unit_rate: 0.25 } }],
  }
  await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname === '/api/household/utilities/contracts/reorder' && request.method() === 'POST') {
      const ids: string[] = request.postDataJSON().ordered_ids
      const order = new Map(ids.map((id, index) => [id, index]))
      contracts.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      board.subject.tracked_fields.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0))
      await route.fulfill({ json: contracts })
      return
    }
    if (url.pathname === '/api/household/utilities/contracts/electricity' && request.method() === 'PUT') {
      const target = contracts.find((contract) => contract.id === 'electricity')
      if (!target) throw new Error('Electricity contract fixture missing')
      Object.assign(target, request.postDataJSON(), { retired: Boolean(request.postDataJSON().end_date) })
      await route.fulfill({ json: target })
      return
    }
    if (url.pathname === '/api/household/utilities/contracts/electricity/prices/price-1' && request.method() === 'PUT') {
      Object.assign(prices[0], request.postDataJSON())
      await route.fulfill({ json: prices[0] })
      return
    }
    if (url.pathname === '/api/household/utility-field-order' && request.method() === 'POST') {
      const keys: string[] = request.postDataJSON().keys
      catalog.sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key))
      board.subject.tracked_fields.sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key))
      await route.fulfill({ json: catalog })
      return
    }
    if (url.pathname === '/api/household/utility-field-catalog/electricity/lifecycle' && request.method() === 'PATCH') {
      const field = catalog.find((item) => item.key === 'electricity')
      const tracked = board.subject.tracked_fields.find((item) => item.key === 'electricity')
      if (!field || !tracked) throw new Error('Electricity fixture missing')
      Object.assign(field, request.postDataJSON())
      Object.assign(tracked, request.postDataJSON())
      await route.fulfill({ json: field })
      return
    }
    if (url.pathname === '/api/household/utilities/form') {
      await route.fulfill({ json: { month: url.searchParams.get('month'), fields: utilityBoard.subject.tracked_fields.map((field) => ({ ...field, amount: 210, meter_reading: 1000 })) } })
      return
    }
    if (url.pathname === '/api/household/utilities/upsert' && request.method() === 'POST') {
      expect(request.postDataJSON().month).toBe('2027-04')
      expect(request.postDataJSON().entries[0].amount).toBe(225)
      await route.fulfill({ json: utilityBoard })
      return
    }
    if (url.pathname === '/api/household/utilities/board') boardRequests.push(url.search)
    if (request.method() !== 'GET' || !(url.pathname in responses)) {
      unexpectedRequests.push(`${request.method()} ${url.pathname}${url.search}`)
      await route.fulfill({ status: 501, json: { detail: 'Unexpected API request in utilities header test' } })
      return
    }
    await route.fulfill({ json: responses[url.pathname] })
  })
  await page.addInitScript(() => localStorage.setItem('checkbook.session', 'utilities-header-test'))
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`Utilities header stays inline and keeps the complete board at ${viewport.width}px`, async ({ page }, testInfo) => {
    const consoleErrors: string[] = []
    const failedRequests: string[] = []
    const unexpectedRequests: string[] = []
    const boardRequests: string[] = []
    page.on('pageerror', (error) => consoleErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`))
    page.on('response', (response) => {
      if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`)
    })

    await page.setViewportSize(viewport)
    await page.clock.setFixedTime(new Date('2026-03-15T12:00:00Z'))
    await stubApi(page, unexpectedRequests, boardRequests)
    await page.goto('/assets')
    await page.getByRole('button', { name: 'Asset', exact: true }).click()
    await page.getByRole('listbox', { name: 'Asset', exact: true }).getByRole('option', { name: property.name, exact: true }).click()

    const panel = page.locator('.panel').filter({ has: page.getByRole('heading', { name: 'Utilities', exact: true }) })
    const header = panel.locator('.panel__header')
    const metric = header.getByRole('button', { name: 'Utility chart metric', exact: true })
    const details = header.getByRole('button', { name: 'Details', exact: true })
    await expect(panel.getByRole('img', { name: 'Monthly utility costs' })).toBeVisible()
    await expect(panel.getByText('Forecast', { exact: true })).toHaveCount(0)
    await expect(metric).toContainText('Money')
    await expect(details).toBeEnabled()
    await panel.scrollIntoViewIfNeeded()

    const assertHeaderLayout = async () => {
      const layout = await header.evaluate((element) => {
        const title = element.querySelector('h2, h3')
        const metricButton = element.querySelector('[aria-label="Utility chart metric"]')
        const detailsButton = Array.from(element.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Details')
        if (!title || !metricButton || !detailsButton) throw new Error('Missing Utilities header control')
        const box = element.getBoundingClientRect()
        const titleBox = title.getBoundingClientRect()
        const metricBox = metricButton.getBoundingClientRect()
        const detailsBox = detailsButton.getBoundingClientRect()
        const style = getComputedStyle(element)
        return {
          titleCenter: (titleBox.top + titleBox.bottom) / 2,
          metricCenter: (metricBox.top + metricBox.bottom) / 2,
          detailsCenter: (detailsBox.top + detailsBox.bottom) / 2,
          titleRight: titleBox.right,
          metricLeft: metricBox.left,
          metricRight: metricBox.right,
          detailsLeft: detailsBox.left,
          detailsRight: detailsBox.right,
          contentRight: box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth),
          headerRight: box.right,
          headerOverflow: element.scrollWidth - element.clientWidth,
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
        }
      })
      expect(Math.abs(layout.titleCenter - layout.metricCenter)).toBeLessThanOrEqual(2)
      expect(Math.abs(layout.titleCenter - layout.detailsCenter)).toBeLessThanOrEqual(2)
      expect(layout.metricLeft).toBeGreaterThan(layout.titleRight)
      expect(layout.detailsLeft).toBeGreaterThanOrEqual(layout.metricRight)
      expect(Math.abs(layout.contentRight - layout.detailsRight)).toBeLessThanOrEqual(2)
      expect(layout.headerRight).toBeLessThanOrEqual(viewport.width)
      expect(layout.headerOverflow).toBeLessThanOrEqual(1)
      expect(layout.pageOverflow).toBeLessThanOrEqual(1)
    }
    await assertHeaderLayout()
    await page.screenshot({ path: testInfo.outputPath(`utilities-header-${viewport.width}.png`), fullPage: true })

    // Both the chart and Details retain history and future months without a Forecast filter.
    await expect(panel.locator('.chart-x-label')).toHaveText(['2024-12', '2026-03', '2027-04'])
    await expect(panel.getByRole('button', { name: 'Electricity', exact: true }).locator('i')).toHaveCSS('background-color', 'rgb(8, 127, 140)')
    await panel.getByRole('button', { name: 'Electricity', exact: true }).click()
    await expect(panel.locator('.utility-trend-chart__line')).toHaveCSS('stroke', 'rgb(8, 127, 140)')
    for (const [label, axisUnit] of [['Usage', 'kWh'], ['Unit price', 'PLN/kWh']]) {
      await metric.click()
      const menu = page.getByRole('listbox', { name: 'Utility chart metric', exact: true })
      await expect(menu.getByRole('option')).toHaveText(['Money', 'Usage', 'Unit price'])
      const menuBox = await menu.boundingBox()
      expect(menuBox).not.toBeNull()
      expect(menuBox!.x).toBeGreaterThanOrEqual(0)
      expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(viewport.width)
      await menu.getByRole('option', { name: label, exact: true }).click()
      await expect(metric).toContainText(label)
      await expect(menu).toHaveCount(0)
      await expect(panel.locator('.chart-tick').first()).toContainText(axisUnit)
      await assertHeaderLayout()
    }

    await details.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Utilities PLN' })).toBeVisible()
    const metricToggle = dialog.getByRole('group', { name: 'Table metric' })
    await expect(metricToggle).toBeVisible()
    const assertDetailHeaderLayout = async (width: number) => {
      const detailHeaderLayout = await dialog.locator('.drive-picker__header').evaluate((element) => {
        const controls = ['.nw-options__trigger', 'h2', '.net-worth-modal__currency', '.nw-close'].map((selector) => {
          const control = element.querySelector(selector)
          if (!control) throw new Error(`Missing header control: ${selector}`)
          const box = control.getBoundingClientRect()
          return { left: box.left, right: box.right, center: (box.top + box.bottom) / 2 }
        })
        const trigger = element.querySelector('.nw-options__trigger')!
        const title = element.querySelector('h2')!
        return {
          controls,
          bottom: element.getBoundingClientRect().bottom,
          triggerPadding: getComputedStyle(trigger).paddingRight,
          titleSize: parseFloat(getComputedStyle(title).fontSize),
          overflow: element.scrollWidth - element.clientWidth,
        }
      })
      for (const control of detailHeaderLayout.controls) {
        expect(Math.abs(control.center - detailHeaderLayout.controls[0].center)).toBeLessThanOrEqual(3)
        expect(control.right).toBeLessThanOrEqual(width)
      }
      // Dots, then title with currency, then close — no extra header controls
      // beyond the shared 0.55rem grid gap (the trigger keeps no own padding).
      expect(detailHeaderLayout.controls[1].left - detailHeaderLayout.controls[0].right).toBeLessThanOrEqual(9.5)
      expect(detailHeaderLayout.controls[2].right).toBeLessThan(detailHeaderLayout.controls[3].left)
      expect(detailHeaderLayout.triggerPadding).toBe('0px')
      expect(detailHeaderLayout.titleSize).toBeGreaterThan(16)
      expect(detailHeaderLayout.overflow).toBeLessThanOrEqual(1)
      // The money/meters switch sits in its own full-width row under the
      // header, like the loans summary/table tabs.
      const toggleBox = await metricToggle.boundingBox()
      const shellBox = await dialog.locator('.net-worth-table-shell').boundingBox()
      expect(toggleBox).not.toBeNull()
      expect(shellBox).not.toBeNull()
      expect(toggleBox!.y).toBeGreaterThanOrEqual(detailHeaderLayout.bottom - 1)
      expect(toggleBox!.x).toBeCloseTo(shellBox!.x, 0)
      if (width < 768) expect(Math.abs(toggleBox!.width - shellBox!.width)).toBeLessThanOrEqual(1)
    }
    await assertDetailHeaderLayout(viewport.width)
    if (viewport.width === 390) {
      await page.setViewportSize({ width: 320, height: 740 })
      await assertDetailHeaderLayout(320)
      await page.screenshot({ path: testInfo.outputPath('utilities-details-320.png'), fullPage: true })
      await page.setViewportSize(viewport)
    }
    const table = dialog.locator('.utility-detail-table')
    // The summary stat row is gone and money mode shows amounts only.
    await expect(dialog.getByText('Total utilities')).toHaveCount(0)
    await expect(table.locator('thead th')).toHaveText(['M', 'Total', 'Electricity', 'Gas'])
    for (const year of ['2024', '2026', '2027']) await expect(table.getByText(year, { exact: true })).toBeVisible()
    const monthRows = table.locator('tbody tr').filter({ has: page.locator('td') })
    await expect(monthRows).toHaveCount(3)
    await expect(monthRows.locator('th')).toHaveText(['4', '3', '12'])
    await expect(monthRows.locator('td:first-of-type')).toHaveText(['300', '280', '260'])
    await expect(monthRows.first()).not.toContainText('kWh')
    await page.screenshot({ path: testInfo.outputPath(`utilities-details-money-${viewport.width}.png`), fullPage: true })

    // Meters mode swaps the whole table to usage values, dropping the Total column.
    const meters = dialog.getByRole('button', { name: 'Meters', exact: true })
    await meters.click()
    await expect(meters).toHaveAttribute('aria-pressed', 'true')
    await expect(table.locator('thead th')).toHaveText(['M', 'Electricity', 'Gas'])
    await expect(monthRows.locator('td:first-of-type strong')).toHaveText(['420.0', '400.0', '380.0'])
    await expect(monthRows.first()).toContainText('kWh')
    const gasCell = monthRows.first().locator('td').nth(1)
    await expect(gasCell).toContainText('30.0')
    await expect(gasCell).toContainText('m3')
    const valueBox = await gasCell.locator('strong').boundingBox()
    const unitBox = await gasCell.locator('small').boundingBox()
    expect(unitBox!.x).toBeGreaterThan(valueBox!.x + valueBox!.width)
    expect(Math.abs(unitBox!.y + unitBox!.height - valueBox!.y - valueBox!.height)).toBeLessThanOrEqual(4)
    await page.screenshot({ path: testInfo.outputPath(`utilities-details-meters-${viewport.width}.png`), fullPage: true })
    await dialog.getByRole('button', { name: 'Money', exact: true }).click()
    await expect(table.locator('thead th')).toHaveText(['M', 'Total', 'Electricity', 'Gas'])
    const row = table.getByRole('row', { name: 'Edit utilities 2027-04' })
    await row.focus()
    await page.keyboard.press('Enter')
    const editor = page.getByRole('dialog', { name: 'Utility values' })
    await expect(editor.getByLabel('Month', { exact: true })).toHaveValue('2027-04')
    await expect(editor.getByLabel('Electricity amount', { exact: true })).toHaveCount(0)
    await expect(editor.getByRole('button', { name: 'Edit Electricity', exact: true })).toBeVisible()
    if (viewport.width < 768) await expect.poll(() => editor.evaluate((node) => getComputedStyle(node).transform)).toBe('none')
    await page.screenshot({ path: testInfo.outputPath('utility-labels.png'), fullPage: true })
    await editor.getByRole('checkbox', { name: 'Completed' }).check()
    await expect(editor.getByRole('button', { name: 'Edit Electricity', exact: true })).toBeDisabled()
    await editor.getByRole('checkbox', { name: 'Completed' }).uncheck()
    await editor.getByRole('button', { name: 'Edit Electricity', exact: true }).click()
    await expect(editor.getByLabel('Gas amount', { exact: true })).toHaveCount(0)
    await expect(editor.getByLabel('Electricity amount', { exact: true })).toHaveValue('210')
    if (viewport.width < 768) {
      const box = await editor.boundingBox()
      expect(box!.x).toBeCloseTo(0, 0)
      expect(box!.width).toBeCloseTo(viewport.width, 0)
    }
    await page.screenshot({ path: testInfo.outputPath('utility-editor.png'), fullPage: true })
    await editor.getByLabel('Electricity amount', { exact: true }).fill('225')
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(editor).toHaveCount(0)
    await page.getByRole('button', { name: 'Dismiss success message' }).click()
    await expect(table).toBeVisible()
    await row.click()
    await expect(editor).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(editor).toHaveCount(0)
    await expect(table).toBeVisible()
    await dialog.getByRole('button', { name: 'Table options' }).click()
    const addMonth = dialog.getByRole('menuitem', { name: 'Add month' })
    await expect(addMonth).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('utilities-add-month-menu.png'), fullPage: true })
    await addMonth.click()
    await expect(editor.getByLabel('Month', { exact: true })).toHaveValue('2027-05')
    await expect(editor.getByRole('button', { name: 'Edit Electricity', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(editor).toHaveCount(0)
    await expect(dialog.getByRole('menu')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // Utility management lives in Configuration, not the Add menu.
    await page.getByRole('button', { name: `${property.name} options` }).click()
    await page.getByRole('menuitem', { name: 'Configuration', exact: true }).click()
    const configuration = page.getByRole('dialog', { name: 'Utility contracts', exact: true })
    await expect(configuration.getByRole('button', { name: /Electricity/ })).toBeVisible()
    const options = configuration.getByRole('button', { name: 'Utility contracts options' })
    await page.screenshot({ path: testInfo.outputPath(`utility-contracts-${viewport.width}.png`), fullPage: true })
    // Reordering with chevrons persists the full order and flips the
    // details-table columns with it.
    await options.click()
    await configuration.getByRole('menuitem', { name: 'Reorder contracts' }).click()
    await page.screenshot({ path: testInfo.outputPath(`utility-reorder-${viewport.width}.png`), fullPage: true })
    await configuration.getByRole('button', { name: 'Move Gas up' }).click()
    await expect(configuration.getByRole('button', { name: 'Move Gas up' })).toBeDisabled()
    await options.click()
    await configuration.getByRole('menuitem', { name: 'Done reordering' }).click()
    await page.keyboard.press('Escape')
    await details.click()
    await expect(page.getByRole('dialog').locator('.utility-detail-table thead th'))
      .toHaveText(['M', 'Total', 'Gas', 'Electricity'])
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: `${property.name} options` }).click()
    await page.getByRole('menuitem', { name: 'Configuration', exact: true }).click()
    await expect(configuration.getByRole('button', { name: /Gas/ })).toBeVisible()
    await configuration.getByRole('button', { name: /Electricity/ }).click()
    const contractEditor = page.getByRole('dialog', { name: 'Electricity', exact: true })
    const colorTrigger = contractEditor.getByRole('button', { name: 'Contract color', exact: true })
    await expect(colorTrigger).toHaveCSS('background-color', 'rgb(8, 127, 140)')
    await expect(contractEditor.getByRole('button', { name: 'Automatic color', exact: true })).toHaveCount(0)
    const nameBox = await contractEditor.getByLabel('Name', { exact: true }).boundingBox()
    const colorBox = await colorTrigger.boundingBox()
    expect(nameBox).not.toBeNull()
    expect(colorBox).not.toBeNull()
    expect(colorBox!.x).toBeGreaterThanOrEqual(nameBox!.x + nameBox!.width)
    expect(Math.abs(colorBox!.y + colorBox!.height / 2 - nameBox!.y - nameBox!.height / 2)).toBeLessThanOrEqual(2)
    expect(colorBox!.width).toBeCloseTo(colorBox!.height, 0)
    await expect(colorTrigger).toHaveCSS('border-radius', '50%')
    await colorTrigger.click()
    const palette = contractEditor.getByRole('menu', { name: 'Contract colors', exact: true })
    await expect(palette).toBeVisible()
    const paletteBox = await palette.boundingBox()
    expect(paletteBox!.x).toBeGreaterThanOrEqual(0)
    expect(paletteBox!.x + paletteBox!.width).toBeLessThanOrEqual(viewport.width)
    await expect(palette.getByRole('menuitemradio').first()).toHaveCSS('border-radius', '50%')
    await page.screenshot({ path: testInfo.outputPath(`utility-color-palette-${viewport.width}.png`), fullPage: true })
    await page.keyboard.press('Escape')
    await expect(palette).toHaveCount(0)
    await expect(contractEditor).toBeVisible()
    await expect(colorTrigger).toBeFocused()
    await colorTrigger.click()
    await palette.getByRole('menuitemradio', { name: 'Blue (#1e6fd6)', exact: true }).click()
    await expect(palette).toHaveCount(0)
    await expect(colorTrigger).toHaveCSS('background-color', 'rgb(30, 111, 214)')
    await expect(contractEditor.getByLabel('Tracking', { exact: true })).toHaveValue('meter')
    await expect(contractEditor.getByLabel('Start date')).toHaveValue('2024-01-01')
    await expect(contractEditor.getByRole('region', { name: 'Price history' })).toContainText('Effective from 2026-03')
    await contractEditor.getByRole('button', { name: /Edit price/ }).click()
    await contractEditor.getByLabel('Unit price', { exact: true }).fill('0.35')
    await contractEditor.getByRole('button', { name: 'Save price', exact: true }).click()
    await expect(contractEditor.getByRole('button', { name: /Edit price/ })).toContainText('0.35')
    await page.screenshot({ path: testInfo.outputPath(`utility-price-editor-${viewport.width}.png`), fullPage: true })
    expect(await contractEditor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await contractEditor.getByLabel('End date (optional)').fill('2026-03-31')
    const savedContract = page.waitForRequest((request) => request.method() === 'PUT' && new URL(request.url()).pathname === '/api/household/utilities/contracts/electricity')
    await contractEditor.getByRole('button', { name: 'Save contract' }).click()
    expect((await savedContract).postDataJSON().color).toBe('#1e6fd6')
    await contractEditor.getByRole('button', { name: 'Back to contracts' }).click()
    await expect(configuration.getByRole('button', { name: /Electricity/ })).toContainText('Retired')
    await options.click()
    await configuration.getByRole('menuitemcheckbox', { name: 'Show retired contracts' }).click()
    await expect(configuration.getByRole('button', { name: /Electricity/ })).toHaveCount(0)
    await options.click()
    await configuration.getByRole('menuitemcheckbox', { name: 'Show retired contracts' }).click()
    await configuration.getByRole('button', { name: /Electricity/ }).click()
    await contractEditor.getByLabel('End date (optional)').fill('')
    await contractEditor.getByRole('button', { name: 'Save contract' }).click()
    await contractEditor.getByRole('button', { name: 'Back to contracts' }).click()
    await expect(configuration.getByRole('button', { name: /Electricity/ })).toContainText('Ongoing')
    await options.click()
    await configuration.getByRole('menuitem', { name: 'New utility contract' }).click()
    await expect(page.getByRole('dialog').getByLabel('Tracking')).toBeVisible()
    await expect(page.getByRole('dialog').getByLabel('Kind', { exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')

    expect(boardRequests.some((query) => {
      const params = new URLSearchParams(query)
      return params.get('property_id') === property.id && params.get('months') === '0'
    })).toBe(true)
    expect(unexpectedRequests).toEqual([])
    expect(failedRequests).toEqual([])
    expect(consoleErrors).toEqual([])
    await testInfo.attach('browser-diagnostics', {
      body: JSON.stringify({ consoleErrors, failedRequests, unexpectedRequests, boardRequests }, null, 2),
      contentType: 'application/json',
    })
  })
}
