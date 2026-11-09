import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LoanEditor } from './LoanEditor'
import type { LoanSummary } from '../../contracts/dashboard'

const { updateLoan, setMessage } = vi.hoisted(() => ({ updateLoan: vi.fn(), setMessage: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: { updateLoan } }))
vi.mock('../../lib/session', () => ({ useSession: () => ({ token: 'token', setMessage }) }))

const loan: LoanSummary = {
  id: 'loan-1', name: 'Mortgage', current_balance: 90000, monthly_payment: 1000,
  interest_rate: 0.05, original_balance: 100000, start_date: '2025-01-01',
  notes: 'Keep this note', linked_property_id: null,
}

function setup(record = loan) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  const onSaved = vi.fn()
  const onCancel = vi.fn()
  render(<QueryClientProvider client={queryClient}>
    <LoanEditor loan={record} properties={[{ id: 'property-1', name: 'Home', total_cost: 100000, valuation_date: '2025-01-01' }]} onSaved={onSaved} onCancel={onCancel} />
  </QueryClientProvider>)
  return { user: userEvent.setup(), onSaved, onCancel, invalidate }
}

beforeEach(() => vi.clearAllMocks())

describe('LoanEditor', () => {
  it('saves a property link and preserves the other fields, invalidating dependent views', async () => {
    updateLoan.mockResolvedValue({ ...loan, linked_property_id: 'property-1' })
    const { user, onSaved, invalidate } = setup()
    expect(screen.queryByLabelText('Current balance')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Monthly payment')).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Linked property'), 'property-1')
    await user.click(screen.getByRole('button', { name: 'Save loan' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(updateLoan).toHaveBeenCalledWith('token', 'loan-1', {
      name: 'Mortgage', interest_rate: 0.05,
      original_balance: 100000, start_date: '2025-01-01', end_date: null,
      notes: 'Keep this note', linked_property_id: 'property-1',
    })
    for (const key of ['properties', 'overview', 'expenses', 'planning']) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: [key] })
    }
  })

  it('submits the loan terms and dates without overriding table-derived amounts', async () => {
    updateLoan.mockResolvedValue(loan)
    const { user, onSaved } = setup()
    await user.clear(screen.getByLabelText('Original balance'))
    await user.type(screen.getByLabelText('Original balance'), '120000')
    await user.clear(screen.getByLabelText('Interest rate'))
    await user.type(screen.getByLabelText('Interest rate'), '0.06')
    await user.type(screen.getByLabelText('End date'), '2030-01-01')
    await user.click(screen.getByRole('button', { name: 'Save loan' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const payload = updateLoan.mock.calls[0][2]
    expect(payload).toMatchObject({
      original_balance: 120000, interest_rate: 0.06,
      start_date: '2025-01-01', end_date: '2030-01-01',
    })
    expect(payload).not.toHaveProperty('current_balance')
    expect(payload).not.toHaveProperty('monthly_payment')
    expect(payload).not.toHaveProperty('payment_schedule')
  })

  it('allows unlinking a loan', async () => {
    updateLoan.mockResolvedValue({ ...loan, linked_property_id: null })
    const { user, onSaved } = setup({ ...loan, linked_property_id: 'property-1' })
    await user.selectOptions(screen.getByLabelText('Linked property'), '')
    await user.click(screen.getByRole('button', { name: 'Save loan' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(updateLoan.mock.calls[0][2].linked_property_id).toBeNull()
  })

  it('keeps the draft after a failed save and supports cancel without saving', async () => {
    updateLoan.mockRejectedValue(new Error('Property unavailable.'))
    const { user, onSaved, onCancel } = setup()
    await user.selectOptions(screen.getByLabelText('Linked property'), 'property-1')
    await user.click(screen.getByRole('button', { name: 'Save loan' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Property unavailable.')
    expect(screen.getByLabelText('Linked property')).toHaveValue('property-1')
    expect(onSaved).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(updateLoan).toHaveBeenCalledOnce()
  })
})
