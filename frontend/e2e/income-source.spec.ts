import { expect, test } from '@playwright/test'

const session = {
  token: 'income-test', expires_at: '2099-01-01T00:00:00Z',
  user: { id: 'u', email: 'test@example.com', full_name: 'Tester', picture_url: '' },
  household: { id: 'h', name: 'Income tests', base_currency: 'PLN', timezone: 'Europe/Warsaw' },
  membership: { id: 'm', role: 'owner', relationship_kind: 'owner' },
  settings: { id: 's', privacy_mode: 'household', allow_cross_member_visibility: true, projection_baseline_window_months: 12, projection_horizon_months: 24, savings_allocation_strategy: 'default', role_permissions: {} },
}

const source = {
  id: 'source-1', name: 'Software Engineer', source_type: 'employment', owner_scope: 'self',
  started_on: '2025-08-01', ended_on: null, notes: '',
  lines: [{ id: 'line-1', label: 'Base salary', amount: 12000, started_on: '2025-08-01', ended_on: null, owner_scope: null, category: null, fields: [{ label: 'Employer', value: 'Acme Corp' }] }],
  fields: [{ label: 'Employer', value: 'Acme Corp' }], milestones: [], sort_order: 0,
  annual_total: 144000, actual_total: 96000, line_count: 1,
  entries: [
    { id: 'entry-1', description: 'April payslip', amount: 12000, entry_date: '2026-04-30', owner_scope: 'self', notes: '' },
    { id: 'entry-2', description: 'March payslip', amount: 12000, entry_date: '2026-03-31', owner_scope: 'self', notes: '' },
  ],
}

async function stubIncomeApi(page: import('@playwright/test').Page) {
  await page.route('http://127.0.0.1:4174/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    const data = path === '/api/auth/session' ? session
      : path === '/api/household/settings' ? session.settings
        : path === '/api/household/income-sources' ? [source]
          : []
    await route.fulfill({ json: data })
  })
  await page.addInitScript(() => localStorage.setItem('checkbook.session', 'income-test'))
}

test('income timeline card puts the type chip beside the org and the tenure after the range', async ({ page }) => {
  await stubIncomeApi(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/income')

  const card = page.locator('.income-timeline__card').first()
  await expect(card).toBeVisible()
  const layout = await card.evaluate((root) => {
    const org = root.querySelector('.income-timeline__identity-row > strong')!
    const chip = root.querySelector('.income-timeline__identity-row .income-source-chip')!
    const row = root.querySelector('.income-timeline__identity-row')!
    const rangeLabel = root.querySelector('.income-timeline__range > span')!
    const tenure = root.querySelector('.income-timeline__tenure')!
    const center = (el: Element) => {
      const box = el.getBoundingClientRect()
      return box.top + box.height / 2
    }
    return {
      chipOnOrgRow: Math.abs(center(org) - center(chip)) <= 2,
      chipRight: chip.getBoundingClientRect().right,
      rowRight: row.getBoundingClientRect().right,
      tenureInline: Math.abs(center(rangeLabel) - center(tenure)) <= 2,
      tenureAfterRange: tenure.getBoundingClientRect().left - rangeLabel.getBoundingClientRect().left > 0,
      tenureLighter: getComputedStyle(tenure).color !== getComputedStyle(rangeLabel).color,
    }
  })
  expect(layout.chipOnOrgRow).toBe(true)
  expect(Math.abs(layout.chipRight - layout.rowRight)).toBeLessThanOrEqual(1)
  expect(layout.tenureInline).toBe(true)
  expect(layout.tenureAfterRange).toBe(true)
  expect(layout.tenureLighter).toBe(true)
})

test('job details open as a full-width page while editing keeps the compact card', async ({ page }) => {
  await stubIncomeApi(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/income')

  await page.getByRole('button', { name: /Acme Corp/i }).first().click()
  const modal = page.locator('.income-source-modal--designed')
  await expect(modal).toBeVisible()
  await expect(modal.getByText('April 2026')).toBeVisible()

  // Ledger view spans the viewport: no dark backdrop band on the right.
  const ledgerWidth = await modal.evaluate((root) => ({
    width: root.getBoundingClientRect().width,
    innerWidth: window.innerWidth,
  }))
  expect(ledgerWidth.width).toBeGreaterThan(ledgerWidth.innerWidth - 2)

  // The editor stays a compact centered card.
  await modal.getByRole('button', { name: 'Income source actions' }).click()
  await modal.getByRole('menuitem', { name: 'Edit source details' }).click()
  await expect(modal.locator('.income-source-edit')).toBeVisible()
  const editorWidth = await modal.evaluate((root) => root.getBoundingClientRect().width)
  expect(editorWidth).toBeLessThan(ledgerWidth.innerWidth - 2)
  await page.keyboard.press('Escape')
})
