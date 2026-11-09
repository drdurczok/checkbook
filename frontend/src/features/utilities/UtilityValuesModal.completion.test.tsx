import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { UtilityValuesModal } from './UtilityValuesModal'

const mocks = vi.hoisted(() => ({ getUtilityForm: vi.fn(), upsertUtilityEntries: vi.fn(), setError: vi.fn(), setMessage: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: mocks }))
vi.mock('../../lib/session', () => ({ useSession: () => ({ token: 'test', currency: 'PLN', setError: mocks.setError, setMessage: mocks.setMessage }) }))
const fields = [
  { key: 'water', label: 'Water', kind: 'metered', unit: 'm3', entry_mode: 'meter', unit_rate: 2, meter_reading: 110, previous_meter_reading: 100 },
  { key: 'rent', label: 'Rent', kind: 'cost', unit: '', amount: 500, previous_amount: 450 },
]
function setup(completed = false) {
  mocks.getUtilityForm.mockResolvedValue({ month: '2026-11', completed, fields })
  render(<UtilityValuesModal subject={{ type: 'property', id: 'home' }} subjectName="Home" initialMonth="2026-11" onClose={vi.fn()} onSaved={vi.fn()} />)
  return userEvent.setup()
}
beforeEach(() => { vi.clearAllMocks(); mocks.upsertUtilityEntries.mockResolvedValue({}) })

it('shows labels and hides previous hints until the individual utility is edited', async () => {
  const user = setup()
  await screen.findByRole('button', { name: 'Edit Water' })
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(screen.getByText('110 m3')).toBeInTheDocument()
  expect(screen.queryByText(/Previous reading/)).not.toBeInTheDocument()
  expect(screen.queryByText(/Last /)).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Edit Water' }))
  expect(screen.getByRole('textbox', { name: 'Water meter reading' })).toHaveValue('110')
  expect(screen.getByText('Previous reading: 100 m3')).toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: 'Rent amount' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Done editing Water' }))
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
})

it('locks per-utility edits when completed and persists the month status without resubmitting values', async () => {
  const user = setup()
  await user.click(await screen.findByRole('button', { name: 'Edit Rent' }))
  await user.click(screen.getByRole('checkbox', { name: 'Completed' }))
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Edit Rent' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Edit Water' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(mocks.upsertUtilityEntries).toHaveBeenCalledWith('test', { month: '2026-11', completed: true, entries: [] }, { propertyId: 'home', groupId: undefined }))
})

it('keeps edits available and retries when recompleting fails after reopening', async () => {
  const user = setup(true)
  await screen.findByRole('button', { name: 'Edit Rent' })
  await user.click(screen.getByRole('checkbox', { name: 'Completed' }))
  await user.click(screen.getByRole('button', { name: 'Edit Rent' }))
  await user.clear(screen.getByRole('textbox', { name: 'Rent amount' }))
  await user.type(screen.getByRole('textbox', { name: 'Rent amount' }), '600')
  await user.click(screen.getByRole('checkbox', { name: 'Completed' }))
  mocks.upsertUtilityEntries.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Completion failed'))
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Completion failed')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(mocks.upsertUtilityEntries).toHaveBeenCalledTimes(3))
  expect(mocks.upsertUtilityEntries.mock.calls[2][1]).toMatchObject({ completed: true })
})

it('loads completed status and explicitly reopens before saving edits and recompleting', async () => {
  const user = setup(true)
  expect(await screen.findByRole('button', { name: 'Edit Rent' })).toBeDisabled()
  await user.click(screen.getByRole('checkbox', { name: 'Completed' }))
  await user.click(screen.getByRole('button', { name: 'Edit Rent' }))
  await user.clear(screen.getByRole('textbox', { name: 'Rent amount' }))
  await user.type(screen.getByRole('textbox', { name: 'Rent amount' }), '600')
  await user.click(screen.getByRole('checkbox', { name: 'Completed' }))
  await user.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(mocks.upsertUtilityEntries).toHaveBeenCalledTimes(2))
  expect(mocks.upsertUtilityEntries.mock.calls[0][1]).toEqual({ month: '2026-11', completed: false, entries: [{ field_key: 'rent', amount_source: 'actual', amount: 600, meter_reading: null, usage_amount: null }] })
  expect(mocks.upsertUtilityEntries.mock.calls[1][1]).toEqual({ month: '2026-11', completed: true, entries: [] })
})
