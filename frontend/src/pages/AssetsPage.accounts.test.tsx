import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountRegistration, AccountType, AssetSummary } from '../contracts/assets'
import { HeaderSlotProvider, useHeaderSlotContext } from '../lib/header-slot'
import { api } from '../lib/api'
import { AssetsPage } from './AssetsPage'

const { usePropertiesQuery, useUtilitySubjectsQuery, setError, setMessage, refetch } = vi.hoisted(() => ({
  usePropertiesQuery: vi.fn(), useUtilitySubjectsQuery: vi.fn(), setError: vi.fn(), setMessage: vi.fn(), refetch: vi.fn(),
}))
vi.mock('../features/properties/queries', () => ({ usePropertiesQuery }))
vi.mock('../features/utilities/queries', async (original) => ({
  ...await original<typeof import('../features/utilities/queries')>(), useUtilitySubjectsQuery,
}))
vi.mock('../lib/session', () => ({ useSession: () => ({ token: 'session', currency: 'EUR', setError, setMessage }) }))

const account: AssetSummary = {
  id: 'account', name: 'Retirement stocks', kind: 'asset', category: 'account',
  account_type: 'stocks', account_registration: 'retirement', total_cost: 400,
  valuation_date: '2026-01-01', holdings: [],
}
const home: AssetSummary = { id: 'home', name: 'Home', kind: 'asset', category: 'property', total_cost: 2000, valuation_date: '2026-01-01' }
const car: AssetSummary = { id: 'car', name: 'Car', kind: 'asset', category: 'vehicle', total_cost: 800, valuation_date: '2026-01-01' }

function Header() {
  const { headerControls, headerActions } = useHeaderSlotContext()
  return <header>{headerControls}{headerActions}</header>
}
function setup(records: AssetSummary[] = [account], initialPropertyId?: string) {
  usePropertiesQuery.mockReturnValue({ data: { records, categories: [], loans: [], utilityCounts: {} }, refetch })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><HeaderSlotProvider><Header /><AssetsPage initialPropertyId={initialPropertyId} /></HeaderSlotProvider></QueryClientProvider>)
  return userEvent.setup()
}

describe('AssetsPage accounts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(api, 'getGroups').mockResolvedValue([])
    useUtilitySubjectsQuery.mockReturnValue({ data: { contracts: [], catalog: [] } })
  })

  it('groups properties, vehicles, accounts and utilities with separators and selects an account by keyboard', async () => {
    useUtilitySubjectsQuery.mockReturnValue({ data: { contracts: [{ id: 'power', name: 'Electricity' }], catalog: [] } })
    const user = setup([account, car, home])
    const selector = screen.getByRole('button', { name: 'Asset' })
    await user.click(selector)
    const menu = screen.getByRole('listbox', { name: 'Asset' })
    expect(within(menu).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'All assets', 'Home', 'Car', 'Retirement stocks', '+ New asset',
    ])
    expect(within(menu).getAllByRole('separator')).toHaveLength(4)
    within(menu).getByRole('option', { name: 'All assets' }).focus()
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Enter}')
    expect(selector).toHaveTextContent('Retirement stocks')
    expect(selector).toHaveFocus()
    expect(await screen.findByRole('heading', { name: 'Holdings' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Projects' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Loans' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add asset, utility, or project' })).not.toBeInTheDocument()
  })

  it('keeps legacy unassigned groups visible without writable controls', async () => {
    vi.mocked(api.getGroups).mockResolvedValue([{ id: 'legacy', name: 'Old power', kind: 'contract', group_type: 'contract', notes: '', metadata_payload: {}, sort_order: 0, tracked_fields: [] }])
    vi.spyOn(api, 'getUtilityBoard').mockResolvedValue({ subject: { id: 'legacy', kind: 'contract', name: 'Old power', group_type: 'contract', notes: '', tracked_fields: [] }, trend: [], months: [] })
    const user = setup([home])
    await user.click(screen.getByRole('button', { name: 'Asset' }))
    await user.click(await screen.findByRole('option', { name: 'Old power (legacy history)' }))
    expect(screen.getByRole('status')).toHaveTextContent('Legacy unassigned history—requires explicit property resolution')
    expect(screen.queryByRole('button', { name: 'Old power options' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add asset, utility, or project' })).not.toBeInTheDocument()
    expect(api.getGroups).toHaveBeenCalledWith('session', { kind: 'contract', include_historic: true })
  })

  it('orders scrambled accounts by savings, stocks and options using separators without headings', async () => {
    const user = setup([
      { ...account, id: 'options', name: 'Options account', account_type: 'options' },
      account,
      { ...account, id: 'savings', name: 'Cash savings', account_type: 'savings' },
    ])
    await user.click(screen.getByRole('button', { name: 'Asset' }))
    const menu = screen.getByRole('listbox', { name: 'Asset' })
    expect(within(menu).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'All assets', 'Cash savings', 'Retirement stocks', 'Options account', '+ New asset',
    ])
    expect(within(menu).getAllByRole('separator')).toHaveLength(4)
    expect(within(menu).queryByRole('heading')).not.toBeInTheDocument()
    expect(within(menu).queryByText('Savings', { exact: true })).not.toBeInTheDocument()
    expect(within(menu).queryByText('Stocks', { exact: true })).not.toBeInTheDocument()
    expect(within(menu).queryByText('Options', { exact: true })).not.toBeInTheDocument()
  })

  it.each([
    ['savings', 'regular'], ['savings', 'retirement'], ['stocks', 'regular'],
    ['stocks', 'retirement'], ['options', 'regular'], ['options', 'retirement'],
  ] satisfies [AccountType, AccountRegistration][])('creates a %s %s account with the chosen transport metadata', async (type, registration) => {
    const create = vi.spyOn(api, 'createAsset').mockResolvedValue({ id: account.id, name: account.name, record_type: 'asset' })
    const user = setup([])
    await user.click(screen.getByRole('button', { name: 'Add asset, utility, or project' }))
    const dialog = screen.getByRole('dialog')
    await user.selectOptions(within(dialog).getByLabelText('Kind'), 'account')
    await user.selectOptions(within(dialog).getByLabelText('Account type'), type)
    await user.selectOptions(within(dialog).getByLabelText('Registration'), registration)
    await user.type(within(dialog).getByLabelText('Name'), 'My account')
    await user.type(within(dialog).getByLabelText('Value'), '123.45')
    await user.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(create).toHaveBeenCalledWith('session', expect.objectContaining({
      name: 'My account', category: 'account', account_type: type,
      account_registration: registration, total_cost: 123.45,
    }))
    await waitFor(() => expect(setMessage).toHaveBeenCalledWith('Account saved.'))
    create.mockRestore()
  })

  it('moves utility management to Configuration while retaining utility values in Add', async () => {
    vi.spyOn(api, 'listUtilityContracts').mockResolvedValue([])
    useUtilitySubjectsQuery.mockReturnValue({ data: { contracts: [{ id: 'power', name: 'Electricity', tracked_fields: [] }], catalog: [] } })
    const user = setup([home], 'home')
    await user.click(screen.getByRole('button', { name: 'Add asset, utility, or project' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Project' }))
    const kind = screen.getByRole('listbox', { name: 'Add type' })
    expect(within(kind).queryByRole('option', { name: 'Utility' })).not.toBeInTheDocument()
    expect(within(kind).getByRole('option', { name: 'Utility values' })).toBeInTheDocument()
    await user.keyboard('{Escape}{Escape}')
    await user.click(screen.getByRole('button', { name: 'Home options' }))
    await user.click(screen.getByRole('menuitem', { name: 'Configuration' }))
    expect(screen.getByRole('dialog', { name: 'Utility contracts' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Utility contracts options' }))
    await user.click(screen.getByRole('menuitem', { name: 'New utility contract' }))
    expect(screen.getByLabelText('Tracking')).toBeInTheDocument()
    expect(screen.queryByText(/permanently belongs/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Kind')).not.toBeInTheDocument()
    vi.restoreAllMocks()
  })

  it('keeps unknown account deep links on the all-assets overview', async () => {
    setup([account], 'missing')
    expect(await screen.findByRole('heading', { name: '1 Account' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Holdings' })).not.toBeInTheDocument()
  })
})
