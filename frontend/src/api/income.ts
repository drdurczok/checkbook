import type { ManualRecordResponse } from '../contracts/assets'
import type { IncomeSource, IncomeSourceEntryPayload, IncomeSourcePayload } from '../contracts/income'
import { request } from './http'

export const incomeApi = {
  createIncome: (
    token: string,
    payload: {
      description: string
      amount: number
      entry_date: string
      owner_scope: string
      category_name: string
      subcategory_name?: string
      income_source_id?: string | null
      notes?: string
    },
  ) => request<ManualRecordResponse>('/household/income', { method: 'POST', token, body: payload }),
  getIncomeSources: (token: string) => request<IncomeSource[]>('/household/income-sources', { token }),
  createIncomeSource: (token: string, payload: IncomeSourcePayload) =>
    request<IncomeSource>('/household/income-sources', { method: 'POST', token, body: payload }),
  updateIncomeSource: (token: string, id: string, payload: IncomeSourcePayload) =>
    request<IncomeSource>(`/household/income-sources/${id}`, { method: 'PUT', token, body: payload }),
  createIncomeSourceEntry: (token: string, id: string, payload: IncomeSourceEntryPayload) =>
    request<IncomeSource>(`/household/income-sources/${id}/entries`, { method: 'POST', token, body: payload }),
  updateIncomeSourceEntry: (token: string, id: string, entryId: string, payload: IncomeSourceEntryPayload) =>
    request<IncomeSource>(`/household/income-sources/${id}/entries/${entryId}`, { method: 'PUT', token, body: payload }),
  deleteIncomeSource: (token: string, id: string) =>
    request<{ ok: boolean }>(`/household/income-sources/${id}`, { method: 'DELETE', token }),
}
