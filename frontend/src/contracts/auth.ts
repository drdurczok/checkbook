export type MembershipRole = 'owner' | 'contributor'
export type RelationshipKind = 'owner' | 'spouse' | 'member'

export interface UserSummary {
  id: string
  email: string
  full_name: string
  picture_url: string
}

export interface HouseholdSummary {
  id: string
  name: string
  base_currency: string
  timezone: string
}

export interface MembershipSummary {
  id: string
  role: MembershipRole
  relationship_kind: RelationshipKind
}

export interface HouseholdSettings {
  id: string
  privacy_mode: string
  allow_cross_member_visibility: boolean
  projection_baseline_window_months: number
  projection_horizon_months: number
  savings_allocation_strategy: string
  role_permissions: Record<string, Record<string, Record<string, boolean>>>
}

export interface SessionResponse {
  token: string
  expires_at: string
  user: UserSummary
  household: HouseholdSummary
  membership: MembershipSummary
  settings: HouseholdSettings
}

export interface Invitation {
  id: string
  email: string
  role: MembershipRole
  relationship_kind: RelationshipKind
  token: string
  accepted_at?: string | null
  created_at: string
}

export interface HouseholdContextResponse {
  household: HouseholdSummary
  membership: MembershipSummary
  settings: HouseholdSettings
  user: UserSummary
}
