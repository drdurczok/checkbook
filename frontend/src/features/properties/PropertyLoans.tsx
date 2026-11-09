import type { LoanSummary } from '../../contracts/dashboard'
import { SectionPanel } from '../../components/panel'
import { LoanSummaryCard } from '../loans/LoanSummaryCard'
import '../../styles/features/property-summary.css'

export function PropertyLoans({ loans, currency, onOpenLoan }: {
  loans: LoanSummary[]
  currency: string
  onOpenLoan: (loan: LoanSummary) => void
}) {
  if (!loans.length) return null
  return (
    <SectionPanel title="Loans">
      <div className="property-loans">
        {loans.map((loan) => (
          <LoanSummaryCard key={loan.id} loan={loan} currency={currency} onOpenLoan={onOpenLoan} />
        ))}
      </div>
    </SectionPanel>
  )
}
