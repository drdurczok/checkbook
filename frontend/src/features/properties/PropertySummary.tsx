import Decimal from 'decimal.js'
import type { AssetSummary } from '../../contracts/assets'
import { fmtMoney, todayInputValue } from '../../lib/format'
import { useUtilityBoardQuery } from '../utilities/queries'
import { calculateRunningCosts } from './runningCosts'
import { loanMinimumPayment } from '../loans/model'
import type { LoanSummary } from '../../contracts/dashboard'
import '../../styles/features/property-summary.css'

interface PropertySummaryProps {
  property: AssetSummary
  currency: string
  token: string
  loans: LoanSummary[]
  /** Force utilities tracking off; vehicles and accounts carry none. */
  utilities?: boolean
  /** Hide the mandatory-costs card entirely; accounts have no running costs. */
  showCosts?: boolean
  /** Accessible name of the summary region. */
  label?: string
}

export function PropertySummary({ property, currency, token, loans, utilities, showCosts = true, label = 'Property summary' }: PropertySummaryProps) {
  const utilitiesEnabled = utilities ?? property.utilities_enabled !== false
  const board = useUtilityBoardQuery(token, showCosts && utilitiesEnabled ? { type: 'property', id: property.id } : null, true)
  const costs = calculateRunningCosts(board.data?.months ?? [], todayInputValue())
  const loanCosts = loans.reduce((total, loan) => total.plus(loanMinimumPayment(loan)), new Decimal(0))
  const mandatoryCosts = (utilitiesEnabled ? costs.average : null)?.plus(loanCosts) ??
    (loans.length ? loanCosts : null)

  return (
    <section aria-label={label} className={`property-summary${showCosts ? '' : ' property-summary--single'}`}>
      <div className="property-summary__item property-summary__item--valuation">
        <div className="property-summary__heading">
          <span className="property-summary__label">Valuation</span>
        </div>
        <strong className="property-summary__amount">{fmtMoney(property.total_cost, currency)}</strong>
      </div>
      {showCosts ? (
        <div className="property-summary__item">
          <div className="property-summary__heading">
            <span className="property-summary__label">Mandatory costs</span>
          </div>
          <div aria-live="polite" aria-busy={utilitiesEnabled && board.isPending}>
            {!utilitiesEnabled ? (
              <p className="property-summary__state">Tracking disabled.</p>
            ) : board.isPending ? (
              <p className="property-summary__state" role="status">Loading...</p>
            ) : board.isError ? (
              <p className="property-summary__state property-summary__state--error" role="alert">
                Unavailable.{' '}
                <button type="button" onClick={() => void board.refetch()} disabled={board.isFetching}>Retry</button>
              </p>
            ) : mandatoryCosts === null ? (
              <p className="property-summary__state">No recent records.</p>
            ) : (
              <strong className="property-summary__amount">
                {fmtMoney(mandatoryCosts.toDecimalPlaces(2).toNumber(), currency, 2)}
              </strong>
            )}
          </div>
        </div>
      ) : null}
    </section>
  )
}
