import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountHolding, AssetSummary, HoldingPrice } from '../../contracts/assets'
import { api } from '../../lib/api'
import { AccountSummary } from './AccountSummary'
import { investedTickers } from './model'
import { stockValuation } from './stockValuation'

vi.mock('../../lib/api', () => ({ api: { getHoldingPrices: vi.fn() } }))

const holding: AccountHolding = { id: 'lot', name: 'Stock', ticker: 'VTI', quantity: 2, value: 100 }
const asset: AssetSummary = {
  id: 'brokerage', name: 'Portfolio', category: 'account', account_type: 'stocks',
  total_cost: 0, valuation_date: '2026-11-01', holdings: [holding],
}
const quote: HoldingPrice = {
  ticker: 'VTI', currency: 'USD', close: 12.345, price_date: '2026-11-03',
  fetched_at: '2026-11-04T12:00:00Z', stale: false, error: null,
}

function setup(account = asset, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(<QueryClientProvider client={client}><AccountSummary asset={account} token="session" currency="EUR" /></QueryClientProvider>)
  return client
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getHoldingPrices).mockResolvedValue({ prices: [quote] })
})

describe('AccountSummary', () => {
  it('values a zero-manual-total stock account from quotes in USD, without FX', async () => {
    setup()
    expect(screen.getByRole('status')).toHaveTextContent('Loading market valuation')
    expect(await screen.findByText('USD 24.69')).toBeInTheDocument()
    expect(screen.getByText('Latest available daily closing prices.')).toBeInTheDocument()
    expect(api.getHoldingPrices).toHaveBeenCalledWith('session', asset.id)
    expect(asset.total_cost).toBe(0)
  })

  it('excludes sale-date and zero-proceeds sold lots', async () => {
    setup({ ...asset, holdings: [holding, { ...holding, id: 'sale-date', sold_on: '2026-11-01' }, { ...holding, id: 'sale-zero', sell_value: 0 }] })
    expect(await screen.findByText('USD 24.69')).toBeInTheDocument()
  })

  it.each([
    { ...holding, ticker: null },
    { ...holding, quantity: null },
    { ...holding, ticker: 'MISSING' },
  ])('does not present an incomplete portfolio as a complete or zero valuation: %j', async (missing) => {
    setup({ ...asset, total_cost: 999, holdings: [holding, { ...missing, id: 'missing' }] })
    expect(await screen.findByText(/Unavailable\. 1 open holding/)).toBeInTheDocument()
    expect(screen.queryByText('USD 24.69')).not.toBeInTheDocument()
    expect(screen.queryByText(/999/)).not.toBeInTheDocument()
  })

  it('marks usable retained quotes as stale, not fresh', async () => {
    vi.mocked(api.getHoldingPrices).mockResolvedValue({ prices: [{ ...quote, stale: true, error: 'Provider unavailable' }] })
    setup()
    expect(await screen.findByText('USD 24.69')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Stale valuation')
  })

  it('reports an unavailable quote and request failure separately from loading', async () => {
    vi.mocked(api.getHoldingPrices).mockRejectedValue(new Error('Offline'))
    setup()
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toHaveTextContent('Unavailable. Price request failed.')
    expect(screen.getByRole('button', { name: 'Retry valuation' })).toBeEnabled()
    expect(screen.queryByText('USD 0.00')).not.toBeInTheDocument()
  })

  it('uses the existing price cache and identifies an aged cached valuation', () => {
    const client = new QueryClient()
    client.setQueryData(['holding-prices', 'session', asset.id, investedTickers(asset)], { prices: [quote] }, { updatedAt: Date.now() - 6 * 60 * 1000 })
    vi.mocked(api.getHoldingPrices).mockReturnValue(new Promise(() => {}))
    setup(asset, client)
    expect(screen.getByText('USD 24.69')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Stale valuation')
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing prices')
  })

  it('retains cached valuation as stale when a refresh fails', async () => {
    const client = new QueryClient()
    client.setQueryData(['holding-prices', 'session', asset.id, investedTickers(asset)], { prices: [quote] }, { updatedAt: Date.now() - 6 * 60 * 1000 })
    vi.mocked(api.getHoldingPrices).mockRejectedValue(new Error('Offline'))
    setup(asset, client)
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Price refresh failed.'), { timeout: 4000 })
    expect(screen.getByText('USD 24.69')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Stale valuation')
  })

  it('does not request sold-only prices and shows a genuine empty open portfolio as zero', () => {
    setup({ ...asset, holdings: [{ ...holding, sell_value: 0 }] })
    expect(screen.getByText('USD 0.00')).toBeInTheDocument()
    expect(api.getHoldingPrices).not.toHaveBeenCalled()
  })

  it.each(['savings', 'options'] as const)('keeps the manual PropertySummary valuation for %s accounts', (accountType) => {
    setup({ ...asset, account_type: accountType, total_cost: 123.45 })
    expect(screen.getByLabelText('Account summary')).toHaveTextContent('€123')
    expect(screen.getByLabelText('Account summary')).toHaveTextContent('€')
    expect(screen.queryByText('USD market value')).not.toBeInTheDocument()
    expect(api.getHoldingPrices).not.toHaveBeenCalled()
  })
})

describe('stockValuation', () => {
  it('aggregates exact decimal products before rounding the total', () => {
    const result = stockValuation([{ ...holding, quantity: 0.1 }, { ...holding, id: 'second', quantity: 0.1 }], [{ ...quote, close: 0.05 }])
    expect(result.total?.toString()).toBe('0.01')
    expect(result.total?.toFixed(2)).toBe('0.01')
  })

  it('accepts a real zero close but not a missing one', () => {
    expect(stockValuation([holding], [{ ...quote, close: 0 }]).total?.toFixed(2)).toBe('0.00')
    expect(stockValuation([holding], [{ ...quote, close: null }]).total).toBeNull()
  })
})
