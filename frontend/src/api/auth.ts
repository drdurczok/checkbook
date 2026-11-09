import type { HouseholdContextResponse, SessionResponse } from '../contracts/auth'
import { request } from './http'

export const authApi = {
  cloudflareSession: () =>
    request<SessionResponse>('/auth/cloudflare-session', { method: 'POST' }),
  googleLogin: (credential: string) =>
    request<SessionResponse>('/auth/google', { method: 'POST', body: { credential } }),
  devLogin: (email: string, fullName: string) =>
    request<SessionResponse>('/auth/dev-login', {
      method: 'POST',
      body: { email, full_name: fullName, relationship_kind: 'owner' },
    }),
  getSession: (token: string) => request<SessionResponse>('/auth/session', { token }),
  logout: (token: string) => request<{ ok: boolean }>('/auth/logout', { method: 'POST', token }),
  getHouseholdContext: (token: string) =>
    request<HouseholdContextResponse>('/household/me', { token }),
}
