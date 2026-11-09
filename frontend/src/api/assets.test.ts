import { afterEach, expect, it, vi } from 'vitest'
import { assetsApi } from './assets'
import { API_BASE } from './http'

afterEach(() => vi.unstubAllGlobals())

it('gets daily holding prices through the authenticated household asset endpoint', async () => {
  const response = { prices: [{ ticker: 'BRK-B', currency: 'USD', close: 500.25, price_date: '2026-11-03', fetched_at: '2026-11-04T12:00:00Z', stale: true, error: 'Provider unavailable' }] }
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => response })
  vi.stubGlobal('fetch', fetchMock)
  expect(await assetsApi.getHoldingPrices('test-token', 'brokerage')).toEqual(response)
  expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/household/assets/brokerage/holding-prices`, expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }))
})
