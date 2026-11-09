import type { IncomeSource, IncomeSourceEntry } from '../../types'

export type IncomeDateRange = { start_date?: string; end_date?: string }

export function incomeDateInRange(date: string | null | undefined, range: IncomeDateRange) {
  return Boolean(date && (!range.start_date || date >= range.start_date) && (!range.end_date || date <= range.end_date))
}

export function incomeSourcesInDateRange(sources: IncomeSource[], range: IncomeDateRange, now: Date) {
  return sources.map((source) => ({
    ...source,
    // Filtering recorded payments must not redefine the source's annual run-rate.
    annual_total: sourceAnnualValue(source, now),
    entries: (source.entries ?? []).filter((entry) => incomeDateInRange(entry.entry_date, range)),
  }))
}

export type IncomeTaxSummary = {
  withheld: number
  due: number
  balance: number
  paidRatio: number
}

export type IncomeHistorySummary = {
  longest: number
  lifetime: number
  avgRaise: number
}

export type IncomeSummary = {
  activeSources: IncomeSource[]
  activeAnnualTotal: number
  activeNetTakeHome: number
  tax: IncomeTaxSummary
  history: IncomeHistorySummary
}

export function monthsBetween(start: string | null | undefined, end: string | null | undefined, now: Date) {
  if (!start) return 0
  const startDate = new Date(`${start}T00:00:00`)
  const endDate = end ? new Date(`${end}T00:00:00`) : now
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return 0
  return Math.max(0, (endDate.getFullYear() - startDate.getFullYear()) * 12 + endDate.getMonth() - startDate.getMonth() + 1)
}

export function isActiveSource(source: IncomeSource, now: Date) {
  if (!source.ended_on) return true
  return new Date(`${source.ended_on}T00:00:00`) >= startOfLocalDay(now)
}

/** Income history order: active roles lead regardless of start date, then
 * closed roles — each group still latest-start-first. Closing a role drops
 * it back among the closed ones. */
export function sortIncomeHistory(sources: IncomeSource[], now: Date) {
  return [...sources].sort((left, right) => {
    const activeDelta = Number(isActiveSource(right, now)) - Number(isActiveSource(left, now))
    if (activeDelta !== 0) return activeDelta
    return String(right.started_on ?? '').localeCompare(String(left.started_on ?? ''))
  })
}

export function sourcePeriodEntries(source: IncomeSource) {
  return (source.entries ?? []).filter((entry) => entryInSourcePeriod(entry, source))
}

export function sourceAnnualValue(source: IncomeSource, now: Date) {
  const expected = Number(source.annual_total || 0)
  return expected > 0 ? expected : annualizedSourceActual(source, now)
}

export function calculateIncomeSummary(sources: IncomeSource[], now: Date): IncomeSummary {
  const activeSources = sources.filter((source) => isActiveSource(source, now))
  const activeEntries = activeSources.flatMap(sourcePeriodEntries)
  const activeAnnualTotal = activeSources.reduce((sum, source) => sum + sourceAnnualValue(source, now), 0)
  const recentActual = activeSources.reduce((sum, source) => sum + recentSourceActualTotal(source, now), 0)
  const activeNetTakeHome = recentActual > 0 ? recentActual : activeAnnualTotal * 0.72
  const withheld = activeEntries.reduce(
    (sum, entry) =>
      sum +
      numericPayloadValue(entry.extra_payload, 'socialInsurance') +
      numericPayloadValue(entry.extra_payload, 'healthInsurance') +
      numericPayloadValue(entry.extra_payload, 'ppkContribution') +
      numericPayloadValue(entry.extra_payload, 'taxAdvance'),
    0,
  )
  const grossFromPayslips = activeEntries.reduce(
    (sum, entry) => sum + numericPayloadValue(entry.extra_payload, 'grossPay'),
    0,
  )
  const due = Math.max(withheld, grossFromPayslips > 0 ? grossFromPayslips * 0.24 : activeAnnualTotal * 0.2)
  const annuals = sources
    .filter((source) => isAnnualizedRate(source, now))
    .sort((left, right) => String(left.started_on ?? '').localeCompare(String(right.started_on ?? '')))
    .map((source) => sourceAnnualValue(source, now))
    .filter((value) => value > 0)
  const raises = annuals.slice(1).map((value, index) => (value - annuals[index]) / annuals[index])

  return {
    activeSources,
    activeAnnualTotal,
    activeNetTakeHome,
    tax: {
      withheld,
      due,
      balance: Math.max(0, due - withheld),
      paidRatio: due > 0 ? Math.min(100, (withheld / due) * 100) : 0,
    },
    history: {
      longest: Math.max(0, ...sources.map((source) => monthsBetween(source.started_on, source.ended_on, now))),
      lifetime: sources.flatMap((source) => source.entries ?? []).reduce((sum, entry) => sum + Number(entry.amount || 0), 0),
      avgRaise: raises.length ? raises.reduce((sum, value) => sum + value, 0) / raises.length : 0,
    },
  }
}

function startOfLocalDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

function entryInSourcePeriod(entry: IncomeSourceEntry, source: IncomeSource) {
  const entryDate = entry.entry_date
  if (!entryDate) return false
  if (source.started_on && entryDate < source.started_on) return false
  if (source.ended_on && entryDate > source.ended_on) return false
  return true
}

function recentSourceActualTotal(source: IncomeSource, now: Date) {
  const cutoff = new Date(now)
  cutoff.setFullYear(cutoff.getFullYear() - 1)
  const cutoffKey = cutoff.toLocaleDateString('sv-SE')
  return sourcePeriodEntries(source)
    .filter((entry) => String(entry.entry_date ?? '') >= cutoffKey)
    .reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
}

function annualizedSourceActual(source: IncomeSource, now: Date) {
  const entries = sourcePeriodEntries(source)
  if (!entries.length) return 0
  const recordedMonths = new Set(entries.map((entry) => String(entry.entry_date ?? '').slice(0, 7)))
  const total = entries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
  const tenureMonths = monthsBetween(source.started_on, source.ended_on, now)
  if (source.ended_on && tenureMonths > 0 && tenureMonths < 12) return total
  return (total / recordedMonths.size) * 12
}

function isAnnualizedRate(source: IncomeSource, now: Date) {
  return !source.ended_on || monthsBetween(source.started_on, source.ended_on, now) >= 12
}

function numericPayloadValue(payload: Record<string, unknown> | undefined, key: string) {
  const payslip = payload?.payslip && typeof payload.payslip === 'object'
    ? payload.payslip as Record<string, unknown>
    : payload
  const amount = Number(payslip?.[key])
  return Number.isFinite(amount) ? amount : 0
}
