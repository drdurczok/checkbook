import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../../lib/api'
import { SessionProvider, useSession } from '../../lib/session'
import type { AssetSummary, SessionResponse } from '../../types'
import type { PropertySavePayload } from './types'
import { usePropertyMutations } from './usePropertyMutations'

const property: AssetSummary = {
  id: 'property-1',
  name: 'Home',
  total_cost: 100,
  valuation_date: '2026-01-01',
  details: {},
}

const session: SessionResponse = {
  token: 'token',
  expires_at: '2099-01-01T00:00:00Z',
  user: { id: 'user-1', email: 'owner@example.com', full_name: 'Owner', picture_url: '' },
  household: { id: 'house-1', name: 'Household', base_currency: 'PLN', timezone: 'Europe/Warsaw' },
  membership: { id: 'membership-1', role: 'owner', relationship_kind: 'owner' },
  settings: {
    id: 'settings-1',
    privacy_mode: 'household',
    allow_cross_member_visibility: true,
    projection_baseline_window_months: 12,
    projection_horizon_months: 24,
    savings_allocation_strategy: 'default',
    role_permissions: {},
  },
}

const payload: PropertySavePayload = {
  name: 'Updated home',
  total_cost: 120,
  valuation_date: '2026-02-01',
  started_on: null,
  ended_on: null,
  notes: '',
  category: 'property',
  depreciation_rate: 0,
  depreciation_enabled: false,
  utilities_enabled: true,
  projects_enabled: true,
  expenses_enabled: true,
  linked_category_ids: [],
  details: {},
}

function Harness() {
  const { applySession } = useSession()
  const [selected, setSelected] = useState<AssetSummary | null>(property)
  const mutations = usePropertyMutations({
    selectedProperty: selected,
    setSelectedProperty: setSelected,
    updateRecord: setSelected,
  })

  useEffect(() => applySession(session), [applySession])

  return (
    <>
      <span>{selected?.name}</span>
      <button onClick={() => void mutations.save(payload)} type="button">Update</button>
    </>
  )
}

describe('usePropertyMutations', () => {
  it('updates the shared record and selected property through one mutation path', async () => {
    vi.spyOn(api, 'updateAsset').mockResolvedValue({ ...property, ...payload })
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    render(
      <QueryClientProvider client={client}>
        <SessionProvider><Harness /></SessionProvider>
      </QueryClientProvider>,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Update' }))
    await waitFor(() => expect(screen.getByText('Updated home')).toBeInTheDocument())
    expect(api.updateAsset).toHaveBeenCalledWith('token', 'property-1', payload)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['overview'] })
  })
})
