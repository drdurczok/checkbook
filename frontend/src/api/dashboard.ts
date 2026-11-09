import type { DashboardOverview, NetWorthComponentRow, NetWorthMonthPayload } from '../contracts/dashboard'
import type { AnalyticsResponse } from '../contracts/dashboard'
import { request } from './http'

export const dashboardApi = {
  getDashboardOverview: (token: string, range?: { start_date?: string; end_date?: string; include_planned?: boolean }) => {
    const params = new URLSearchParams()
    if (range?.start_date) {
      params.set('start_date', range.start_date)
    }
    if (range?.end_date) {
      params.set('end_date', range.end_date)
    }
    if (range?.include_planned) {
      params.set('include_planned', 'true')
    }
    const query = params.toString()
    return request<DashboardOverview>(`/dashboard/overview${query ? `?${query}` : ''}`, { token })
  },
  updateNetWorthMonth: (token: string, period: string, payload: NetWorthMonthPayload) =>
    request<NetWorthComponentRow>(`/household/net-worth/months/${encodeURIComponent(period)}`, { token, method: 'PUT', body: payload }),
  getAnalytics: (token: string) => request<AnalyticsResponse>('/dashboard/analytics', { token }),
}
