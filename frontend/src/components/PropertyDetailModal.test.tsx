import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssetSummary, PropertyValuation } from '../contracts/assets'
import type { ValueTrendPoint } from './charts'
import { PropertyDetailModal } from './PropertyDetailModal'

vi.mock('./charts', () => ({
  ValueTrendChart: ({ points }: { points: ValueTrendPoint[] }) => (
    <div data-testid="value-trend-chart" data-points={JSON.stringify(points)} />
  ),
}))

const property: AssetSummary = {
  id: 'property-1', name: 'Home', total_cost: 100000, original_total_cost: 100000,
  valuation_date: '2025-01-01', depreciation_rate: -0.01, depreciation_enabled: true,
  projects_enabled: false, utilities_enabled: false, expenses_enabled: false,
}
const valuations: PropertyValuation[] = [
  { id: 'valuation-1', value: 95000, effective_date: '2025-06-01' },
]

function chartPoints(): ValueTrendPoint[] {
  return JSON.parse(screen.getByTestId('value-trend-chart').getAttribute('data-points') ?? '[]')
}

function setup(options: { presentation?: 'inline' | 'modal'; initialMode?: 'view' | 'edit' } = {}) {
  const onSave = vi.fn().mockResolvedValue(true)
  const onListValuations = vi.fn().mockResolvedValue(valuations)
  render(<PropertyDetailModal
    property={property} projects={[]} currency="USD" saving={false}
    onClose={vi.fn()} onSave={onSave} onListValuations={onListValuations} {...options}
  />)
  return { user: userEvent.setup(), onSave, onListValuations }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-02-15T12:00:00Z'))
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('PropertyDetailModal forecasts', () => {
  it.each(['modal', 'inline'] as const)('defaults to history and toggles generated projections in %s view', async (presentation) => {
    const { user, onSave } = setup({ presentation })
    await waitFor(() => expect(chartPoints()).toContainEqual(expect.objectContaining({ period: '2025-06', value: 95000 })))
    const historicalPoints = chartPoints()
    const forecast = screen.getByRole('switch', { name: 'Forecast' })
    expect(forecast).not.toBeChecked()
    expect(forecast).toHaveClass('app-filter-toggle--compact')
    expect(historicalPoints.length).toBeGreaterThan(0)
    expect(historicalPoints.every((point) => !point.projected)).toBe(true)
    await user.click(forecast)
    expect(chartPoints().some((point) => point.projected)).toBe(true)
    await user.click(forecast)
    expect(chartPoints()).toEqual(historicalPoints)
    expect(onSave).not.toHaveBeenCalled()
    if (presentation === 'inline') expect(screen.getByRole('region', { name: 'Value history' })).toHaveTextContent('95,000')
  })

  it('filters the edit preview without removing configured valuations or depreciation settings', async () => {
    const { user, onSave } = setup({ initialMode: 'edit' })
    await waitFor(() => expect(chartPoints()).toContainEqual(expect.objectContaining({ period: '2025-06', value: 95000 })))
    expect(chartPoints().every((point) => !point.projected)).toBe(true)
    expect(screen.getByLabelText('Monthly change %')).toHaveValue(-1)
    await user.click(screen.getByRole('switch', { name: 'Forecast' }))
    expect(chartPoints().some((point) => point.projected)).toBe(true)
    await user.click(screen.getByRole('switch', { name: 'Forecast' }))
    await user.click(screen.getByRole('button', { name: 'Save property' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      depreciation_rate: -0.01, depreciation_enabled: true, total_cost: 100000,
    })))
    expect(valuations).toEqual([{ id: 'valuation-1', value: 95000, effective_date: '2025-06-01' }])
  })
})
