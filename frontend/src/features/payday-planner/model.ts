import Decimal from 'decimal.js'

export function validPlannerAmount(value: string): boolean {
  return /^\d+(\.\d{1,2})?$/.test(value) && new Decimal(value).isFinite() && new Decimal(value).gte(0)
}
export function plannerMoney(value: string, currency: string): string {
  // Keep decimal strings exact; only the currency glyph comes from Intl.
  const symbol = new Intl.NumberFormat(undefined, { style: 'currency', currency }).formatToParts(0).find((part) => part.type === 'currency')?.value ?? currency
  const amount = new Decimal(value)
  return `${amount.isNegative() ? '-' : ''}${symbol}${amount.abs().toFixed(2)}`
}
/** Exact decimal digits without the currency glyph, for cards that show the
 * currency code separately (mirrors the loan cards' fmtNumber usage). */
export function plannerAmount(value: string): string {
  const amount = new Decimal(value)
  return `${amount.isNegative() ? '-' : ''}${amount.abs().toFixed(2)}`
}
export function plannerDifferenceTone(difference: string | null, percentage: string | null): string {
  if (difference === null || new Decimal(difference).isZero()) return ''
  const direction = new Decimal(difference).gt(0) ? 'over' : 'under'
  const magnitude = percentage !== null && new Decimal(percentage).abs().gt(10) ? 'large' : 'small'
  return `planner-difference--${direction} planner-difference--${magnitude}`
}
export function shiftPlannerMonth(month: string, direction: number): string {
  const [year, index] = month.split('-').map(Number)
  const date = new Date(Date.UTC(year, index - 1 + direction, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}
