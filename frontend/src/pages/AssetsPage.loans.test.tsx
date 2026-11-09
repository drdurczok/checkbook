import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssetSummary, LoanSummary } from '../types'
import { HeaderSlotProvider } from '../lib/header-slot'
import { AssetsPage } from './AssetsPage'

const { usePropertiesQuery, setError, setMessage } = vi.hoisted(() => ({
  usePropertiesQuery: vi.fn(),
  setError: vi.fn(),
  setMessage: vi.fn(),
}))

vi.mock('../features/properties/queries', () => ({ usePropertiesQuery }))
vi.mock('../lib/session', () => ({
  useSession: () => ({ token: '', currency: 'EUR', setError, setMessage }),
}))

const property: AssetSummary = {
  id: 'home', name: 'Family home', kind: 'asset', category: 'property',
  total_cost: 250000, valuation_date: '2026-01-01', utilities_enabled: false,
}
const project: AssetSummary = {
  id: 'renovation', name: 'Kitchen renovation', kind: 'project',
  total_cost: 15000, valuation_date: '2026-01-01', linked_asset_id: property.id,
}
const mortgage: LoanSummary = {
  id: 'mortgage', name: 'Home mortgage', current_balance: 125000, monthly_payment: 950,
  interest_rate: 3.5, linked_property_id: property.id,
}
const unrelatedLoan: LoanSummary = {
  id: 'car-loan', name: 'Car loan', current_balance: 6000, monthly_payment: 125,
  interest_rate: 4, linked_property_id: 'car',
}

function renderProperties(records: AssetSummary[] = [property, project], loans: LoanSummary[] = [mortgage, unrelatedLoan]) {
  usePropertiesQuery.mockReturnValue({ data: { records, categories: [], loans, utilityCounts: {} } })
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <HeaderSlotProvider>
        <AssetsPage initialPropertyId={property.id} />
      </HeaderSlotProvider>
    </QueryClientProvider>,
  )
}

describe('AssetsPage linked loan cards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('places linked loan cards after the Projects section and excludes other properties loans', async () => {
    renderProperties()

    const projectsHeading = await screen.findByRole('heading', { name: 'Projects' })
    const loansHeading = screen.getByRole('heading', { name: 'Loans' })
    expect(projectsHeading.compareDocumentPosition(loansHeading) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    const card = screen.getByRole('button', { name: mortgage.name })
    expect(card).toHaveClass('property-loans__card')
    expect(within(card).getByRole('progressbar')).toBeInTheDocument()
    expect(within(card).queryByText(/Current balance:|Monthly payment:/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Kitchen renovation/ })).toHaveClass('gantt__card')
    expect(screen.queryByRole('button', { name: unrelatedLoan.name })).not.toBeInTheDocument()
  })

  it('keeps loan cards below the empty projects state', async () => {
    renderProperties([property])

    const emptyProjects = await screen.findByRole('heading', { name: 'No projects for this property' })
    const card = screen.getByRole('button', { name: mortgage.name })
    expect(emptyProjects.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })

  it('hides the loans section when none are linked to the selected property', async () => {
    renderProperties([property], [unrelatedLoan])

    expect(await screen.findByRole('heading', { name: 'No projects for this property' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Loans' })).not.toBeInTheDocument()
  })

  it('opens the existing loan detail dialog from a card and restores focus on Escape', async () => {
    const user = userEvent.setup()
    renderProperties()

    const card = await screen.findByRole('button', { name: mortgage.name })
    await user.click(card)
    const dialog = screen.getByRole('dialog', { name: /Home mortgage/ })
    expect(within(dialog).getByRole('tab', { name: 'Summary', selected: true })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Loan actions' })).toBeInTheDocument()
    expect(dialog.contains(document.activeElement)).toBe(true)

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(card).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(screen.getByRole('dialog', { name: /Home mortgage/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close loan details' }))
    expect(card).toHaveFocus()
  })

  it('shows loans even when project tracking is disabled', async () => {
    renderProperties([{ ...property, projects_enabled: false }])

    expect(await screen.findByRole('button', { name: mortgage.name })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Projects' })).not.toBeInTheDocument()
  })
})
