import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { UtilitiesDetailsModal } from './UtilitiesDetailsModal'

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }))
afterEach(() => vi.unstubAllGlobals())

const POINT = {
  period: '2026-03',
  total: 35,
  values: { Water: 25, Rent: 10 },
  usage: { Water: 12.5, Rent: 0 },
  units: { Water: 'm3', Rent: '' },
}

function renderModal(onEditMonth = vi.fn()) {
  render(
    <UtilitiesDetailsModal
      points={[POINT]}
      categories={['Water', 'Rent']}
      currency="PLN"
      onClose={vi.fn()}
      onEditMonth={onEditMonth}
    />,
  )
  return onEditMonth
}

it('opens the selected month with pointer, Enter, and Space like net worth rows', async () => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  const user = userEvent.setup()
  const onEditMonth = renderModal()
  const row = screen.getByRole('row', { name: 'Edit utilities 2026-03' })
  await user.click(row)
  row.focus()
  await user.keyboard('{Enter}')
  await user.keyboard(' ')
  expect(onEditMonth.mock.calls).toEqual([['2026-03'], ['2026-03'], ['2026-03']])
})

it('shows only monetary amounts by default without the summary stat row', () => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  renderModal()
  expect(screen.queryByText('Total utilities')).not.toBeInTheDocument()
  expect(screen.queryByText('Monthly average')).not.toBeInTheDocument()
  expect(screen.queryByText('Categories')).not.toBeInTheDocument()
  expect(screen.getByRole('columnheader', { name: 'Total' })).toBeInTheDocument()
  expect(screen.getByText('35')).toBeInTheDocument()
  expect(screen.getByText('25')).toBeInTheDocument()
  expect(screen.queryByText('12.5')).not.toBeInTheDocument()
})

it('toggles the table between money and meters from the full-width switch under the header', async () => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  const user = userEvent.setup()
  renderModal()

  const money = screen.getByRole('button', { name: 'Money' })
  const meters = screen.getByRole('button', { name: 'Meters' })
  expect(money).toHaveAttribute('aria-pressed', 'true')
  expect(meters).toHaveAttribute('aria-pressed', 'false')
  expect(money).toHaveTextContent('Money')
  expect(meters).toHaveTextContent('Meters')
  // The switch sits in its own row below the shared header, which keeps only
  // the options trigger, the title, and the close button.
  const header = screen.getByRole('heading', { name: 'Utilities PLN' }).closest('.drive-picker__header')
  expect(header).not.toContainElement(money)
  expect(header).not.toContainElement(meters)
  expect(header?.nextElementSibling).toContainElement(money)
  expect(header?.nextElementSibling).toContainElement(meters)
  expect(money.closest('.view-toggle')).toBe(meters.closest('.view-toggle'))

  await user.click(meters)
  expect(meters).toHaveAttribute('aria-pressed', 'true')
  expect(money).toHaveAttribute('aria-pressed', 'false')
  // The monetary Total column disappears and usage values replace amounts.
  expect(screen.queryByRole('columnheader', { name: 'Total' })).not.toBeInTheDocument()
  expect(screen.getByText('12.5')).toBeInTheDocument()
  expect(screen.getByText('m3')).toBeInTheDocument()
  expect(screen.queryByText('25')).not.toBeInTheDocument()
  // Columns without a meter unit render an empty placeholder instead.
  expect(screen.getByText('—')).toBeInTheDocument()

  await user.click(money)
  expect(screen.getByRole('columnheader', { name: 'Total' })).toBeInTheDocument()
  expect(screen.getByText('35')).toBeInTheDocument()
  expect(screen.queryByText('12.5')).not.toBeInTheDocument()
})

for (const [periods, expected] of [
  [['2026-03', '2025-12'], '2026-04'],
  [['2026-12'], '2027-01'],
  [[], '2027-01'],
] as const) {
  it(`adds the next month (${expected}) from the table menu for ${periods.join(',') || 'an empty table'}`, async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-12-31T23:30:00Z'))
    try {
      const user = userEvent.setup()
      const onEditMonth = vi.fn()
      render(<UtilitiesDetailsModal points={periods.map((period) => ({ ...POINT, period }))}
        categories={['Water', 'Rent']} currency="PLN" timeZone="Europe/Warsaw"
        onClose={vi.fn()} onEditMonth={onEditMonth} />)
      const trigger = screen.getByRole('button', { name: 'Table options' })
      await user.click(trigger)
      expect(trigger).toHaveAttribute('aria-expanded', 'true')
      await user.click(screen.getByRole('menuitem', { name: 'Add month' }))
      expect(onEditMonth).toHaveBeenCalledWith(expected)
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      // The shared menu focuses its first item on open; Escape restores the trigger.
      await user.click(trigger)
      expect(screen.getByRole('menuitem', { name: 'Add month' })).toHaveFocus()
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
      expect(trigger).toHaveFocus()
    } finally {
      vi.useRealTimers()
    }
  })
}

it('keeps same-named contracts separate and missing lifetime values empty', () => {
  render(<UtilitiesDetailsModal points={[{ period: '2026-03', total: 30, values: { first: 10, second: 20 }, usage: {}, units: {} }]} categories={['first', 'second', 'future']} categoryLabels={{ first: 'Power', second: 'Power', future: 'Future' }} categoryColors={{ first: '#123456', second: '#abcdef' }} currency="PLN" onClose={vi.fn()} onEditMonth={vi.fn()} />)
  const headers = screen.getAllByRole('columnheader', { name: 'Power' })
  expect(headers).toHaveLength(2)
  expect(headers[0].querySelector('i')).toHaveStyle({ background: '#123456' })
  expect(headers[1].querySelector('i')).toHaveStyle({ background: '#abcdef' })
  const row = screen.getByRole('row', { name: 'Edit utilities 2026-03' })
  expect(row).toHaveTextContent('10')
  expect(row).toHaveTextContent('20')
  expect(row).toHaveTextContent('—')
})
it('does not offer month edits for legacy read-only history', () => {
  render(<UtilitiesDetailsModal points={[POINT]} categories={['Water']} currency="PLN" onClose={vi.fn()} />)
  expect(screen.getByRole('row', { name: 'View utilities 2026-03' })).not.toHaveAttribute('tabindex')
  expect(screen.queryByRole('menuitem', { name: 'Add month' })).not.toBeInTheDocument()
})
