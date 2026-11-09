import type { AccountHolding, HoldingPrice } from '../../contracts/assets'
import { fmtDate } from '../../lib/format'
import { holdingMarketValue } from './model'
import Decimal from 'decimal.js'

const formatUsd = (value: Decimal.Value) => `USD ${new Decimal(value).toFixed(2)}`
const formatClose = (value: number) => `USD ${new Decimal(value).toFixed(Math.max(2, new Decimal(value).decimalPlaces()))}`

export function HoldingQuote({ holding, price, failed }: {
  holding: AccountHolding
  price?: HoldingPrice
  failed: boolean
}) {
  const value = holdingMarketValue(holding, price?.close ?? null)
  const stale = price?.stale || failed
  return <div className="holding-quote">
    <span>Close: {price?.close != null ? formatClose(price.close) : 'Unavailable'}</span>
    <span>Market value: {value != null ? formatUsd(value) : 'Unknown'}</span>
    {holding.quantity == null ? <small>Quantity needed for market value</small> : null}
    {price?.price_date ? <small>Trading date: {fmtDate(price.price_date)}</small> : null}
    {price?.fetched_at ? <small>Last successful fetch: <time dateTime={price.fetched_at}>{new Date(price.fetched_at).toLocaleString()}</time></small> : null}
    {stale ? <strong className="holding-quote__stale">Stale{price?.close != null ? ' - last successful close retained' : ''}</strong> : null}
    {price?.error ? <small role="status">{price.error}</small> : null}
  </div>
}
