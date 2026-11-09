import { ArrowDown, ArrowUp } from 'lucide-react'
import type { LoanSummary } from '../../contracts/dashboard'
import { fmtCurrency, fmtDate, fmtNumber } from '../../lib/format'
import {
  calculateLoanEndDate,
  finiteLoanNumber,
  loanMinimumPayment,
  loanPaymentChange,
  loanProgress,
} from './model'

export function LoanProgress({ loan, currency, totalInterest, showCurrency = true }: {
  loan: LoanSummary
  currency: string
  totalInterest?: number | null
  showCurrency?: boolean
}) {
  const formatAmount = (value: number) => showCurrency ? fmtCurrency(value, currency) : fmtNumber(value)
  const progress = loanProgress(loan)
  const paymentChange = loanPaymentChange(loan)
  const original = finiteLoanNumber(loan.original_balance)
  const balance = finiteLoanNumber(loan.current_balance)
  const paidOff = balance !== null && Math.abs(balance) < 1
  const paid = original !== null && balance !== null
    ? Math.max(0, original - Math.max(0, balance))
    : null
  const minimumPayment = finiteLoanNumber(loanMinimumPayment(loan))
  const rate = finiteLoanNumber(loan.interest_rate)
  const rateLabel = rate ? `${(rate > 0 && rate < 1 ? rate * 100 : rate).toFixed(2)}%` : null
  const start = loan.start_date ? fmtDate(loan.start_date) : null
  const calculatedEnd = calculateLoanEndDate(loan)
  // Calculated payoffs are month-level; do not invent a specific day.
  const end = loan.end_date
    ? fmtDate(loan.end_date)
    : calculatedEnd
      ? new Date(`${calculatedEnd}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
      : null

  return (
    <span className="loan-progress">
      <span className="loan-progress__values">
        {paid !== null ? <strong className="loan-progress__paid" aria-label="Amount paid">{formatAmount(paid)}</strong> : null}
        {original !== null || (totalInterest ?? 0) > 0 ? (
          <span className="loan-progress__amount" aria-label="Total loan amount">
            {original !== null ? <span>{formatAmount(original)}</span> : null}
            {typeof totalInterest === 'number' && totalInterest > 0 ? (
              <span className="loan-progress__interest">+ {fmtNumber(totalInterest)}</span>
            ) : null}
          </span>
        ) : null}
        {balance !== null ? (
          <strong className="loan-progress__remaining" aria-label="Amount left">
            {paidOff ? 'Paid off' : formatAmount(balance)}
          </strong>
        ) : null}
      </span>
      <span className="loan-progress__track"
        aria-label="Paid down share of the original loan amount"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={progress !== null ? Math.round(progress) : undefined}
        role="progressbar"
      >
        <span className={`loan-progress__fill${paidOff ? ' loan-progress__fill--paid-off' : ''}`} style={{ width: `${progress ?? 0}%` }} />
      </span>
      <span className="loan-progress__dates">
        {start ? <span>{start}</span> : null}
        {minimumPayment !== null || rateLabel !== null ? (
          <span className="loan-progress__meta">
            {minimumPayment !== null ? (
              <span
                className="loan-progress__payment"
                title={paymentChange === null
                  ? undefined
                  : paymentChange > 0
                    ? 'Planned payment is above the fixed formula payment'
                    : 'Planned payment is below the fixed formula payment'}
              >
                {fmtNumber(minimumPayment)} / mo
                {paymentChange !== null ? (
                  paymentChange > 0 ? (
                    <ArrowUp aria-hidden="true" className="h-3.5 w-3.5" />
                  ) : (
                    <ArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
                  )
                ) : null}
              </span>
            ) : null}
            {minimumPayment !== null && rateLabel !== null ? <span aria-hidden="true">{'\u00b7'}</span> : null}
            {rateLabel !== null ? <span>{rateLabel}</span> : null}
          </span>
        ) : null}
        {end ? <span>{end}</span> : null}
      </span>
    </span>
  )
}
