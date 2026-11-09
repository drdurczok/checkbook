import type { OwnershipScope } from './common'

export type IncomeFrequency = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly' | 'one_off'

export interface IncomeCustomField {
  label: string
  value: string
}

export interface IncomeLine {
  label: string
  amount: number
  frequency: IncomeFrequency
  owner_scope?: OwnershipScope | null
  category: string
  started_on?: string | null
  ended_on?: string | null
  notes: string
  fields: IncomeCustomField[]
}

export interface IncomeMilestone {
  label: string
  date: string
}

export interface IncomeSourceEntry {
  id: string
  description: string
  amount: number
  entry_date?: string | null
  owner_scope: OwnershipScope
  notes: string
  extra_payload?: Record<string, unknown>
}

export interface IncomeSource {
  id: string
  name: string
  source_type: string
  owner_scope: OwnershipScope
  started_on?: string | null
  ended_on?: string | null
  notes: string
  lines: IncomeLine[]
  fields: IncomeCustomField[]
  milestones: IncomeMilestone[]
  sort_order: number
  annual_total: number
  actual_total: number
  line_count: number
  entries: IncomeSourceEntry[]
}

export type IncomeSourcePayload = {
  name: string
  source_type: string
  owner_scope: OwnershipScope
  started_on?: string | null
  ended_on?: string | null
  notes: string
  lines: IncomeLine[]
  fields: IncomeCustomField[]
  milestones: IncomeMilestone[]
  sort_order: number
}

export type IncomeSourceEntryPayload = {
  description?: string
  amount: number
  entry_date: string
  owner_scope?: OwnershipScope | null
  notes?: string
  extra_payload?: Record<string, unknown>
}
