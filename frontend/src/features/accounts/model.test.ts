import { describe, expect, it } from 'vitest'
import type { AccountHolding, AssetSummary } from '../../contracts/assets'
import {
  accountAssetPayload,
  draftFromHolding,
  emptyHoldingDraft,
  hasHoldingErrors,
  holdingPayloadFromDraft,
  isClosedHolding,
  normalizeTicker,
  investedTickers,
  holdingMarketValue,
  openHoldingsValue,
  splitHoldings,
  totalProfit,
  validateHoldingDraft,
} from './model'

const holding = (overrides: Partial<AccountHolding> = {}): AccountHolding => ({
  id: 'holding-1',
  name: 'VTI lot',
  quantity: 10,
  unit_price: 250,
  value: 2500,
  purchased_on: '2026-01-15',
  ...overrides,
})

describe('emptyHoldingDraft', () => {
  it('starts with blank strings for every field', () => {
    expect(emptyHoldingDraft()).toEqual({
      name: '', ticker: '', quantity: '', unit_price: '', value: '',
      purchased_on: '', sold_on: '', sell_value: '', notes: '',
    })
  })
})

describe('validateHoldingDraft', () => {
  it('uses the normalized ticker as the stock name and requires no separate name', () => {
    const draft = { ...emptyHoldingDraft(), ticker: ' brk-b ', name: 'Old label', value: '100' }
    expect(validateHoldingDraft({ ...draft, name: '' }, 'stocks')).toEqual({})
    expect(validateHoldingDraft({ ...draft, ticker: '' }, 'stocks').ticker).toBe('Ticker is required.')
    expect(holdingPayloadFromDraft(draft, 'stocks')).toMatchObject({ name: 'BRK-B', ticker: 'BRK-B' })
    expect(holdingPayloadFromDraft({ ...draft, ticker: ' vti ' }, 'stocks').name).toBe('VTI')
    expect(validateHoldingDraft({ ...draft, name: '' }, 'savings').name).toBe('Name is required.')
  })

  it('accepts a minimal open lot with only a name and value', () => {
    const errors = validateHoldingDraft({ ...emptyHoldingDraft(), name: 'Cash', value: '1000' })
    expect(errors).toEqual({})
    expect(hasHoldingErrors(errors)).toBe(false)
  })

  it('accepts zero values but not negative ones', () => {
    expect(validateHoldingDraft({ ...emptyHoldingDraft(), name: 'Zero', value: '0' })).toEqual({})
    expect(validateHoldingDraft({ ...emptyHoldingDraft(), name: 'Zero', value: '0', unit_price: '0', sell_value: '0' })).toEqual({})
    expect(validateHoldingDraft({ ...emptyHoldingDraft(), name: 'Neg', value: '-1' }).value).toBeDefined()
    expect(validateHoldingDraft({ ...emptyHoldingDraft(), name: 'Neg', value: '5', unit_price: '-2' }).unit_price).toBeDefined()
    expect(validateHoldingDraft({ ...emptyHoldingDraft(), name: 'Neg', value: '5', sell_value: '-2' }).sell_value).toBeDefined()
  })

  it('rejects malformed and non-finite amounts instead of coercing them to zero', () => {
    for (const value of ['abc', '.', '1.2.3', 'Infinity', '9'.repeat(400)]) {
      expect(validateHoldingDraft({ ...emptyHoldingDraft(), name: 'Lot', value }).value).toBeDefined()
    }
  })

  it('requires the name after trimming and the value', () => {
    const errors = validateHoldingDraft({ ...emptyHoldingDraft(), name: '   ', value: '' })
    expect(errors.name).toBeDefined()
    expect(errors.value).toBeDefined()
    expect(hasHoldingErrors(errors)).toBe(true)
  })

  it('requires quantity to be positive when present', () => {
    const base = { ...emptyHoldingDraft(), name: 'Lot', value: '100' }
    expect(validateHoldingDraft({ ...base, quantity: '0.5' }).quantity).toBeUndefined()
    expect(validateHoldingDraft({ ...base, quantity: '0' }).quantity).toBeDefined()
    expect(validateHoldingDraft({ ...base, quantity: '-3' }).quantity).toBeDefined()
    expect(validateHoldingDraft({ ...base }).quantity).toBeUndefined()
  })

  it('rejects a sell date before the purchase date and accepts equal dates', () => {
    const base = { ...emptyHoldingDraft(), name: 'Lot', value: '100', purchased_on: '2026-02-01' }
    expect(validateHoldingDraft({ ...base, sold_on: '2026-01-31' }).sold_on).toBeDefined()
    expect(validateHoldingDraft({ ...base, sold_on: '2026-02-01' }).sold_on).toBeUndefined()
    expect(validateHoldingDraft({ ...base, sold_on: '' }).sold_on).toBeUndefined()
  })
})

describe('holding drafts round-trip', () => {
  it('builds a payload from a draft, nulling absent optional fields', () => {
    expect(
      holdingPayloadFromDraft({ ...emptyHoldingDraft(), name: '  VTI  ', value: '2500.5' }),
    ).toEqual({
      name: 'VTI',
      ticker: null,
      quantity: null,
      unit_price: null,
      value: 2500.5,
      purchased_on: null,
      sold_on: null,
      sell_value: null,
      notes: '',
    })
  })

  it('seeds a draft from an existing holding', () => {
    expect(draftFromHolding(holding())).toEqual({
      name: 'VTI lot',
      ticker: '',
      quantity: '10',
      unit_price: '250',
      value: '2500',
      purchased_on: '2026-01-15',
      sold_on: '',
      sell_value: '',
      notes: '',
    })
  })
})

describe('splitHoldings', () => {
  it('splits open lots from closed ones (sold on or sold for something)', () => {
    const open = holding()
    const closedByDate = holding({ id: 'h2', sold_on: '2026-03-01' })
    const closedByValue = holding({ id: 'h3', sell_value: 2600 })
    const { open: openRows, closed } = splitHoldings([open, closedByDate, closedByValue])
    expect(openRows).toEqual([open])
    expect(closed).toEqual([closedByDate, closedByValue])
  })

  it('keeps an explicit zero sell value closed while empty lists stay empty', () => {
    expect(isClosedHolding(holding({ sell_value: 0 }))).toBe(true)
    expect(splitHoldings([])).toEqual({ open: [], closed: [] })
  })
})

describe('profit calculations', () => {
  const gain = holding({ id: 'gain', value: 2500, sell_value: 3000 })
  const loss = holding({ id: 'loss', value: 1200, sell_value: 900 })
  const noSaleProceeds = holding({ id: 'date-only', value: 500, sell_value: null, sold_on: '2026-04-01' })

  it('computes per-lot and total realized P/L for closed lots', () => {
    expect(totalProfit([gain, loss])).toBe(3000 - 2500 + 900 - 1200)
    expect(totalProfit([noSaleProceeds])).toBe(0)
    expect(totalProfit([])).toBe(0)
    expect(totalProfit([holding({ value: 0.1, sell_value: 0.3 }), holding({ value: 0.1, sell_value: 0.2 })])).toBe(0.3)
  })

  it('sums the open lots values for the account view', () => {
    expect(openHoldingsValue([gain, loss])).toBe(3700)
    expect(openHoldingsValue([])).toBe(0)
  })
})

describe('accountAssetPayload', () => {
  const asset: AssetSummary = {
    id: 'account-1',
    name: 'Brokerage',
    total_cost: 12000,
    valuation_date: '2026-01-01',
    category: 'account',
    account_type: 'stocks',
    account_registration: 'retirement',
    started_on: '2020-01-01',
    notes: 'keystone account',
    holdings: [holding()],
  }

  it('resends the whole asset with holdings stripped of their ids', () => {
    expect(accountAssetPayload(asset)).toEqual({
      name: 'Brokerage',
      total_cost: 12000,
      valuation_date: '2026-01-01',
      started_on: '2020-01-01',
      ended_on: null,
      notes: 'keystone account',
      category: 'account',
      account_type: 'stocks',
      account_registration: 'retirement',
      holdings: [{
        name: 'VTI lot',
        ticker: null,
        quantity: 10,
        unit_price: 250,
        value: 2500,
        purchased_on: '2026-01-15',
        sold_on: null,
        sell_value: null,
      }],
      details: {},
    })
  })

  it('applies overrides and defaults missing account fields', () => {
    const bare: AssetSummary = { id: 'account-2', name: 'Savings', total_cost: 500, valuation_date: '2026-02-02' }
    const payload = accountAssetPayload(bare, {
      name: 'Emergency savings',
      total_cost: 600,
      holdings: [holding({ id: 'x' }), holding({ id: 'y' })],
    })
    expect(payload.name).toBe('Emergency savings')
    expect(payload.total_cost).toBe(600)
    expect(payload.category).toBe('account')
    expect(payload.account_type).toBe('savings')
    expect(payload.account_registration).toBe('regular')
    expect(payload.holdings).toHaveLength(2)
    expect(payload.holdings.every((entry) => !('id' in entry))).toBe(true)
  })
})

describe('daily close valuation', () => {
  it('normalizes US symbols and class shares while allowing manual holdings', () => {
    expect(normalizeTicker(' brk-b ')).toBe('BRK-B')
    const draft = { ...emptyHoldingDraft(), name: 'Berkshire', value: '50', ticker: ' brk-b ' }
    expect(validateHoldingDraft(draft)).toEqual({})
    expect(holdingPayloadFromDraft(draft).ticker).toBe('BRK-B')
    for (const ticker of ['^GSPC', 'AAPL/L', 'AAPL USD', 'EURUSD=X', '123', 'AAPL.L', 'BRK.B', 'ABCDEFGHIJKLMNOP']) {
      expect(validateHoldingDraft({ ...draft, ticker }).ticker).toBeDefined()
    }
    expect(draftFromHolding(holding({ ticker: 'VTI' })).ticker).toBe('VTI')
  })
  it('requests distinct invested stock symbols only, never cash, options or sold lots', () => {
    const asset: AssetSummary = { id: 'a', name: 'Account', total_cost: 10, valuation_date: '2026-01-01', category: 'account', account_type: 'stocks', holdings: [
      holding({ ticker: 'brk-b' }), holding({ ticker: 'BRK-B' }), holding({ ticker: null }),
      holding({ ticker: 'VTI', sold_on: '2026-01-02' }), holding({ ticker: 'AAPL', sell_value: 0 }),
    ] }
    expect(investedTickers(asset)).toEqual(['BRK-B'])
    expect(investedTickers({ ...asset, account_type: 'options' })).toEqual([])
    expect(investedTickers({ ...asset, account_type: 'savings' })).toEqual([])
    expect(accountAssetPayload(asset).holdings[0].ticker).toBe('brk-b')
  })
  it('multiplies fractional quantity exactly without conflating unknown, sold or zero prices', () => {
    expect(holdingMarketValue(holding({ quantity: 0.1 }), 0.2)?.toString()).toBe('0.02')
    expect(holdingMarketValue(holding({ quantity: null }), 10)).toBeNull()
    expect(holdingMarketValue(holding(), null)).toBeNull()
    expect(holdingMarketValue(holding({ sell_value: 0 }), 10)).toBeNull()
    expect(holdingMarketValue(holding({ sold_on: '2026-01-02' }), 10)).toBeNull()
    expect(holdingMarketValue(holding(), 0)?.toString()).toBe('0')
  })
})
