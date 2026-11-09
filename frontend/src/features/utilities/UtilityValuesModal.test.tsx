import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { UtilityValuesModal } from './UtilityValuesModal'

const mocks = vi.hoisted(() => ({ getUtilityForm: vi.fn(), upsertUtilityEntries: vi.fn(), setError: vi.fn(), setMessage: vi.fn() }))
vi.mock('../../lib/api', () => ({ api: mocks }))
vi.mock('../../lib/session', () => ({ useSession: () => ({ token: 'test', currency: 'PLN', setError: mocks.setError, setMessage: mocks.setMessage }) }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getUtilityForm.mockResolvedValue({ month: '2026-11', fields: [
    { key: 'water', label: 'Water', kind: 'metered', unit: 'm3', entry_mode: 'meter', unit_rate: 2, previous_meter_reading: 100 },
    { key: 'electricity', label: 'Electricity', kind: 'metered', unit: 'kWh', entry_mode: 'usage', unit_rate: 0.5 },
  ] })
  mocks.upsertUtilityEntries.mockResolvedValue({})
})

it('shows configured inputs, previews differences and submits measurements only for priced utilities', async () => {
  const user = userEvent.setup()
  const onClose = vi.fn()
  const onSaved = vi.fn()
  render(<UtilityValuesModal subject={{ type: 'property', id: 'home' }} subjectName="Home" initialMonth="2026-11" onClose={onClose} onSaved={onSaved} />)
  await user.click(await screen.findByRole('button', { name: 'Edit Water' }))
  await user.type(screen.getByRole('textbox', { name: 'Water meter reading' }), '110')
  await user.click(screen.getByRole('button', { name: 'Edit Electricity' }))
  await user.type(screen.getByRole('textbox', { name: 'Electricity usage amount' }), '20')
  expect(screen.queryByRole('textbox', { name: 'Water amount' })).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox', { name: 'Electricity meter reading' })).not.toBeInTheDocument()
  expect(screen.getByText(/Usage: 10 m3/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(mocks.upsertUtilityEntries).toHaveBeenCalledWith('test', {
    month: '2026-11', completed: false, entries: [
      { field_key: 'water', amount_source: 'auto', amount: null, meter_reading: 110, usage_amount: null },
      { field_key: 'electricity', amount_source: 'auto', amount: null, meter_reading: null, usage_amount: 20 },
    ],
  }, { propertyId: 'home', groupId: undefined }))
  expect(onSaved).toHaveBeenCalled()
  expect(onClose).toHaveBeenCalled()
})

it('rejects decreasing readings before sending a request', async () => {
  const user = userEvent.setup()
  render(<UtilityValuesModal subject={{ type: 'property', id: 'home' }} subjectName="Home" initialMonth="2026-11" onClose={vi.fn()} onSaved={vi.fn()} />)
  await user.click(await screen.findByRole('button', { name: 'Edit Water' }))
  await user.type(screen.getByRole('textbox', { name: 'Water meter reading' }), '99')
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(mocks.upsertUtilityEntries).not.toHaveBeenCalled()
  expect(mocks.setError).toHaveBeenCalledWith('Water meter reading cannot be below the previous reading.')
})

it('disables saving while a new month is loading', async () => {
  mocks.getUtilityForm.mockReturnValue(new Promise(() => {}))
  render(<UtilityValuesModal subject={{ type: 'contract', id: 'contract' }} subjectName="Contract" onClose={vi.fn()} onSaved={vi.fn()} />)
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  expect(screen.getByRole('status')).toHaveTextContent('Loading utility values')
})
