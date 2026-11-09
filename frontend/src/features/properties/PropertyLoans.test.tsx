import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { LoanSummary } from '../../contracts/dashboard'
import { fmtDate, fmtNumber } from '../../lib/format'
import { PropertyLoans } from './PropertyLoans'

const loans: LoanSummary[] = [
  {
    id: 'mortgage', name: 'Home mortgage', current_balance: 125000, monthly_payment: 950,
    interest_rate: 3.5, original_balance: 250000, start_date: '2020-01-01', end_date: '2040-01-01',
    details: { fixed_monthly_payment: 900 },
  },
  { id: 'improvements', name: 'Home improvements', current_balance: 6000, monthly_payment: 125, interest_rate: 4 },
]

describe('PropertyLoans', () => {
  it('omits the section when no loans are linked', () => {
    const { container } = render(<PropertyLoans loans={[]} currency="EUR" onOpenLoan={vi.fn()} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('presents every loan as a named card with the shared summary progress bar', async () => {
    const onOpenLoan = vi.fn()
    render(<PropertyLoans loans={loans} currency="EUR" onOpenLoan={onOpenLoan} />)

    expect(screen.getByRole('heading', { name: 'Loans' })).toBeInTheDocument()
    expect(screen.queryByText(/Current balance:|Monthly payment:/)).not.toBeInTheDocument()
    for (const loan of loans) {
      const card = screen.getByRole('button', { name: loan.name })
      expect(card).toHaveClass('property-loans__card')
      expect(card).toHaveAttribute('type', 'button')
      expect(card).toHaveAttribute('aria-haspopup', 'dialog')
      expect(within(card).getByText('EUR')).toHaveClass('property-loans__card-currency')
      expect(within(card).getByLabelText('Amount left').textContent).toBe(fmtNumber(loan.current_balance))
      if (loan.original_balance != null) {
        expect(within(card).getByLabelText('Amount paid').textContent).toBe(fmtNumber(loan.original_balance - loan.current_balance))
      } else {
        expect(within(card).queryByLabelText('Amount paid')).not.toBeInTheDocument()
      }
      expect(within(card).getByText(`${fmtNumber(Number(loan.details?.fixed_monthly_payment ?? loan.monthly_payment))} / mo`)).toBeInTheDocument()
      expect(within(card).getByRole('progressbar', { name: 'Paid down share of the original loan amount' })).toBeInTheDocument()
      expect(card.querySelector('div, button, a, input')).toBeNull()
    }
    const mortgage = within(screen.getByRole('button', { name: loans[0].name }))
    expect(mortgage.getByText(fmtNumber(250000))).toBeInTheDocument()
    expect(mortgage.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50')
    expect(mortgage.getByTitle('Planned payment is above the fixed formula payment')).toBeInTheDocument()
    expect(mortgage.getByText('3.50%')).toBeInTheDocument()
    expect(mortgage.getByText(fmtDate('2020-01-01'))).toBeInTheDocument()
    expect(mortgage.getByText(fmtDate('2040-01-01'))).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: loans[1].name }))
    expect(onOpenLoan).toHaveBeenCalledExactlyOnceWith(loans[1])
  })

  it('supports Tab, Enter, and Space with native card buttons', async () => {
    const user = userEvent.setup()
    const onOpenLoan = vi.fn()
    render(<PropertyLoans loans={loans} currency="EUR" onOpenLoan={onOpenLoan} />)

    await user.tab()
    expect(screen.getByRole('button', { name: loans[0].name })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(onOpenLoan).toHaveBeenLastCalledWith(loans[0])
    await user.tab()
    expect(screen.getByRole('button', { name: loans[1].name })).toHaveFocus()
    await user.keyboard(' ')
    expect(onOpenLoan).toHaveBeenLastCalledWith(loans[1])
    expect(onOpenLoan).toHaveBeenCalledTimes(2)
  })
})
