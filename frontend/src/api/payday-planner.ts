import type { AllocationInput, MandatoryTemplate, PaydayPlanner, PlannerSuggestion } from '../contracts/payday-planner'
import { request } from './http'

export const paydayPlannerApi = {
  getPaydayPlanner: (token: string, month?: string) =>
    request<PaydayPlanner>(`/payday-planner${month ? `?${new URLSearchParams({ month })}` : ''}`, { token }),
  createPaydayAllocation: (token: string, payload: AllocationInput & { month: string; template_id?: string | null }) =>
    request<PaydayPlanner>('/payday-planner/allocations', { token, method: 'POST', body: payload }),
  updatePaydayAllocation: (token: string, id: string, payload: AllocationInput & { month: string; completed: boolean }) =>
    request<PaydayPlanner>(`/payday-planner/allocations/${id}`, { token, method: 'PUT', body: payload }),
  deletePaydayAllocation: (token: string, id: string) =>
    request<{ ok: boolean }>(`/payday-planner/allocations/${id}`, { token, method: 'DELETE' }),
  getPaydaySuggestions: (token: string, month: string) =>
    request<{ month: string; suggestions: PlannerSuggestion[] }>(`/payday-planner/suggestions?${new URLSearchParams({ month })}`, { token }),
  applyPaydaySuggestions: (token: string, payload: { month: string; items: PlannerSuggestion[] }) =>
    request<PaydayPlanner>('/payday-planner/apply', { token, method: 'POST', body: payload }),
  getPaydayTemplates: (token: string) => request<MandatoryTemplate[]>('/payday-planner/templates', { token }),
  createPaydayTemplate: (token: string, payload: AllocationInput) =>
    request<{ id: string }>('/payday-planner/templates', { token, method: 'POST', body: payload }),
  updatePaydayTemplate: (token: string, id: string, payload: AllocationInput) =>
    request<{ id: string }>(`/payday-planner/templates/${id}`, { token, method: 'PUT', body: payload }),
  deletePaydayTemplate: (token: string, id: string) =>
    request<{ ok: boolean }>(`/payday-planner/templates/${id}`, { token, method: 'DELETE' }),
}
