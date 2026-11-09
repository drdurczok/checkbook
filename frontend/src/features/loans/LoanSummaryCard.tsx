import { Landmark } from 'lucide-react'
import type { LoanSummary } from '../../contracts/dashboard'
import { LoanProgress } from './LoanProgress'
import '../../styles/features/property-summary.css'

export function LoanSummaryCard({ loan, currency, onOpenLoan }: {
  loan: LoanSummary
  currency: string
  onOpenLoan: (loan: LoanSummary) => void
}) {
  return (
    <button
      className="property-loans__card"
      onClick={() => onOpenLoan(loan)}
      type="button"
      aria-label={loan.name}
      aria-haspopup="dialog"
    >
      <span className="property-loans__card-head">
        <Landmark className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="property-loans__card-name" title={loan.name}>{loan.name}</span>
        <span className="property-loans__card-currency">{currency}</span>
      </span>
      <LoanProgress loan={loan} currency={currency} showCurrency={false} />
    </button>
  )
}
