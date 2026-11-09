import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import type { NetWorthComponentRow } from '../../contracts/dashboard'
import { NetWorthMonthEditor } from './NetWorthMonthEditor'

const { updateNetWorthMonth, setMessage } = vi.hoisted(() => ({ updateNetWorthMonth: vi.fn(), setMessage: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: { updateNetWorthMonth } }))
vi.mock('../../lib/session', () => ({ useSession: () => ({ token: 'token', setMessage }) }))
const row: NetWorthComponentRow = {
  period: '2026-02', completed: false, total: 90,
  investing: { total: 100, components: { ETF: 100 } },
  savings: { total: 0, components: { Cash: 0 } },
  non_liquid_assets: { total: 0, components: {} },
  debt: { total: 10, components: { Loan: 10 } },
}
function setup(completed = false, sourceRow = row) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const onSaved = vi.fn()
  render(<QueryClientProvider client={client}><NetWorthMonthEditor row={{ ...sourceRow, completed }} onSaved={onSaved} onClose={vi.fn()} /></QueryClientProvider>)
  return { user: userEvent.setup(), onSaved }
}
beforeEach(() => { vi.clearAllMocks(); updateNetWorthMonth.mockResolvedValue(row) })

it('opens the month picker from the header and selects another month without saving', async () => {
  const onPeriodChange = vi.fn()
  const client = new QueryClient()
  render(<QueryClientProvider client={client}><NetWorthMonthEditor row={row} onPeriodChange={onPeriodChange} onSaved={vi.fn()} onClose={vi.fn()} /></QueryClientProvider>)
  await userEvent.click(screen.getByRole('button', { name: 'Change month, 2026-02' }))
  const picker = screen.getByLabelText('Net worth month')
  expect(picker).toHaveAttribute('type', 'month')
  fireEvent.change(picker, { target: { value: '2027-01' } })
  expect(onPeriodChange).toHaveBeenCalledWith('2027-01')
  expect(updateNetWorthMonth).not.toHaveBeenCalled()
})

it('edits, adds, and removes manual subgroups, preserving zero values', async () => {
  const { user, onSaved } = setup()
  expect(screen.getByLabelText('Savings value')).toHaveValue(0)
  await user.clear(screen.getByLabelText('Investing value'))
  await user.type(screen.getByLabelText('Investing value'), '120.25')
  await user.click(screen.getByRole('button', { name: 'Remove Loan subgroup' }))
  await user.click(screen.getByRole('button', { name: 'Add fixed assets subgroup' }))
  await user.type(screen.getByLabelText('Fixed assets subgroup'), 'House')
  await user.type(screen.getByLabelText('Fixed assets value'), '200')
  await user.click(screen.getByRole('button', { name: 'Save month' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
  expect(updateNetWorthMonth).toHaveBeenCalledWith('token', '2026-02', { completed: false, components: [
    { group_key: 'investing', label: 'ETF', value: 120.25 },
    { group_key: 'savings', label: 'Cash', value: 0 },
    { group_key: 'non_liquid_assets', label: 'House', value: 200 },
  ] })
})

it('locks completed values and add/remove controls until unticked', async () => {
  const { user } = setup(true)
  expect(screen.getByLabelText('Investing value')).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Remove ETF subgroup' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Add savings subgroup' })).toBeDisabled()
  expect(screen.getByLabelText('Completed')).toBeEnabled()
  await user.click(screen.getByLabelText('Completed'))
  expect(screen.getByLabelText('Investing value')).toBeEnabled()
  await user.click(screen.getByRole('button', { name: 'Save month' }))
  await waitFor(() => expect(updateNetWorthMonth).toHaveBeenCalled())
  expect(updateNetWorthMonth.mock.calls[0][2].completed).toBe(false)
})

it('saves an untouched completed month with one idempotent request', async () => {
  const { user, onSaved } = setup(true)
  await user.click(screen.getByRole('button', { name: 'Save month' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
  expect(updateNetWorthMonth).toHaveBeenCalledTimes(1)
  expect(updateNetWorthMonth).toHaveBeenCalledWith('token', '2026-02', { completed: true, components: [
    { group_key: 'investing', label: 'ETF', value: 100 },
    { group_key: 'savings', label: 'Cash', value: 0 },
    { group_key: 'debt', label: 'Loan', value: 10 },
  ] })
})

it('reopens an edited completed month before completing it again in one save', async () => {
  const { user, onSaved } = setup(true)
  await user.click(screen.getByLabelText('Completed'))
  await user.clear(screen.getByLabelText('Investing value'))
  await user.type(screen.getByLabelText('Investing value'), '150')
  await user.click(screen.getByLabelText('Completed'))
  await user.click(screen.getByRole('button', { name: 'Save month' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce())
  expect(updateNetWorthMonth).toHaveBeenCalledTimes(2)
  // The reopen applies the new values; the completion then marks it done.
  expect(updateNetWorthMonth.mock.calls[0]).toEqual(['token', '2026-02', { completed: false, components: [
    { group_key: 'investing', label: 'ETF', value: 150 },
    { group_key: 'savings', label: 'Cash', value: 0 },
    { group_key: 'debt', label: 'Loan', value: 10 },
  ] }])
  expect(updateNetWorthMonth.mock.calls[1]).toEqual(['token', '2026-02', { completed: true, components: [
    { group_key: 'investing', label: 'ETF', value: 150 },
    { group_key: 'savings', label: 'Cash', value: 0 },
    { group_key: 'debt', label: 'Loan', value: 10 },
  ] }])
})

it('keeps the draft and displays persistence errors', async () => {
  updateNetWorthMonth.mockRejectedValue(new Error('Month is frozen.'))
  const { user, onSaved } = setup()
  await user.click(screen.getByRole('button', { name: 'Save month' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Month is frozen.')
  expect(screen.getByLabelText('Investing subgroup')).toHaveValue('ETF')
  expect(onSaved).not.toHaveBeenCalled()
})

const automaticRow: NetWorthComponentRow = {
  ...row,
  non_liquid_assets: { total: 250, components: {}, automatic_components: { House: 250, 'Zero property': 0 } },
  debt: { total: 60, components: { Loan: 10 }, automatic_components: { Mortgage: 50, 'Paid off loan': 0 } },
}

it('shows non-editable source subgroups, includes their totals, and submits manual values only', async () => {
  const { user } = setup(false, automaticRow)
  expect(screen.getByLabelText('House automatic value')).toHaveTextContent('250')
  expect(screen.getByLabelText('Mortgage automatic value')).toHaveTextContent('50')
  expect(screen.queryByText(/Automatic from/)).not.toBeInTheDocument()
  expect(screen.queryByText(/Edit manual monthly values|Property and loan values are automatic/)).not.toBeInTheDocument()
  expect(screen.getByText('Net worth')).toHaveTextContent('290')
  expect(screen.queryByText('Zero property')).not.toBeInTheDocument()
  expect(screen.queryByText('Paid off loan')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Remove House subgroup' })).not.toBeInTheDocument()
  expect(screen.queryByDisplayValue('House')).not.toBeInTheDocument()
  await user.click(screen.getByLabelText('Completed'))
  expect(screen.getByLabelText('Investing value')).toBeDisabled()
  expect(screen.getByLabelText('House automatic value')).toHaveTextContent('250')
  await user.click(screen.getByRole('button', { name: 'Save month' }))
  await waitFor(() => expect(updateNetWorthMonth).toHaveBeenCalledWith('token', '2026-02', {
    completed: true,
    components: [
      { group_key: 'investing', label: 'ETF', value: 100 },
      { group_key: 'savings', label: 'Cash', value: 0 },
      { group_key: 'debt', label: 'Loan', value: 10 },
    ],
  }))
})

it('keeps automatic values live on refreshed completed month props without replacing the manual draft', () => {
  const client = new QueryClient()
  const renderEditor = (sourceRow: NetWorthComponentRow) => <QueryClientProvider client={client}>
    <NetWorthMonthEditor row={{ ...sourceRow, completed: true }} onSaved={vi.fn()} onClose={vi.fn()} />
  </QueryClientProvider>
  const { rerender } = render(renderEditor(automaticRow))
  expect(screen.getByLabelText('Investing value')).toBeDisabled()
  rerender(renderEditor({ ...automaticRow,
    non_liquid_assets: { total: 400, components: {}, automatic_components: { House: 400 } },
    debt: { total: 10, components: { Loan: 10 }, automatic_components: {} },
  }))
  expect(screen.getByLabelText('House automatic value')).toHaveTextContent('400')
  expect(screen.queryByLabelText('Mortgage automatic value')).not.toBeInTheDocument()
  expect(screen.getByText('Net worth')).toHaveTextContent('490')
  expect(screen.getByLabelText('Investing value')).toHaveValue(100)
})
