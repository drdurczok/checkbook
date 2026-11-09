import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { SubjectUtilitiesPanel } from './SubjectUtilitiesPanel'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { emptyBoard } = vi.hoisted(() => ({ emptyBoard: { value: false } }))

vi.mock('../../lib/session', () => ({ useSession: () => ({ token: 'test', currency: 'PLN' }) }))
vi.mock('./queries', () => ({
  useUtilityBoardQuery: () => ({
    data: {
      subject: { tracked_fields: [{ key: 'water', label: 'Water', unit: 'm3' }, { key: 'power', label: 'Power', unit: 'kWh', retired: true, hidden: true }] },
      trend: [
        { period: '2026-10', values: { Water: 100 } },
        { period: '2026-11', values: { Water: 200 } },
      ],
      months: emptyBoard.value ? [] : [
        { month: '2026-10', total: 100, values: { water: { amount: 60 }, power: { amount: 40, usage_amount: 10 } } },
        { month: '2026-11', total: 200, values: { water: { amount: 120 }, power: { amount: 80, usage_amount: 20 } } },
      ],
    },
  }),
}))
vi.mock('../../components/charts', () => ({
  UtilityTrendChart: ({ points }: { points: { period: string }[] }) => <div data-testid="trend">{points.map((point) => point.period).join(',')}</div>,
}))
vi.mock('../../components/UtilitiesDetailsModal', () => ({
  UtilitiesDetailsModal: ({ points, categories }: { points: { period: string; total: number; usage: Record<string, number> }[]; categories: string[] }) => <div data-testid="details" data-categories={JSON.stringify(categories)} data-totals={JSON.stringify(points.map((point) => point.total))} data-usage={JSON.stringify(points.map((point) => point.usage))}>{points.map((point) => point.period).join(',')}</div>,
}))

afterEach(() => {
  vi.useRealTimers()
  emptyBoard.value = false
})

it('allows opening details to add the first month on an empty board', async () => {
  emptyBoard.value = true
  const user = userEvent.setup()
  render(<QueryClientProvider client={new QueryClient()}><SubjectUtilitiesPanel subject={{ type: 'property', id: 'home' }} /></QueryClientProvider>)
  const details = screen.getByRole('button', { name: 'Details' })
  expect(details).toBeEnabled()
  await user.click(details)
  expect(screen.getByTestId('details')).toBeInTheDocument()
})

it('shows all utility periods in chart and details without a Forecast toggle', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-15T12:00:00Z'))
  const user = userEvent.setup()
  render(<QueryClientProvider client={new QueryClient()}><SubjectUtilitiesPanel subject={{ type: 'property', id: 'home' }} /></QueryClientProvider>)
  expect(screen.queryByRole('switch', { name: 'Forecast' })).not.toBeInTheDocument()
  const header = screen.getByRole('heading', { name: 'Utilities' }).closest('header')
  expect(header).toContainElement(screen.getByRole('button', { name: 'Utility chart metric' }))
  expect(header).toContainElement(screen.getByRole('button', { name: 'Details' }))
  expect(screen.getByTestId('trend')).toHaveTextContent('2026-10,2026-11')
  await user.click(screen.getByRole('button', { name: 'Details' }))
  expect(screen.getByTestId('details')).toHaveTextContent('2026-10,2026-11')
  expect(screen.getByTestId('details')).toHaveAttribute('data-usage', '[{},{}]')
  expect(screen.getByTestId('details')).toHaveAttribute('data-categories', '["water"]')
  expect(screen.getByTestId('details')).toHaveAttribute('data-totals', '[100,200]')
})
