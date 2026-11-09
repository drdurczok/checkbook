import type { NetWorthComponentRow, NetWorthGroupKey } from '../../contracts/dashboard'

export function emptyNetWorthMonth(period: string): NetWorthComponentRow {
  return { period, completed: false, total: 0,
    investing: { total: 0, components: {} }, savings: { total: 0, components: {} },
    non_liquid_assets: { total: 0, components: {} }, debt: { total: 0, components: {} } }
}

/** Draft a new month from the closest earlier one: manual subgroups carry
 * over everywhere, while debt and fixed assets also pull their automatic
 * (loan and property) values forward until the server recomputes them. */
export function draftNetWorthMonth(period: string, rows: NetWorthComponentRow[]): NetWorthComponentRow {
  const previous = rows.filter((row) => row.period < period).sort((a, b) => a.period.localeCompare(b.period)).at(-1)
  if (!previous) return emptyNetWorthMonth(period)
  const inherit = (key: NetWorthGroupKey, withAutomatic: boolean) => {
    const automaticComponents = withAutomatic ? { ...(previous[key].automatic_components ?? {}) } : {}
    const values = [...Object.values(previous[key].components), ...Object.values(automaticComponents)]
    return {
      total: values.reduce((sum, value) => sum + value, 0),
      components: { ...previous[key].components },
      ...(withAutomatic ? { automatic_components: automaticComponents } : {}),
    }
  }
  const investing = inherit('investing', false)
  const savings = inherit('savings', false)
  const nonLiquidAssets = inherit('non_liquid_assets', true)
  const debt = inherit('debt', true)
  return {
    period, completed: false,
    total: investing.total + savings.total + nonLiquidAssets.total - debt.total,
    investing, savings, non_liquid_assets: nonLiquidAssets, debt,
  }
}

/** Growth arrives from the API as a 100-based index (100 = unchanged month),
 * but the details table tones the signed change from that baseline:
 * 101 counts as +1 (positive), 99 as -1 (negative). */
export function growthDeltaTone(growth: number): string {
  return growth - 100 >= 0 ? 'is-positive' : 'is-negative'
}

/** Fixed-width percentage delta: the signed change from the 100 baseline is
 * padded with figure spaces (U+2007, exactly one digit wide) so "(+1.23%)"
 * and "(-12.34%)" render the same width alongside tabular numerals — figures
 * stay aligned down the Value column and the gap before the percentage never
 * varies. */
export function fmtGrowthDelta(growth: number): string {
  const delta = growth - 100
  const sign = delta >= 0 ? '+' : '-'
  return `${sign}${Math.abs(delta).toFixed(2)}%`.padStart(7, '\u2007')
}

export { nextAvailableMonth as nextNetWorthMonth } from '../../lib/months'

export const NET_WORTH_GROUPS: Array<{ key: NetWorthGroupKey; label: string }> = [
  { key: 'investing', label: 'Investing' },
  { key: 'savings', label: 'Savings' },
  { key: 'non_liquid_assets', label: 'Fixed assets' },
  { key: 'debt', label: 'Debt' },
]
