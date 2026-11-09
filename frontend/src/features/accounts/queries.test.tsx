import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PropsWithChildren } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssetSummary } from '../../contracts/assets'
import { api } from '../../lib/api'
import { useHoldingPrices } from './queries'

vi.mock('../../lib/api', () => ({ api: { getHoldingPrices: vi.fn() } }))
const asset: AssetSummary = { id: 'selected', name: 'Stocks', total_cost: 100, valuation_date: '2026-01-01', category: 'account', account_type: 'stocks', holdings: [{ id: 'lot', name: 'Apple', ticker: 'AAPL', value: 100 }] }
function wrapper() {
  const client = new QueryClient()
  return function Wrapper({ children }: PropsWithChildren) { return <QueryClientProvider client={client}>{children}</QueryClientProvider> }
}
beforeEach(() => vi.resetAllMocks())

describe('holding prices query', () => {
  it.each([
    { ...asset, account_type: 'savings' as const },
    { ...asset, account_type: 'options' as const },
    { ...asset, holdings: [{ ...{ id: 'lot', name: 'Apple', ticker: 'AAPL', value: 100 }, ticker: null }] },
    { ...asset, holdings: [{ ...{ id: 'lot', name: 'Apple', ticker: 'AAPL', value: 100 }, sold_on: '2026-02-01' }] },
    { ...asset, holdings: [{ ...{ id: 'lot', name: 'Apple', ticker: 'AAPL', value: 100 }, sell_value: 0 }] },
  ])('does not fetch for ineligible account/holdings %#', (ineligible) => {
    renderHook(() => useHoldingPrices('token', ineligible), { wrapper: wrapper() })
    expect(api.getHoldingPrices).not.toHaveBeenCalled()
  })
  it('retains successful quotes after refresh failure and supports explicit retry', async () => {
    const quotes = { prices: [{ ticker: 'AAPL', currency: 'USD' as const, close: 100, price_date: '2026-11-03', fetched_at: '2026-11-04T12:00:00Z', stale: false, error: null }] }
    vi.mocked(api.getHoldingPrices).mockResolvedValueOnce(quotes).mockRejectedValueOnce(new Error('Network unavailable')).mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValueOnce(quotes)
    const { result } = renderHook(() => useHoldingPrices('token', asset), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    await act(async () => { await result.current.refetch() })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.data).toEqual(quotes)
    await act(async () => { await result.current.refetch() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(api.getHoldingPrices).toHaveBeenLastCalledWith('token', 'selected')
  })
})
