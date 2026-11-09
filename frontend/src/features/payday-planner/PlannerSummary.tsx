import Decimal from 'decimal.js'

/* Summary values carry no visible descriptors and no currency glyph; the colors
   pair each value with its bar and aria-labels keep the figures meaningful to
   screen readers. The currency code rides in the card's bottom-right corner
   like the loan cards' currency indicator. */
export function PlannerSummary({ income, planned, remaining, completed, currency, money }: {
  income: string
  planned: string
  remaining: string
  completed: string
  currency: string
  money: (value: string) => string
}) {
  const incomeValue = new Decimal(income)
  // Both fills share the net-income scale; over-plans clamp to the full track.
  // Guard with gt(0): decimal.js calls zero positive and divides it into Infinity.
  const share = (value: string): Decimal => incomeValue.gt(0)
    ? Decimal.max(new Decimal(0), Decimal.min(new Decimal(100), new Decimal(value).div(incomeValue).times(100)))
    : new Decimal(0)
  const plannedShare = share(planned)
  const completedShare = share(completed)
  return <section className="planner-summary" aria-label="Monthly plan summary">
    <span className="planner-summary__values">
      <strong className="planner-summary__planned" aria-label="Planned">{money(planned)}</strong>
      <strong className="planner-summary__income" aria-label="Net income">{money(income)}</strong>
      <strong className={`planner-summary__remaining${new Decimal(remaining).isNegative() ? ' planner-negative' : ''}`} aria-label="Remaining">{money(remaining)}</strong>
    </span>
    <span className="planner-summary__track">
      <span className="planner-summary__fill" role="progressbar" aria-label="Planned share of net income" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(plannedShare.toNumber())} style={{ width: `${plannedShare.toFixed(2)}%` }} />
      <span className="planner-summary__fill planner-summary__fill--completed" role="progressbar" aria-label="Completed share of net income" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(completedShare.toNumber())} style={{ width: `${completedShare.toFixed(2)}%` }} />
    </span>
    <span className="planner-summary__footnote">
      <strong className="planner-summary__completed" aria-label="Completed">{money(completed)}</strong>
      <span className="planner-summary__currency" aria-label="Currency">{currency}</span>
    </span>
  </section>
}
