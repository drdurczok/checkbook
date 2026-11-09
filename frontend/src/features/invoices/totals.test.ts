import { describe, expect, it } from 'vitest'
import { invoiceTotals } from './totals'

const noConversion = { enabled: false, currency: '', rate: 1 }

describe('invoiceTotals', () => {
  it('matches the domain line-based midpoint-away-from-zero rounding', () => {
    const totals = invoiceTotals([
      { quantity: '1', unit_price: '0.025', vat_rate: '23' },
      { quantity: '1', unit_price: '0.025', vat_rate: '23' },
    ], noConversion)

    expect(totals).toEqual({
      net: 0.06,
      vat: 0.02,
      gross: 0.08,
      byRate: { 23: { net: 0.06, vat: 0.02 } },
    })
  })

  it('applies conversion only to lines quoted in the conversion currency', () => {
    const totals = invoiceTotals([
      { quantity: '2', unit_price: '10', vat_rate: '0', currency: 'EUR' },
      { quantity: '1', unit_price: '10', vat_rate: '0', currency: 'PLN' },
    ], { enabled: true, currency: 'EUR', rate: '4.5' })

    expect(totals.net).toBe(100)
    expect(totals.gross).toBe(100)
  })
})
