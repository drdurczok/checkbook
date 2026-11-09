import type { ManualRecordResponse } from '../contracts/assets'
import type { UtilityContract, UtilityContractConfiguration, UtilityContractPrice, TrackedField, UtilityBoard, UtilityEntryForm, UtilityEntryValue, UtilityFieldAudit, UtilityFieldConfiguration, UtilityFieldCreate } from '../contracts/utilities'
import { request } from './http'

export const utilitiesApi = {
  listUtilityContracts: (token: string, propertyId: string) =>
    request<UtilityContract[]>(`/household/utilities/contracts?property_id=${encodeURIComponent(propertyId)}`, { token }),
  createUtilityContract: (token: string, payload: UtilityContractConfiguration & { property_id: string; initial_price?: number | null }) =>
    request<UtilityContract>('/household/utilities/contracts', { method: 'POST', token, body: payload }),
  updateUtilityContract: (token: string, id: string, payload: UtilityContractConfiguration) =>
    request<UtilityContract>(`/household/utilities/contracts/${encodeURIComponent(id)}`, { method: 'PUT', token, body: payload }),
  reorderUtilityContracts: (token: string, propertyId: string, orderedIds: string[]) =>
    request<UtilityContract[]>('/household/utilities/contracts/reorder', {
      method: 'POST',
      token,
      body: { property_id: propertyId, ordered_ids: orderedIds },
    }),
  listUtilityContractPrices: (token: string, id: string) =>
    request<UtilityContractPrice[]>(`/household/utilities/contracts/${encodeURIComponent(id)}/prices`, { token }),
  createUtilityContractPrice: (token: string, id: string, payload: { effective_on: string; price: number }) =>
    request<UtilityContractPrice>(`/household/utilities/contracts/${encodeURIComponent(id)}/prices`, { method: 'POST', token, body: payload }),
  updateUtilityContractPrice: (token: string, id: string, priceId: string, payload: { effective_on: string; price: number }) =>
    request<UtilityContractPrice>(`/household/utilities/contracts/${encodeURIComponent(id)}/prices/${encodeURIComponent(priceId)}`, { method: 'PUT', token, body: payload }),
  getUtilityFieldCatalog: (token: string) => request<TrackedField[]>('/household/utility-field-catalog', { token }),
  reorderUtilityFields: (token: string, payload: { keys: string[] }) =>
    request<TrackedField[]>('/household/utility-field-order', { method: 'POST', token, body: payload }),
  createUtilityField: (token: string, payload: UtilityFieldCreate) =>
    request<TrackedField>('/household/utility-field-catalog', { method: 'POST', token, body: payload }),
  updateUtilityField: (token: string, key: string, payload: UtilityFieldConfiguration) =>
    request<TrackedField>(`/household/utility-field-catalog/${encodeURIComponent(key)}`, { method: 'PUT', token, body: payload }),
  updateUtilityFieldLifecycle: (token: string, key: string, payload: { retired: boolean; hidden: boolean }) =>
    request<TrackedField>(`/household/utility-field-catalog/${encodeURIComponent(key)}/lifecycle`, { method: 'PATCH', token, body: payload }),
  deleteUtilityField: (token: string, key: string) =>
    request<void>(`/household/utility-field-catalog/${encodeURIComponent(key)}`, { method: 'DELETE', token }),
  listUtilityFieldAudit: (token: string, key: string) =>
    request<UtilityFieldAudit[]>(`/household/utility-field-catalog/${encodeURIComponent(key)}/audit`, { token }),
  getUtilityBoard: (token: string, params?: { propertyId?: string | null; groupId?: string | null; months?: number }) => {
    const query = new URLSearchParams()
    if (params?.propertyId) {
      query.set('property_id', params.propertyId)
    }
    if (params?.groupId) {
      query.set('group_id', params.groupId)
    }
    if (params?.months !== undefined) {
      query.set('months', String(params.months))
    }
    const suffix = query.toString()
    return request<UtilityBoard>(`/household/utilities/board${suffix ? `?${suffix}` : ''}`, { token })
  },
  getUtilityForm: (token: string, params?: { propertyId?: string | null; groupId?: string | null; month?: string }) => {
    const query = new URLSearchParams()
    if (params?.propertyId) {
      query.set('property_id', params.propertyId)
    }
    if (params?.groupId) {
      query.set('group_id', params.groupId)
    }
    if (params?.month) {
      query.set('month', params.month)
    }
    const suffix = query.toString()
    return request<UtilityEntryForm>(`/household/utilities/form${suffix ? `?${suffix}` : ''}`, { token })
  },
  upsertUtilityEntries: (
    token: string,
    payload: { month: string; completed?: boolean; entries: UtilityEntryValue[] },
    subject?: { propertyId?: string | null; groupId?: string | null },
  ) => {
    const query = new URLSearchParams()
    if (subject?.propertyId) {
      query.set('property_id', subject.propertyId)
    }
    if (subject?.groupId) {
      query.set('group_id', subject.groupId)
    }
    const suffix = query.toString()
    return request<UtilityBoard>(`/household/utilities/upsert${suffix ? `?${suffix}` : ''}`, { method: 'POST', token, body: payload })
  },
  reassignUtilities: (token: string, fromPropertyId: string, toPropertyId: string) =>
    request<{ moved: number }>('/household/utilities/reassign', {
      method: 'POST',
      token,
      body: { from_property_id: fromPropertyId, to_property_id: toPropertyId },
    }),
  trackUtilityField: (token: string, propertyId: string, fieldKey: string) =>
    request<UtilityBoard>('/household/utilities/track-field', {
      method: 'POST',
      token,
      body: { property_id: propertyId, field_key: fieldKey },
    }),
  untrackUtilityField: (token: string, propertyId: string, fieldKey: string) =>
    request<UtilityBoard>('/household/utilities/untrack-field', {
      method: 'POST',
      token,
      body: { property_id: propertyId, field_key: fieldKey },
    }),
  createUtility: (
    token: string,
    payload: {
      provider: string
      description: string
      amount: number
      charge_date: string
      owner_scope: string
      category_name: string
      group_id?: string | null
      service_key?: string | null
      usage_amount?: number | null
      usage_unit?: string
      meter_reading?: number | null
      notes?: string
    },
  ) => request<ManualRecordResponse>('/household/utilities', { method: 'POST', token, body: payload }),
}
