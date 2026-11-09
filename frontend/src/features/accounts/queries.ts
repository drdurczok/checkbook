import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import type { AssetSummary } from '../../contracts/assets'
import { investedTickers } from './model'

export function useHoldingPrices(token: string, asset: AssetSummary) {
  const tickers = investedTickers(asset)
  return useQuery({
    queryKey: ['holding-prices', token, asset.id, tickers],
    enabled: Boolean(token) && tickers.length > 0,
    queryFn: () => api.getHoldingPrices(token, asset.id),
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: 1,
    refetchOnWindowFocus: true,
    refetchInterval: 15 * 60 * 1000,
  })
}
