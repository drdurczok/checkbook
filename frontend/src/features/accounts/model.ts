import Decimal from 'decimal.js'
import type {
  AccountHolding,
  AccountRegistration,
  AccountType,
  AssetSummary,
} from '../../contracts/assets'
import { numericAmount } from '../../lib/format'

/** Editable form draft of a single holding; every free-text field is a string. */
export type HoldingDraft = {
  name: string
  ticker: string
  quantity: string
  unit_price: string
  value: string
  purchased_on: string
  sold_on: string
  sell_value: string
  notes: string
}

export type HoldingDraftErrors = Partial<
  Record<'name' | 'ticker' | 'quantity' | 'unit_price' | 'value' | 'sell_value' | 'sold_on', string>
>

export const emptyHoldingDraft = (): HoldingDraft => ({
  name: '',
  ticker: '',
  quantity: '',
  unit_price: '',
  value: '',
  purchased_on: '',
  sold_on: '',
  sell_value: '',
  notes: '',
})

export const draftFromHolding = (holding: AccountHolding): HoldingDraft => ({
  name: holding.name,
  ticker: holding.ticker ?? '',
  quantity: holding.quantity != null ? String(holding.quantity) : '',
  unit_price: holding.unit_price != null ? String(holding.unit_price) : '',
  value: String(holding.value ?? ''),
  purchased_on: holding.purchased_on ?? '',
  sold_on: holding.sold_on ?? '',
  sell_value: holding.sell_value != null ? String(holding.sell_value) : '',
  notes: holding.notes ?? '',
})

/** Stock names come from the required ticker; other accounts require a name.
 * Amount and date validation mirrors the API's holding rules. */
export function validateHoldingDraft(draft: HoldingDraft, accountType?: AccountType | null): HoldingDraftErrors {
  const errors: HoldingDraftErrors = {}
  if (draft.ticker.trim() && (normalizeTicker(draft.ticker).length > 15 || !/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/.test(normalizeTicker(draft.ticker)))) {
    errors.ticker = 'Enter a US ticker, for example AAPL or BRK-B.'
  }
  if (accountType === 'stocks' && !draft.ticker.trim()) {
    errors.ticker = 'Ticker is required.'
  }
  if (accountType !== 'stocks' && !draft.name.trim()) {
    errors.name = 'Name is required.'
  }
  if (!draft.value.trim()) {
    errors.value = 'Value is required.'
  } else if (numericAmount(draft.value) < 0) {
    errors.value = 'Value cannot be negative.'
  }
  if (draft.quantity.trim() && numericAmount(draft.quantity) <= 0) {
    errors.quantity = 'Quantity must be greater than zero.'
  }
  if (draft.unit_price.trim() && numericAmount(draft.unit_price) < 0) {
    errors.unit_price = 'Unit price cannot be negative.'
  }
  if (draft.sell_value.trim() && numericAmount(draft.sell_value) < 0) {
    errors.sell_value = 'Sell value cannot be negative.'
  }
  for (const field of ['value', 'quantity', 'unit_price', 'sell_value'] as const) {
    const text = draft[field].replace(/\s/g, '').replace(',', '.')
    if (text && (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) || !Number.isFinite(Number(text)))) {
      errors[field] = 'Enter a valid amount.'
    }
  }
  if (draft.purchased_on && draft.sold_on && draft.sold_on < draft.purchased_on) {
    errors.sold_on = 'Sell date cannot be before the purchase date.'
  }
  return errors
}

export const hasHoldingErrors = (errors: HoldingDraftErrors) => Object.keys(errors).length > 0

/** Transport shape for one holding; ids are assigned server-side. */
export function holdingPayloadFromDraft(draft: HoldingDraft, accountType?: AccountType | null): Omit<AccountHolding, 'id'> {
  return {
    name: accountType === 'stocks' ? normalizeTicker(draft.ticker) : draft.name.trim(),
    ticker: normalizeTicker(draft.ticker) || null,
    quantity: draft.quantity.trim() ? numericAmount(draft.quantity) : null,
    unit_price: draft.unit_price.trim() ? numericAmount(draft.unit_price) : null,
    value: numericAmount(draft.value),
    purchased_on: draft.purchased_on || null,
    sold_on: draft.sold_on || null,
    sell_value: draft.sell_value.trim() ? numericAmount(draft.sell_value) : null,
    notes: draft.notes,
  }
}

/** A closed lot has been exited: it carries a sale date or a sale value. */
export const isClosedHolding = (holding: AccountHolding) =>
  holding.sold_on != null || holding.sell_value != null

export function splitHoldings(holdings: AccountHolding[]): {
  open: AccountHolding[]
  closed: AccountHolding[]
} {
  const open: AccountHolding[] = []
  const closed: AccountHolding[] = []
  for (const holding of holdings) {
    if (isClosedHolding(holding)) {
      closed.push(holding)
    } else {
      open.push(holding)
    }
  }
  return { open, closed }
}

/** A sale date alone does not establish proceeds or a realized loss. */
export const holdingProfit = (holding: AccountHolding): number | null =>
  holding.sell_value == null ? null : new Decimal(holding.sell_value).minus(holding.value).toNumber()

export const totalProfit = (holdings: AccountHolding[]) =>
  holdings.reduce((total, holding) => holding.sell_value == null
    ? total
    : total.plus(new Decimal(holding.sell_value).minus(holding.value)), new Decimal(0)).toNumber()

/** Sum of the still-open lots' values, shown beside the account's stated total. */
export const openHoldingsValue = (holdings: AccountHolding[]) =>
  holdings.reduce((total, holding) => total.plus(holding.value), new Decimal(0)).toNumber()

/** Full update payload for an account save. Holdings use replace-all
 * semantics, so the complete list is sent on every save. */
export function accountAssetPayload(
  asset: AssetSummary,
  changes: {
    name?: string
    total_cost?: number
    started_on?: string | null
    ended_on?: string | null
    valuation_date?: string
    notes?: string
    account_type?: AccountType
    account_registration?: AccountRegistration
    /** Existing rows carry ids; freshly drafted ones do not yet. */
    holdings?: Array<AccountHolding | Omit<AccountHolding, 'id'>>
  } = {},
) {
  const holdings = changes.holdings ?? asset.holdings ?? []
  return {
    name: changes.name ?? asset.name,
    total_cost: changes.total_cost ?? asset.total_cost,
    valuation_date: changes.valuation_date ?? asset.valuation_date,
    started_on: changes.started_on !== undefined ? changes.started_on : asset.started_on ?? null,
    ended_on: changes.ended_on !== undefined ? changes.ended_on : asset.ended_on ?? null,
    notes: changes.notes ?? asset.notes ?? '',
    category: 'account' as const,
    account_type: changes.account_type ?? asset.account_type ?? 'savings',
    account_registration:
      changes.account_registration ?? asset.account_registration ?? 'regular',
    holdings: holdings.map((holding) => ({
      name: holding.name,
      ticker: holding.ticker ?? null,
      quantity: holding.quantity ?? null,
      unit_price: holding.unit_price ?? null,
      value: holding.value,
      purchased_on: holding.purchased_on ?? null,
      sold_on: holding.sold_on ?? null,
      sell_value: holding.sell_value ?? null,
      notes: holding.notes,
    })),
    details: asset.details ?? {},
  }
}

export const normalizeTicker = (ticker: string) => ticker.trim().toUpperCase()

export function investedTickers(asset: AssetSummary): string[] {
  if (asset.category !== 'account' || asset.account_type !== 'stocks') return []
  return [...new Set((asset.holdings ?? [])
    .filter((holding) => !isClosedHolding(holding) && holding.ticker?.trim())
    .map((holding) => normalizeTicker(holding.ticker ?? '')))].sort()
}

/** Keep multiplication exact until formatting; a missing quantity is not zero. */
export function holdingMarketValue(holding: AccountHolding, close: number | null): Decimal | null {
  return isClosedHolding(holding) || holding.quantity == null || close == null
    ? null
    : new Decimal(holding.quantity).times(close)
}
