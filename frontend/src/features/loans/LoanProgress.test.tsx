import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LoanSummary } from '../../contracts/dashboard'
import { fmtCurrency, fmtDate, fmtNumber } from '../../lib/format'
import { LoanProgress } from './LoanProgress'

const loan: LoanSummary = {
  id: 'mortgage', name: 'Mortgage', current_balance: 90000, monthly_payment: 1200,
  interest_rate: 0.05, original_balance: 100000, start_date: '2025-01-01', end_date: '2035-01-01',
  details: { fixed_monthly_payment: '1 000,00' },
}

afterEach(() => vi.useRealTimers())

describe('LoanProgress', () => {
  it('shows the schedule interest after the loan amount and hides it when there is none', () => {
    const { container, rerender } = render(<LoanProgress loan={loan} currency="USD" totalInterest={745} />)
    // The interest figure repeats no currency: the loan amount beside it carries it.
    const interest = screen.getByText(`+ ${fmtNumber(745)}`)
    expect(interest).toBeInTheDocument()
    expect(interest).toHaveClass('loan-progress__interest')
    // The interest figure rides after the loan amount inside one group.
    const amount = container.querySelector('.loan-progress__amount')
    expect(amount).toContainElement(interest)
    expect(amount).toContainElement(screen.getByText(fmtCurrency(100000, 'USD')))
    rerender(<LoanProgress loan={loan} currency="USD" totalInterest={0} />)
    expect(screen.queryByText(`+ ${fmtNumber(0)}`)).not.toBeInTheDocument()
    rerender(<LoanProgress loan={loan} currency="USD" />)
    expect(container.querySelector('.loan-progress__interest')).toBeNull()
  })

  it('preserves summary balances, fixed payment, rate, dates, and accessible paid-down progress', () => {
    const { container } = render(<LoanProgress loan={loan} currency="USD" />)

    expect(screen.getByLabelText('Amount paid')).toHaveTextContent(fmtCurrency(10000, 'USD'))
    expect(screen.getByLabelText('Amount left')).toHaveTextContent(fmtCurrency(90000, 'USD'))
    expect(screen.getByLabelText('Total loan amount')).toHaveTextContent(fmtCurrency(100000, 'USD'))
    expect(container.querySelector('.loan-progress__values')?.children[0]).toHaveClass('loan-progress__paid')
    expect(container.querySelector('.loan-progress__values')?.children[1]).toHaveClass('loan-progress__amount')
    expect(container.querySelector('.loan-progress__values')?.children[2]).toHaveClass('loan-progress__remaining')
    const payment = screen.getByTitle('Planned payment is above the fixed formula payment')
    expect(payment).toHaveTextContent(`${fmtNumber(1000)} / mo`)
    expect(payment.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(payment.querySelector('svg')).toHaveClass('lucide-arrow-up')
    expect(screen.getByText('5.00%')).toBeInTheDocument()
    expect(screen.getByText(fmtDate('2025-01-01'))).toBeInTheDocument()
    expect(screen.getByText(fmtDate('2035-01-01'))).toBeInTheDocument()
    // Payment and rate ride below the bar, in the dates row between its ends.
    const datesRow = container.querySelector('.loan-progress__dates')
    expect(datesRow).toContainElement(payment)
    expect(datesRow).toContainElement(screen.getByText('5.00%'))
    const track = container.querySelector('.loan-progress__track')
    expect(
      datesRow!.compareDocumentPosition(track!)
        & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy()
    const progress = screen.getByRole('progressbar', { name: 'Paid down share of the original loan amount' })
    expect(progress).toHaveAttribute('aria-valuenow', '10')
    expect(progress).toHaveAttribute('aria-valuemin', '0')
    expect(progress).toHaveAttribute('aria-valuemax', '100')
    expect(container.querySelector('.loan-progress__fill')).toHaveStyle({ width: `${(1 - 90000 / 100000) * 100}%` })
    expect(container.querySelector('div, button, a, input')).toBeNull()
  })

  it('shows a lower planned payment arrow without replacing the fixed payment', () => {
    render(<LoanProgress loan={{ ...loan, monthly_payment: 900, interest_rate: 3.5 }} currency="EUR" />)

    const payment = screen.getByTitle('Planned payment is below the fixed formula payment')
    expect(payment).toHaveTextContent(`${fmtNumber(1000)} / mo`)
    expect(payment.querySelector('svg')).toHaveClass('lucide-arrow-down')
    expect(screen.getByText('3.50%')).toBeInTheDocument()
  })

  it.each([1000, 1000.5])('omits the arrow when planned payment %s is effectively unchanged', (monthlyPayment) => {
    const { container } = render(<LoanProgress loan={{ ...loan, monthly_payment: monthlyPayment }} currency="USD" />)

    expect(screen.queryByTitle(/Planned payment/)).not.toBeInTheDocument()
    expect(container.querySelector('svg')).toBeNull()
  })

  it.each([undefined, 0, -10, 'invalid'])('falls back to planned payment when fixed payment is %s', (fixedPayment) => {
    render(<LoanProgress loan={{ ...loan, details: { fixed_monthly_payment: fixedPayment } }} currency="EUR" />)

    expect(screen.getByText(`${fmtNumber(1200)} / mo`)).toBeInTheDocument()
    expect(screen.queryByTitle(/Planned payment/)).not.toBeInTheDocument()
  })

  it('keeps missing or non-finite values unknown rather than displaying zero amounts or dates', () => {
    const { container } = render(<LoanProgress loan={{
      ...loan, current_balance: Number.NaN, original_balance: null, monthly_payment: Number.NaN,
      interest_rate: Number.NaN, start_date: null, end_date: null, details: {},
    }} currency="USD" />)

    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
    expect(container.querySelector('.loan-progress__fill')).toHaveStyle({ width: '0%' })
    expect(container.querySelector('.loan-progress__values')).toBeEmptyDOMElement()
    // No payment or rate figures render when their values are unknown.
    expect(container.querySelector('.loan-progress__meta')).toBeNull()
    expect(container.querySelector('.loan-progress__dates')).toBeEmptyDOMElement()
    expect(screen.queryByText(/NaN|Invalid Date|Paid off/)).not.toBeInTheDocument()
  })

  it.each([0, 'missing', Number.NaN])('omits the rate and separator when the interest rate is %s', (rate) => {
    const summary = { ...loan, original_balance: null }
    if (typeof rate === 'number') summary.interest_rate = rate
    else Reflect.deleteProperty(summary, 'interest_rate')
    const { container } = render(<LoanProgress loan={summary} currency="USD" />)

    expect(container.querySelector('.loan-progress__meta')).toHaveTextContent(`${fmtNumber(1000)} / mo`)
    expect(screen.queryByText('-')).not.toBeInTheDocument()
    expect(screen.queryByText('\u00b7')).not.toBeInTheDocument()
    expect(screen.queryByText(/%/)).not.toBeInTheDocument()
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
    expect(screen.queryByText(fmtCurrency(100000, 'USD'))).not.toBeInTheDocument()
  })

  it.each([
    { balance: 0, expected: 100, paidOff: true },
    { balance: 0.5, expected: 100, paidOff: true },
    { balance: -100, expected: 100, paidOff: false },
    { balance: 110000, expected: 0, paidOff: false },
  ])('preserves paid-off threshold and clamps progress for balance $balance', ({ balance, expected, paidOff }) => {
    const { container } = render(<LoanProgress loan={{ ...loan, current_balance: balance }} currency="USD" />)

    expect(container.querySelector('.loan-progress__fill')?.classList.contains('loan-progress__fill--paid-off')).toBe(paidOff)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(expected))
    expect(screen.getByLabelText('Amount paid')).toHaveTextContent(fmtCurrency(Math.max(0, 100000 - Math.max(0, balance)), 'USD'))
    if (paidOff) expect(screen.getByText('Paid off')).toBeInTheDocument()
    else expect(screen.getByText(fmtCurrency(balance, 'USD'))).toBeInTheDocument()
  })

  it('shows calculated payoff as month and year, but prefers an explicit end date', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T12:00:00'))
    const projectedLoan = { ...loan, end_date: null, projected_payoff_months: 2 }
    const { rerender } = render(<LoanProgress loan={projectedLoan} currency="USD" />)
    const projectedLabel = new Date('2026-03-01T00:00:00').toLocaleDateString(undefined, { month: 'short', year: 'numeric' })

    expect(screen.getByText(projectedLabel)).toBeInTheDocument()
    rerender(<LoanProgress loan={{ ...projectedLoan, end_date: '2030-02-15' }} currency="USD" />)
    expect(screen.queryByText(projectedLabel)).not.toBeInTheDocument()
    expect(screen.getByText(fmtDate('2030-02-15'))).toBeInTheDocument()
  })
})
