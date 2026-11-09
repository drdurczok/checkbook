import Decimal from 'decimal.js'
import type { AccountHolding, HoldingPrice } from '../../contracts/assets'
import { isClosedHolding, normalizeTicker } from './model'

/** No manual-value fallback: an incomplete portfolio is not a zero valuation. */
export function stockValuation(holdings: AccountHolding[], prices: HoldingPrice[]) {
  const open = holdings.filter((holding) => !isClosedHolding(holding))
  const quotes = new Map(prices.map((price) => [normalizeTicker(price.ticker), price]))
  let total = new Decimal(0)
  let missing = 0
  let stale = false
  for (const holding of open) {
    const quote = quotes.get(normalizeTicker(holding.ticker ?? ''))
    if (!holding.ticker?.trim() || holding.quantity == null ||
      !Number.isFinite(holding.quantity) || holding.quantity <= 0 ||
      !quote || quote.currency !== 'USD' || quote.close == null ||
      !Number.isFinite(quote.close) || quote.close < 0) {
      missing += 1
      continue
    }
    total = total.plus(new Decimal(holding.quantity).times(quote.close))
    stale ||= quote.stale || Boolean(quote.error)
  }
  return { total: missing ? null : total, missing, stale }
}
