import type { AccountHolding, AccountRegistration, AccountType, AssetSummary, HoldingPricesResponse, ManualRecordResponse, PropertyValuation } from '../contracts/assets'
import type { LoanSummary } from '../contracts/dashboard'
import type { LoanUpdatePayload } from '../contracts/loans'
import { request } from './http'

/** Account fields are accepted by the API only when category='account'. */
type AccountFields = {
  account_type?: AccountType | null
  account_registration?: AccountRegistration | null
  /** Replace-all semantics: every save sends the complete holdings list. */
  holdings?: Array<Omit<AccountHolding, 'id'>>
}

export const assetsApi = {
  getLoans: (token: string) => request<LoanSummary[]>('/household/loans', { token }),
  updateLoan: (token: string, loanId: string, payload: LoanUpdatePayload) =>
    request<LoanSummary>(`/household/loans/${loanId}`, { method: 'PUT', token, body: payload }),
  getHoldingPrices: (token: string, assetId: string) =>
    request<HoldingPricesResponse>(`/household/assets/${assetId}/holding-prices`, { token }),
  getAssets: (token: string) => request<AssetSummary[]>('/household/assets', { token }),
  createLoan: (
    token: string,
    payload: {
      name: string
      current_balance: number
      monthly_payment: number
      original_balance?: number | null
      interest_rate?: number
      liability_type?: string
      owner_scope: string
      start_date?: string | null
      end_date?: string | null
      notes?: string
      linked_property_id?: string | null
    },
  ) => request<ManualRecordResponse>('/household/loans', { method: 'POST', token, body: payload }),
  createAsset: (
    token: string,
    payload: {
      name: string
      total_cost: number
      valuation_date: string
      status?: string
      started_on?: string | null
      ended_on?: string | null
      notes?: string
      kind?: 'asset' | 'project'
      category?: 'property' | 'vehicle' | 'other' | 'account'
      depreciation_rate?: number
      linked_category_ids?: string[]
      details?: Record<string, unknown>
    } & AccountFields,
  ) => request<ManualRecordResponse>('/household/assets', { method: 'POST', token, body: payload }),
  updateAsset: (
    token: string,
    assetId: string,
    payload: {
      name: string
      total_cost: number
      valuation_date: string
      status?: string
      started_on?: string | null
      ended_on?: string | null
      notes?: string
      category?: 'property' | 'vehicle' | 'other' | 'account'
      depreciation_rate?: number
      linked_category_ids?: string[]
      details: Record<string, unknown>
    } & AccountFields,
  ) => request<AssetSummary>(`/household/assets/${assetId}`, { method: 'PUT', token, body: payload }),
  deleteAsset: (token: string, assetId: string) =>
    request<{ ok: boolean }>(`/household/assets/${assetId}`, { method: 'DELETE', token }),
  createOwnPropertyCategory: (token: string, assetId: string) =>
    request<AssetSummary>(`/household/assets/${assetId}/own-category`, { method: 'POST', token }),
  getPropertyValuations: (token: string, assetId: string) =>
    request<PropertyValuation[]>(`/household/assets/${assetId}/valuations`, { method: 'GET', token }),
  createPropertyValuation: (token: string, assetId: string, payload: { value: number; effective_date: string }) =>
    request<PropertyValuation>(`/household/assets/${assetId}/valuations`, { method: 'POST', token, body: payload }),
  deletePropertyValuation: (token: string, assetId: string, valuationId: string) =>
    request<{ ok: boolean }>(`/household/assets/${assetId}/valuations/${valuationId}`, { method: 'DELETE', token }),
}
