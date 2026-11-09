import type { HouseholdSettings, Invitation } from '../contracts/auth'
import type { Category } from '../contracts/expenses'
import type { EntryGroup, GroupKind } from '../contracts/utilities'
import { request } from './http'

export const householdApi = {
  getCategories: (token: string) => request<Category[]>('/household/categories', { token }),
  getGroups: (token: string, params?: { kind?: GroupKind; include_historic?: boolean }) => {
    const query = new URLSearchParams()
    if (params?.kind) {
      query.set('kind', params.kind)
    }
    if (params?.include_historic) {
      query.set('include_historic', 'true')
    }
    const suffix = query.toString()
    return request<EntryGroup[]>(`/household/groups${suffix ? `?${suffix}` : ''}`, { token })
  },
  createGroup: (
    token: string,
    payload: Omit<EntryGroup, 'id'>,
  ) => request<EntryGroup>('/household/groups', { method: 'POST', token, body: payload }),
  updateGroup: (
    token: string,
    id: string,
    payload: Omit<EntryGroup, 'id'>,
  ) => request<EntryGroup>(`/household/groups/${id}`, { method: 'PUT', token, body: payload }),
  deleteGroup: (token: string, id: string) =>
    request<{ ok: boolean }>(`/household/groups/${id}`, { method: 'DELETE', token }),
  getInvitations: (token: string) => request<Invitation[]>('/household/invitations', { token }),
  createInvitation: (token: string, payload: { email: string; role: string; relationship_kind: string }) =>
    request<Invitation>('/household/invitations', { method: 'POST', token, body: payload }),
  getSettings: (token: string) => request<HouseholdSettings>('/settings', { token }),
  updateSettings: (
    token: string,
    payload: Partial<{
      privacy_mode: string
      allow_cross_member_visibility: boolean
      projection_baseline_window_months: number
      projection_horizon_months: number
      savings_allocation_strategy: string
      role_permissions: Record<string, Record<string, Record<string, boolean>>>
    }>,
  ) => request<HouseholdSettings>('/settings', { method: 'PUT', token, body: payload }),
}
