import Decimal from 'decimal.js'
import type { LoanPaymentDetail, LoanSummary } from '../../contracts/dashboard'

export function finiteLoanNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const number =
    typeof value === 'number'
      ? value
      : Number(value.trim().replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(number) ? number : null
}

export function loanMinimumPayment(loan: LoanSummary): number {
  const fixed = finiteLoanNumber(loan.details?.fixed_monthly_payment)
  return fixed !== null && fixed > 0 ? fixed : loan.monthly_payment
}

export function loanPaymentChange(loan: LoanSummary): number | null {
  const fixed = finiteLoanNumber(loan.details?.fixed_monthly_payment)
  const planned = finiteLoanNumber(loan.monthly_payment)
  if (fixed === null || fixed <= 0 || planned === null || Math.abs(planned - fixed) < 1) return null
  return planned - fixed
}

export function loanProgress(loan: LoanSummary): number | null {
  const original = finiteLoanNumber(loan.original_balance)
  const current = finiteLoanNumber(loan.current_balance)
  if (original === null || original <= 0 || current === null) return null
  return Math.max(0, Math.min(100, (1 - current / original) * 100))
}

/** Calculate a month-level payoff date only with enough finite data and a
 * payment that exceeds the monthly interest. No value means unknown. */
export function calculateLoanEndDate(
  loan: LoanSummary,
  from = new Date(),
): string | null {
  const balance = finiteLoanNumber(loan.current_balance)
  if (balance === null || balance <= 0) return null
  const projectedMonths = finiteLoanNumber(loan.projected_payoff_months)
  if (projectedMonths !== null && projectedMonths > 0) {
    const result = new Date(
      from.getFullYear(),
      from.getMonth() + Math.ceil(projectedMonths),
      1,
    )
    return `${result.getFullYear()}-${String(result.getMonth() + 1).padStart(2, '0')}`
  }
  const payment = finiteLoanNumber(loan.monthly_payment)
  const rate = finiteLoanNumber(loan.interest_rate)
  if (payment === null || payment <= 0 || rate === null || rate < 0) return null
  const monthlyRate = rate > 0 && rate < 1 ? rate / 12 : rate / 1200
  let remaining = balance
  let months = 0
  while (remaining > 0 && months < 1200) {
    const interest = remaining * monthlyRate
    if (payment <= interest) return null
    remaining -= payment - interest
    months += 1
  }
  if (remaining > 0 || months === 0) return null
  const result = new Date(from.getFullYear(), from.getMonth() + months, 1)
  return `${result.getFullYear()}-${String(result.getMonth() + 1).padStart(2, '0')}`
}

// Keep ISO periods for year grouping; never round-trip locale display dates.
function scheduleDate(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  const iso = text.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?(?:T.*)?$/)
  const polish = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)
  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  const monthYear = text.match(/^(\d{1,2})[./](\d{4})$/)
  const parts = iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3] ?? 1)]
    : polish ? [Number(polish[3]), Number(polish[2]), Number(polish[1])]
      : slash ? [Number(slash[3]), Number(slash[1]), Number(slash[2])]
        : monthYear ? [Number(monthYear[2]), Number(monthYear[1]), 1] : null
  if (!parts) return null
  const [year, month, day] = parts
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function loanPaymentCompleted(payment: LoanPaymentDetail): boolean {
  return payment.completed ?? !payment.projected
}

// Preserve the transport values for whole-schedule writes; numeric normalization
// is for display only and must not round untouched decimal strings.
export function loanPaymentSourceRows(loan: LoanSummary | null): LoanPaymentDetail[] {
  const schedule = loan?.details?.payment_schedule
  if (!Array.isArray(schedule)) return []
  return schedule.filter((row: unknown): row is LoanPaymentDetail => {
    if (!row || typeof row !== 'object') return false
    const raw = row as Record<string, unknown>
    return scheduleDate(raw.date) !== null
  }).sort((left, right) => (scheduleDate(left.date) ?? '').localeCompare(scheduleDate(right.date) ?? ''))
}

export function loanPaymentSchedule(loan: LoanSummary | null): LoanPaymentDetail[] {
  const schedule = loan?.details?.payment_schedule
  if (!Array.isArray(schedule)) return []
  return schedule.flatMap((payment: unknown) => {
    if (!payment || typeof payment !== 'object') return []
    const raw = payment as Record<string, unknown>
    const date = scheduleDate(raw.date)
    if (!date) return []
    const completed = typeof raw.completed === 'boolean' ? raw.completed : undefined
    return [{
      id: typeof raw.id === 'string' ? raw.id : undefined,
      completed,
      date,
      payment: finiteLoanNumber(raw.payment) ?? undefined,
      interest: finiteLoanNumber(raw.interest) ?? undefined,
      principal: finiteLoanNumber(raw.principal) ?? undefined,
      extra_principal: finiteLoanNumber(raw.extra_principal) ?? undefined,
      outstanding_loan_balance: finiteLoanNumber(raw.outstanding_loan_balance) ?? undefined,
      interest_balance: finiteLoanNumber(raw.interest_balance) ?? undefined,
      projected: !(completed ?? (raw.projected !== true)),
    }]
  }).sort((left, right) => left.date.localeCompare(right.date))
}

/** Total interest across every schedule row, forecast payments included. */
export function loanTotalInterest(loan: LoanSummary | null): number | null {
  const rows = loanPaymentSchedule(loan)
  if (!rows.length) return null
  const total = rows.reduce(
    (sum, row) => sum.plus(row.interest ?? 0),
    new Decimal(0),
  )
  // decimal.js counts +0 as positive, so compare explicitly.
  return total.comparedTo(0) > 0 ? total.toNumber() : null
}
