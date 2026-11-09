import type { AssetSummary } from '../../contracts/assets'
import { PropertySummary } from '../properties/PropertySummary'
import { investedTickers } from './model'
import { useHoldingPrices } from './queries'
import { stockValuation } from './stockValuation'
import '../../styles/features/property-summary.css'

interface AccountSummaryProps {
  asset: AssetSummary
  currency: string
  token: string
}

export function AccountSummary({ asset, currency, token }: AccountSummaryProps) {
  if (asset.account_type !== 'stocks') {
    return <PropertySummary property={asset} currency={currency} token={token} loans={[]} utilities={false} showCosts={false} label="Account summary" />
  }
  return <StockAccountSummary asset={asset} token={token} />
}

function StockAccountSummary({ asset, token }: Pick<AccountSummaryProps, 'asset' | 'token'>) {
  const prices = useHoldingPrices(token, asset)
  const valuation = stockValuation(asset.holdings ?? [], prices.data?.prices ?? [])
  const hasTickers = investedTickers(asset).length > 0
  const loading = hasTickers && prices.isPending && prices.isFetching
  const stale = valuation.stale || Boolean(prices.data && (prices.isError || prices.isStale))

  return (
    <section aria-label="Account summary" className="property-summary property-summary--single">
      <div className="property-summary__item property-summary__item--valuation">
        <div className="property-summary__heading">
          <span className="property-summary__label">Valuation</span>
          <span className="property-summary__scope">USD market value</span>
        </div>
        <div aria-live="polite" aria-busy={loading}>
          {loading ? (
            <p className="property-summary__state" role="status">Loading market valuation...</p>
          ) : valuation.total === null ? (
            <p className={`property-summary__state${prices.isError ? ' property-summary__state--error' : ''}`} role={prices.isError ? 'alert' : 'status'}>
              Unavailable. {prices.isError ? 'Price request failed. ' : ''}
              {valuation.missing} open holding(s) missing a ticker, quantity or USD quote.
            </p>
          ) : (
            <>
              <strong className="property-summary__amount">USD {valuation.total.toFixed(2)}</strong>
              <p className="property-summary__state" role="status">
                {stale ? 'Stale valuation - last available quotes.' : 'Latest available daily closing prices.'}
                {prices.isError ? ' Price refresh failed.' : ''}
                {prices.isFetching ? ' Refreshing prices...' : ''}
              </p>
            </>
          )}
          {hasTickers && !loading ? (
            <p className="property-summary__state">
              <button type="button" disabled={prices.isFetching} onClick={() => void prices.refetch()}>
                {prices.isError ? 'Retry valuation' : 'Refresh valuation'}
              </button>
            </p>
          ) : null}
        </div>
      </div>
    </section>
  )
}
