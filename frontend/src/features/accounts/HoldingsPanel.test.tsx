import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountHolding, AssetSummary } from '../../contracts/assets'
import { api } from '../../lib/api'
import { HoldingsPanel } from './HoldingsPanel'

const { setError, setMessage } = vi.hoisted(() => ({ setError: vi.fn(), setMessage: vi.fn() }))
vi.mock('../../lib/session', () => ({ useSession: () => ({ token: 'session', setError, setMessage }) }))
vi.mock('../../lib/api', () => ({ api: { updateAsset: vi.fn(), getHoldingPrices: vi.fn() } }))

const lot: AccountHolding = {
  id: 'lot', name: 'Index fund', value: 100, quantity: 2, unit_price: 50,
  purchased_on: '2026-01-01', sold_on: null, sell_value: null, notes: 'Keep me',
}
const asset: AssetSummary = {
  id: 'brokerage', name: 'Retirement portfolio', kind: 'asset', category: 'account',
  account_type: 'stocks', account_registration: 'retirement', total_cost: 1000,
  valuation_date: '2026-02-01', notes: 'Account notes', holdings: [lot],
}

function setup(holdings = asset.holdings, accountType: AssetSummary['account_type'] = 'savings') {
  const onSaved = vi.fn()
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><HoldingsPanel asset={{ ...asset, holdings, account_type: accountType }} currency="EUR" onSaved={onSaved} /></QueryClientProvider>)
  return { onSaved, user: userEvent.setup() }
}

describe('HoldingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.updateAsset).mockResolvedValue(asset)
  })

  it('shows known realized P/L without treating an unknown sale value as a loss', () => {
    setup([
      lot,
      { ...lot, id: 'sold', name: 'Sold lot', value: 80, sell_value: 120 },
      { ...lot, id: 'unknown', name: 'Unpriced sale', sold_on: '2026-02-02' },
    ])
    expect(screen.getByLabelText('Open holdings value')).toHaveTextContent('100')
    expect(screen.getByLabelText('Realized profit and loss')).toHaveTextContent('40')
    expect(within(screen.getByRole('row', { name: /Unpriced sale/ })).getAllByRole('cell')[4]).toHaveTextContent('—')
    expect(within(screen.getByRole('row', { name: /Index fund/ })).getAllByRole('cell')[4]).toHaveTextContent('—')
  })

  it('validates an empty draft then adds a lot without dropping existing holdings or account metadata', async () => {
    const { user, onSaved } = setup()
    await user.click(screen.getByRole('button', { name: 'Add holding' }))
    const dialog = screen.getByRole('dialog', { name: 'Add holding' })
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(api.updateAsset).not.toHaveBeenCalled()
    expect(within(dialog).getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true')
    expect(within(dialog).getByText('Value is required.')).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText('Name'), 'New shares')
    await user.type(within(dialog).getByLabelText('Value'), '200')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(api.updateAsset).toHaveBeenCalledWith('session', asset.id, expect.objectContaining({
      name: asset.name, total_cost: 1000, category: 'account', account_type: 'savings',
      account_registration: 'retirement', notes: 'Account notes',
      holdings: [expect.objectContaining({ name: lot.name, value: 100, notes: 'Keep me' }),
        expect.objectContaining({ name: 'New shares', value: 200, quantity: null, sell_value: null })],
    }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(asset))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps an unsuccessful edit draft and retries with sale fields while preserving other lots', async () => {
    vi.mocked(api.updateAsset).mockRejectedValueOnce(new Error('Save unavailable'))
    const { user } = setup([lot, { ...lot, id: 'other', name: 'Other lot' }])
    await user.click(screen.getByRole('button', { name: 'Edit Index fund' }))
    const dialog = screen.getByRole('dialog', { name: 'Index fund' })
    expect(within(dialog).getByLabelText('Notes')).toHaveValue('Keep me')
    fireEvent.change(within(dialog).getByLabelText('Sold'), { target: { value: '2026-02-01' } })
    await user.type(within(dialog).getByLabelText('Sell value'), '125')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(setError).toHaveBeenCalledWith('Save unavailable'))
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Sell value')).toHaveValue('125')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(api.updateAsset).toHaveBeenLastCalledWith('session', asset.id, expect.objectContaining({
      holdings: [expect.objectContaining({ name: lot.name, sold_on: '2026-02-01', sell_value: 125 }),
        expect.objectContaining({ name: 'Other lot', sell_value: null })],
    }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('requires a hold to delete and sends only the remaining lots', async () => {
    setup([lot, { ...lot, id: 'other', name: 'Other lot' }])
    const button = screen.getByRole('button', { name: 'Delete Index fund' })
    fireEvent.click(button)
    expect(api.updateAsset).not.toHaveBeenCalled()
    let frame: FrameRequestCallback | undefined
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frame = callback; return 1 })
    const now = vi.spyOn(performance, 'now')
    now.mockReturnValue(100)
    fireEvent.keyDown(button, { key: 'Enter' })
    now.mockReturnValue(2200)
    await act(async () => { frame?.(2200) })
    expect(api.updateAsset).toHaveBeenCalledWith('session', asset.id, expect.objectContaining({
      holdings: [expect.objectContaining({ name: 'Other lot' })],
    }))
    expect(setMessage).toHaveBeenCalledWith('Holding deleted.')
    vi.restoreAllMocks()
  })

  it('prevents overlapping replace-all mutations while saving', async () => {
    let finish: ((value: AssetSummary) => void) | undefined
    vi.mocked(api.updateAsset).mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const { user } = setup()
    await user.click(screen.getByRole('button', { name: 'Edit Index fund' }))
    const form = screen.getByRole('dialog').querySelector('form')
    if (!form) throw new Error('Holding editor form is missing')
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(api.updateAsset).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Add holding' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Edit Index fund' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete Index fund' })).toBeDisabled()
    await act(async () => finish?.(asset))
  })
})

describe('daily closing prices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.updateAsset).mockResolvedValue(asset)
  })

  it('prices invested ticker lots in USD, retains stale metadata and leaves sold/manual lots unpriced', async () => {
    vi.mocked(api.getHoldingPrices).mockResolvedValue({ prices: [{ ticker: 'VTI', currency: 'USD', close: 0.2, price_date: '2026-11-03', fetched_at: '2026-11-04T12:30:00Z', stale: true, error: 'Yahoo temporarily unavailable' }] })
    setup([{ ...lot, ticker: 'VTI', quantity: 0.1 }, { ...lot, id: 'unknown', name: 'Unknown quantity', ticker: 'VTI', quantity: null }, { ...lot, id: 'sold', name: 'Sold stock', ticker: 'VTI', sell_value: 0 }, { ...lot, id: 'cash', name: 'Cash' }], 'stocks')
    expect(screen.getByRole('status')).toHaveTextContent('Loading daily closing prices')
    expect(await screen.findAllByText('Close: USD 0.20')).toHaveLength(2)
    expect(screen.getByText('Market value: USD 0.02')).toBeInTheDocument()
    expect(screen.getByText('Market value: Unknown')).toBeInTheDocument()
    expect(screen.getAllByText(/Trading date:/)).toHaveLength(2)
    expect(screen.getAllByText(/last successful close retained/)).toHaveLength(2)
    expect(screen.getByText('Sold - not priced')).toBeInTheDocument()
    expect(screen.getByText('Manual - no ticker')).toBeInTheDocument()
    expect(screen.getByLabelText('Open holdings value')).toHaveTextContent('Cost basis')
    expect(screen.queryByText(/Latest completed US trading day/)).not.toBeInTheDocument()
    expect(api.getHoldingPrices).toHaveBeenCalledWith('session', asset.id)
  })
  it('saves a normalized class ticker and preserves tickers in unrelated replacement rows', async () => {
    vi.mocked(api.getHoldingPrices).mockResolvedValue({ prices: [] })
    const { user } = setup([{ ...lot, ticker: 'VTI' }], 'stocks')
    await user.click(screen.getByRole('button', { name: 'Add holding' }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByLabelText('Name')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(within(dialog).getByText('Ticker is required.')).toBeInTheDocument()
    expect(api.updateAsset).not.toHaveBeenCalled()
    await user.type(within(dialog).getByLabelText('Value'), '50')
    await user.type(within(dialog).getByLabelText('US ticker'), 'brk-b')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(api.updateAsset).toHaveBeenCalledWith('session', asset.id, expect.objectContaining({ holdings: [expect.objectContaining({ ticker: 'VTI' }), expect.objectContaining({ ticker: 'BRK-B', name: 'BRK-B' })], total_cost: 1000 }))
  })
  it('never requests prices for sold-only or manual holdings', () => {
    vi.mocked(api.getHoldingPrices).mockClear()
    setup([{ ...lot, id: 'sold', ticker: 'VTI', sold_on: '2026-02-01' }, lot])
    expect(api.getHoldingPrices).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Refresh prices' })).not.toBeInTheDocument()
  })
})
