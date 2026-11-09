import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { LoanSummary } from '../../contracts/dashboard'
import { fmtNumber } from '../../lib/format'
import { LoanSummaryCard } from './LoanSummaryCard'

const loan: LoanSummary = {
  id: 'mortgage', name: 'Home mortgage', current_balance: 90000, monthly_payment: 1200,
  original_balance: 100000, interest_rate: 0.05,
}

describe('LoanSummaryCard', () => {
  it.each(['USD', 'EUR', 'PLN'])('shows %s once in the header and keeps amounts currency-free', (currency) => {
    render(<LoanSummaryCard loan={loan} currency={currency} onOpenLoan={vi.fn()} />)

    const card = screen.getByRole('button', { name: loan.name })
    const label = within(card).getByText(currency, { exact: true })
    expect(label).toHaveClass('property-loans__card-currency')
    expect(label.parentElement).toHaveClass('property-loans__card-head')
    expect(within(card).getByLabelText('Amount paid').textContent).toBe(fmtNumber(10000))
    expect(within(card).getByLabelText('Total loan amount').textContent).toBe(fmtNumber(100000))
    expect(within(card).getByLabelText('Amount left').textContent).toBe(fmtNumber(90000))
    expect(within(card).getByText(`${fmtNumber(1200)} / mo`)).toBeInTheDocument()
    expect(card.textContent?.split(currency)).toHaveLength(2)
  })

  it('preserves keyboard activation and the paid-off state', async () => {
    const user = userEvent.setup()
    const onOpenLoan = vi.fn()
    const paidOffLoan = { ...loan, current_balance: 0 }
    render(<LoanSummaryCard loan={paidOffLoan} currency="USD" onOpenLoan={onOpenLoan} />)

    expect(screen.getByLabelText('Amount left')).toHaveTextContent('Paid off')
    screen.getByRole('button', { name: loan.name }).focus()
    await user.keyboard('{Enter}')
    expect(onOpenLoan).toHaveBeenCalledWith(paidOffLoan)
  })
})
