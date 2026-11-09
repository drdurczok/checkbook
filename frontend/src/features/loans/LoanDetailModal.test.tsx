import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoanSummary } from '../../contracts/dashboard'
import { fmtCurrency, fmtNumber } from '../../lib/format'
import { LoanDetailModal } from './LoanDetailModal'
import { loanPaymentSchedule } from './model'

const { updateLoan, setMessage } = vi.hoisted(() => ({ updateLoan: vi.fn(), setMessage: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: { updateLoan } }))
vi.mock('../../lib/session', () => ({ useSession: () => ({ token: 'token', currency: 'USD', setMessage }) }))
vi.mock('../../components/charts', () => ({
  LoanPayoffChart: ({ payments }: { payments: Array<{ date: string }> }) => (
    <div data-testid="loan-payoff-chart">{payments.map((payment) => payment.date).join(',')}</div>
  ),
}))

const loan: LoanSummary = {
  id: 'loan-1', name: 'Mortgage', current_balance: 90000, monthly_payment: 1200,
  interest_rate: 0.05, original_balance: 100000, start_date: '2025-01-01',
  end_date: '2035-01-01', notes: 'Keep this note', linked_property_id: null,
  details: {
    fixed_monthly_payment: 1000,
    period_count: 120,
    lender: 'Local bank',
    source_sheet: 'Hidden import metadata',
    payment_schedule: [
      { date: '2025-12-01', payment: 1200, interest: 375, principal: 625, extra_principal: 200, outstanding_loan_balance: 89175, interest_balance: 0 },
      { date: '2026-01-01', payment: 1200, interest: 370, principal: 630, extra_principal: 200, outstanding_loan_balance: 88345, interest_balance: 0 },
    ],
  },
}
const properties = [{ id: 'property-1', name: 'Home', total_cost: 100000, valuation_date: '2025-01-01' }]

function setup(record = loan, withSaveCallback = true) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const onSaved = vi.fn()
  const onClose = vi.fn()
  const view = (value: LoanSummary) => <QueryClientProvider client={queryClient}>
    <LoanDetailModal loan={value} properties={properties} onClose={onClose} onSaved={withSaveCallback ? onSaved : undefined} />
  </QueryClientProvider>
  const result = render(view(record))
  return { user: userEvent.setup(), onSaved, onClose, rerender: (value: LoanSummary) => result.rerender(view(value)) }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('LoanDetailModal', () => {
  it('preserves summary values, derived progress, details, payoff chart, and collapsible notes', async () => {
    const { user } = setup()
    expect(screen.getByRole('dialog', { name: 'Mortgage USD' })).toHaveClass('loan-detail-modal')
    expect(screen.getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(fmtCurrency(90000, 'USD'))).toBeInTheDocument()
    expect(screen.getByText(fmtCurrency(100000, 'USD'))).toBeInTheDocument()
    // Total interest rides after the loan amount at a smaller size, forecasts
    // included, without repeating the currency.
    expect(screen.getByText(`+ ${fmtNumber(745)}`)).toBeInTheDocument()
    expect(screen.getByTitle('Planned payment is above the fixed formula payment')).toHaveTextContent(`${fmtNumber(1000)} / mo`)
    expect(screen.getByText('5.00%')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '10')
    expect(screen.getByText('Periods')).toBeInTheDocument()
    expect(screen.getByText('Local bank')).toBeInTheDocument()
    expect(screen.queryByText('Hidden import metadata')).not.toBeInTheDocument()
    expect(screen.getByTestId('loan-payoff-chart')).toBeInTheDocument()
    expect(screen.getByText('Keep this note')).not.toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Notes' }))
    expect(screen.getByText('Keep this note')).toBeVisible()
  })

  it('shows the complete year-grouped schedule and restores summary on selection', async () => {
    const { user } = setup()
    await user.click(screen.getByRole('tab', { name: 'Table' }))
    expect(screen.getByRole('dialog')).toHaveClass('loan-detail-modal--table')
    const table = screen.getByRole('table')
    for (const heading of ['Payment', 'Interest', 'Principal', 'Extra principal', 'Balance']) {
      expect(within(table).getByRole('columnheader', { name: heading })).toBeInTheDocument()
    }
    expect(within(table).queryByRole('columnheader', { name: 'Interest balance' })).not.toBeInTheDocument()
    // The add-row affordance is the table's own final row.
    const addRow = within(table).getByRole('button', { name: 'Add row' }).closest('tr')
    expect(addRow).toHaveClass('loan-schedule-table__add-row')
    expect(within(table).getAllByRole('row').at(-1)).toBe(addRow)
    expect(within(table).getByText('2025')).toBeInTheDocument()
    expect(within(table).getByText('2026')).toBeInTheDocument()
    expect(within(table).getByText(fmtNumber(89175))).toBeInTheDocument()
    expect(within(table).getByText(fmtNumber(88345))).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Summary' }))
    expect(screen.getByTestId('loan-payoff-chart')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('hides projected chart and monthly rows together when forecast is toggled off', async () => {
    const record = {
      ...loan,
      details: {
        ...loan.details,
        payment_schedule: [
          { date: '2025-12-01', payment: 1200, outstanding_loan_balance: 89175 },
          { date: '2030-02-01', payment: 1200, outstanding_loan_balance: 77777, projected: true },
        ],
      },
    }
    const originalDetails = structuredClone(record.details)
    const { user } = setup(record)
    expect(screen.queryByRole('switch', { name: 'Forecast' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitemcheckbox', { name: 'Forecast' })).not.toBeInTheDocument()
    // Forecast is on by default: projected rows are already part of the view.
    expect(screen.getByTestId('loan-payoff-chart')).toHaveTextContent('2030-02-01')
    await user.click(screen.getByRole('tab', { name: 'Table' }))
    expect(within(screen.getByRole('table')).getByText('2030')).toBeInTheDocument()
    const actions = screen.getByRole('button', { name: 'Loan actions' })
    await user.click(actions)
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitemcheckbox', { name: 'Forecast' })).toHaveFocus()
    expect(screen.getByRole('menuitemcheckbox', { name: 'Forecast' })).toBeChecked()
    await user.keyboard('{Escape}')
    expect(actions).toHaveFocus()
    await user.click(actions)
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Forecast' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(actions).toHaveFocus()
    expect(within(screen.getByRole('table')).queryByText('2030')).not.toBeInTheDocument()
    expect(within(screen.getByRole('table')).getByText('2025')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Summary' }))
    expect(screen.getByTestId('loan-payoff-chart')).not.toHaveTextContent('2030-02-01')
    await user.click(actions)
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Forecast' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(actions).toHaveFocus()
    expect(screen.getByTestId('loan-payoff-chart')).toHaveTextContent('2030-02-01')
    expect(screen.getByText(fmtCurrency(90000, 'USD'))).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '10')
    expect(record.details).toEqual(originalDetails)
  })

  it('shows an empty-state hint when a projected-only schedule is filtered to recorded rows', async () => {
    const { user } = setup({ ...loan, details: { payment_schedule: [
      { date: '2030-02-01', payment: 1200, projected: true },
    ] } })
    expect(screen.getByTestId('loan-payoff-chart')).toHaveTextContent('2030-02-01')
    await user.click(screen.getByRole('tab', { name: 'Table' }))
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(within(screen.getByRole('table')).getByText('2030')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Loan actions' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Forecast' }))
    expect(screen.getByText('No recorded payments. Disable Forecast to hide projected payments.')).toBeInTheDocument()
  })

  it('keeps the empty schedule available to add payments and supports paid-off loans', async () => {
    const { user } = setup({ ...loan, current_balance: 0, details: { payment_schedule: [{ date: 'invalid' }] } })
    expect(screen.getByText('Paid off')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    expect(screen.getByRole('tab', { name: 'Table' })).toBeEnabled()
    expect(screen.queryByTestId('loan-payoff-chart')).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Table' }))
    await user.click(screen.getByRole('button', { name: 'Add row' }))
    expect(screen.getByRole('dialog', { name: 'Add payment' })).toBeInTheDocument()
    expect(screen.getByLabelText('Date')).toHaveAttribute('value', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/))
    expect(screen.getByLabelText('Base payment', { exact: true })).toHaveValue(null)
  })

  it('opens the complete editor, preserves summary on cancel, and reports successful saves', async () => {
    const updated = { ...loan, name: 'Updated mortgage', linked_property_id: 'property-1', notes: 'Updated note' }
    updateLoan.mockResolvedValue(updated)
    const { user, onSaved } = setup()
    await user.click(screen.getByRole('button', { name: 'Loan actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }))
    expect(screen.getByRole('form', { name: 'Edit loan' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-selected', 'true')
    expect(updateLoan).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Loan actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }))
    await user.selectOptions(screen.getByLabelText('Linked property'), 'property-1')
    await user.click(screen.getByRole('button', { name: 'Save loan' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(updated))
    expect(screen.getByRole('dialog', { name: 'Updated mortgage USD' })).toBeInTheDocument()
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
    expect(updateLoan.mock.calls[0][2].linked_property_id).toBe('property-1')
  })

  it('displays successful edits without an onSaved callback and adopts refreshed props', async () => {
    updateLoan.mockResolvedValue({ ...loan, name: 'Saved mortgage' })
    const { user, rerender } = setup(loan, false)
    await user.click(screen.getByRole('button', { name: 'Loan actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }))
    await user.click(screen.getByRole('button', { name: 'Save loan' }))
    expect(await screen.findByRole('dialog', { name: 'Saved mortgage USD' })).toBeInTheDocument()
    rerender({ ...loan, name: 'Refreshed mortgage' })
    expect(screen.getByRole('dialog', { name: 'Refreshed mortgage USD' })).toBeInTheDocument()
  })

  it('saves only the selected payment and preserves hidden forecasts and loan metadata', async () => {
    const schedule = [
      { date: '2026-02-01', payment: 1200, interest: 380, projected: true },
      ...loanPaymentSchedule(loan),
      { date: '2025-11-01', payment: 1200, projected: true },
    ]
    const record = { ...loan, details: { ...loan.details, payment_schedule: schedule } }
    const original = structuredClone(record)
    updateLoan.mockImplementation(async (_token, _id, payload) => ({ ...record, details: { ...record.details, payment_schedule: payload.payment_schedule } }))
    const { user, onSaved } = setup(record)
    await user.click(screen.getByRole('tab', { name: 'Table' }))
    // Forecast is on by default, so hidden projected rows are visible too.
    expect(screen.getByRole('row', { name: 'Edit payment 2025-11-01' })).toBeInTheDocument()
    const row = screen.getByRole('row', { name: 'Edit payment 2026-01-01' })
    expect(row).toHaveAttribute('tabindex', '0')
    expect(row).toHaveClass('loan-schedule-table__row')
    await user.click(within(row).getByText(fmtNumber(88345)))
    const sheet = screen.getByRole('dialog', { name: 'Edit payment' })
    const form = within(sheet).getByRole('form', { name: 'Edit loan payment' })
    expect(within(form).getByRole('checkbox', { name: 'Completed' })).toBeChecked()
    for (const [label, value] of [
      ['Interest', '400.5'], ['Principal', '700'], ['Extra principal', '249.75'],
    ]) {
      await user.clear(within(form).getByLabelText(label, { exact: true }))
      await user.type(within(form).getByLabelText(label, { exact: true }), value)
    }
    // Base payment and balance are derived: principal + interest, and the
    // previous row's balance less principal and extra principal.
    expect(within(form).getByLabelText('Base payment', { exact: true })).toHaveValue(1100.5)
    expect(within(form).getByLabelText('Balance', { exact: true })).toHaveValue(88225.25)
    await user.clear(within(form).getByLabelText('Date'))
    await user.type(within(form).getByLabelText('Date'), '2026-01-15')
    await user.click(within(sheet).getByRole('button', { name: 'Save payment' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    const payload = updateLoan.mock.calls[0][2]
    expect(payload.payment_schedule).toEqual([
      schedule[3], schedule[1],
      { date: '2026-01-15', payment: '1100.5', interest: '400.5', principal: '700', extra_principal: '249.75', outstanding_loan_balance: '88225.25', interest_balance: '0', completed: true, projected: false },
      schedule[0],
    ])
    expect(payload).not.toHaveProperty('current_balance')
    expect(payload).not.toHaveProperty('monthly_payment')
    expect(payload.notes).toBe(loan.notes)
    expect(record).toEqual(original)
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Table' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('table')).toHaveTextContent(fmtNumber(1100.5))
  })

  it.each(['{Enter}', ' '])('opens a payment sheet from a native row using %s and closes without saving', async (key) => {
    const { user } = setup()
    await user.click(screen.getByRole('tab', { name: 'Table' }))
    const row = screen.getByRole('row', { name: 'Edit payment 2025-12-01' })
    row.focus()
    await user.keyboard(key)
    expect(screen.getByRole('dialog', { name: 'Edit payment' })).toBeInTheDocument()
    expect(screen.getByLabelText('Date')).toHaveValue('2025-12-01')
    await user.clear(screen.getByLabelText('Interest', { exact: true }))
    await user.type(screen.getByLabelText('Interest', { exact: true }), '999')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
    expect(updateLoan).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Mortgage USD' })).toBeInTheDocument()
    await user.click(row)
    // Base payment stays the sum of principal and interest, not the stored total.
    expect(screen.getByLabelText('Base payment', { exact: true })).toHaveValue(1000)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
    expect(updateLoan).not.toHaveBeenCalled()
  })

  it('removes the selected recorded row from the payment actions menu without dropping hidden forecast payments', async () => {
    const schedule = [
      { date: '2025-11-01', payment: 1200, projected: true },
      ...loanPaymentSchedule(loan),
    ]
    updateLoan.mockImplementation(async (_token, _id, payload) => ({ ...loan, details: { ...loan.details, payment_schedule: payload.payment_schedule } }))
    const { user, onSaved } = setup({ ...loan, details: { ...loan.details, payment_schedule: schedule } })
    await user.click(screen.getByRole('tab', { name: 'Table' }))
    await user.click(screen.getByRole('row', { name: 'Edit payment 2026-01-01' }))
    await user.click(screen.getByRole('button', { name: 'Payment actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Remove row' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
    expect(updateLoan.mock.calls[0][2].payment_schedule).toEqual(schedule.slice(0, 2))
    expect(screen.queryByRole('row', { name: 'Edit payment 2026-01-01' })).not.toBeInTheDocument()
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
  })

  it('adds an empty payment dated next month after the complete schedule and can close its draft', async () => {
    const schedule = [...loanPaymentSchedule(loan), { date: '2026-02-15', payment: 1200, projected: true }]
    const record = { ...loan, details: { ...loan.details, payment_schedule: schedule } }
    updateLoan.mockImplementation(async (_token, _id, payload) => ({ ...record, details: { ...record.details, payment_schedule: payload.payment_schedule } }))
    const { user } = setup(record)
    await user.click(screen.getByRole('tab', { name: 'Table' }))
    await user.click(screen.getByRole('button', { name: 'Add row' }))
    const sheet = screen.getByRole('dialog', { name: 'Add payment' })
    expect(within(sheet).getByLabelText('Date')).toHaveValue('2026-03-01')
    expect(within(sheet).getByRole('checkbox', { name: 'Completed' })).not.toBeChecked()
    expect(within(sheet).queryByRole('button', { name: 'Payment actions' })).not.toBeInTheDocument()
    for (const label of ['Interest', 'Principal', 'Extra principal', 'Base payment']) {
      expect(within(sheet).getByLabelText(label, { exact: true })).toHaveValue(null)
    }
    // No stored balances anchor the new row, so it starts from the loan balance.
    expect(within(sheet).getByLabelText('Balance', { exact: true })).toHaveValue(90000)
    await user.type(within(sheet).getByLabelText('Principal', { exact: true }), '1300')
    expect(within(sheet).getByLabelText('Base payment', { exact: true })).toHaveValue(1300)
    await user.click(within(sheet).getByRole('button', { name: 'Close' }))
    expect(updateLoan).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Add row' }))
    expect(screen.getByLabelText('Principal', { exact: true })).toHaveValue(null)
    await user.type(screen.getByLabelText('Principal', { exact: true }), '700.75')
    await user.type(screen.getByLabelText('Interest', { exact: true }), '700')
    expect(screen.getByLabelText('Base payment', { exact: true })).toHaveValue(1400.75)
    expect(screen.getByLabelText('Balance', { exact: true })).toHaveValue(89299.25)
    await user.click(screen.getByRole('button', { name: 'Save payment' }))
    await waitFor(() => expect(updateLoan).toHaveBeenCalledOnce())
    expect(updateLoan.mock.calls[0][2].payment_schedule).toEqual([
      ...schedule, { date: '2026-03-01', payment: '1400.75', interest: '700', principal: '700.75', outstanding_loan_balance: '89299.25', completed: false, projected: true },
    ])
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
  })

  it('removes the last payment and allows creating a payment from the empty table', async () => {
    const onlyPayment = loanPaymentSchedule(loan)[0]
    updateLoan.mockImplementation(async (_token, _id, payload) => ({ ...loan, details: { ...loan.details, payment_schedule: payload.payment_schedule } }))
    const { user } = setup({ ...loan, details: { payment_schedule: [onlyPayment] } })
    await user.click(screen.getByRole('tab', { name: 'Table' }))
    await user.click(screen.getByRole('row', { name: 'Edit payment 2025-12-01' }))
    await user.click(screen.getByRole('button', { name: 'Payment actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Remove row' }))
    await waitFor(() => expect(updateLoan).toHaveBeenCalledOnce())
    expect(updateLoan.mock.calls[0][2].payment_schedule).toEqual([])
    expect(screen.getByRole('tab', { name: 'Table' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Add row' }))
    await user.type(screen.getByLabelText('Principal', { exact: true }), '250')
    expect(screen.getByLabelText('Base payment', { exact: true })).toHaveValue(250)
    expect(screen.getByLabelText('Balance', { exact: true })).toHaveValue(89750)
    await user.click(screen.getByRole('button', { name: 'Save payment' }))
    await waitFor(() => expect(updateLoan).toHaveBeenCalledTimes(2))
    expect(updateLoan.mock.calls[1][2].payment_schedule).toEqual([
      expect.objectContaining({ payment: '250', principal: '250', outstanding_loan_balance: '89750', completed: false, projected: true }),
    ])
  })

  it('preserves the forecast marker when editing a projected payment', async () => {
    const projected = { date: '2026-02-01', payment: 1200, projected: true }
    updateLoan.mockResolvedValue({ ...loan, details: { payment_schedule: [{ ...projected, payment: 1300 }] } })
    const { user } = setup({ ...loan, details: { payment_schedule: [projected] } })
    await user.click(screen.getByRole('tab', { name: 'Table' }))
    await user.click(screen.getByRole('row', { name: 'Edit payment 2026-02-01' }))
    await user.clear(screen.getByLabelText('Principal', { exact: true }))
    await user.type(screen.getByLabelText('Principal', { exact: true }), '1300')
    await user.click(screen.getByRole('button', { name: 'Save payment' }))
    await waitFor(() => expect(updateLoan).toHaveBeenCalledOnce())
    expect(updateLoan.mock.calls[0][2].payment_schedule).toEqual([{ ...projected, payment: '1300', principal: '1300', outstanding_loan_balance: '88700', completed: false }])
  })

  it('toggles completion with stable identity, preserves untouched decimals, and adopts server recalculations', async () => {
    const completed = { id: 'done', date: '2026-01-01', payment: '1200.123456789123456789', completed: true, projected: false }
    const future = { id: 'future', date: '2026-02-01', payment: '1200.00', completed: false, projected: true }
    const returned = { ...loan, current_balance: 87500, details: { payment_schedule: [completed, { ...future, completed: true, projected: false, outstanding_loan_balance: '87500.00' }] } }
    updateLoan.mockResolvedValue(returned)
    const { user, onSaved } = setup({ ...loan, details: { payment_schedule: [future, completed] } })
    await user.click(screen.getByRole('tab', { name: 'Table' }))
    expect(screen.getByRole('row', { name: 'Edit payment 2026-01-01' })).toHaveClass('loan-schedule-table__row--completed')
    const futureRow = screen.getByRole('row', { name: 'Edit payment 2026-02-01' })
    expect(futureRow).not.toHaveClass('loan-schedule-table__row--completed')
    await user.click(futureRow)
    const checkbox = screen.getByRole('checkbox', { name: 'Completed' })
    expect(checkbox).not.toBeChecked()
    checkbox.focus()
    await user.keyboard(' ')
    expect(checkbox).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Save payment' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(returned))
    expect(updateLoan.mock.calls[0][2].payment_schedule).toEqual([completed, { ...future, outstanding_loan_balance: '90000', completed: true, projected: false }])
    expect(screen.getByRole('row', { name: 'Edit payment 2026-02-01' })).toHaveClass('loan-schedule-table__row--completed')
    expect(screen.getByRole('table')).toHaveTextContent(fmtNumber(87500))
    await user.click(screen.getByRole('row', { name: 'Edit payment 2026-02-01' }))
    expect(screen.getByRole('checkbox', { name: 'Completed' })).toBeChecked()
    await user.click(screen.getByRole('checkbox', { name: 'Completed' }))
    await user.click(screen.getByRole('button', { name: 'Save payment' }))
    await waitFor(() => expect(updateLoan).toHaveBeenCalledTimes(2))
    expect(updateLoan.mock.calls[1][2].payment_schedule[1]).toMatchObject({ id: 'future', completed: false, projected: true })
  })

  it('retains the sheet and edits after a failed payment save and supports retry', async () => {
    updateLoan.mockRejectedValueOnce(new Error('Save unavailable'))
    const { user } = setup()
    await user.click(screen.getByRole('tab', { name: 'Table' }))
    await user.click(screen.getByRole('row', { name: 'Edit payment 2025-12-01' }))
    await user.clear(screen.getByLabelText('Interest', { exact: true }))
    await user.type(screen.getByLabelText('Interest', { exact: true }), '400')
    await user.click(screen.getByRole('button', { name: 'Save payment' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Save unavailable')
    expect(screen.getByRole('form', { name: 'Edit loan payment' })).toBeInTheDocument()
    expect(screen.getByLabelText('Interest', { exact: true })).toHaveValue(400)
    expect(screen.getByRole('button', { name: 'Save payment' })).toBeEnabled()
    const failedPayload = updateLoan.mock.calls[0][2]
    updateLoan.mockResolvedValue(loan)
    await user.click(screen.getByRole('button', { name: 'Save payment' }))
    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument())
    expect(updateLoan).toHaveBeenCalledTimes(2)
    expect(updateLoan.mock.calls[1][2]).toEqual(failedPayload)
  })

  it('resets local view/edit state when selecting a different loan and supports close controls', async () => {
    const { user, rerender, onClose } = setup()
    await user.click(screen.getByRole('button', { name: 'Loan actions' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Forecast' }))
    await user.click(screen.getByRole('tab', { name: 'Table' }))
    rerender({ ...loan, id: 'loan-2', name: 'Other loan' })
    expect(screen.getByRole('tab', { name: 'Summary' })).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('button', { name: 'Loan actions' }))
    // Forecast resets to its checked default for the newly selected loan.
    expect(screen.getByRole('menuitemcheckbox', { name: 'Forecast' })).toBeChecked()
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }))
    rerender(loan)
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close loan details' }))
    expect(onClose).toHaveBeenCalledOnce()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
