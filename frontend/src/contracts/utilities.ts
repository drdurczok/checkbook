import type { UtilitySeriesPoint } from './dashboard'

export type GroupKind = 'location' | 'contract' | 'income_source'

export interface UtilityFieldConfiguration {
  color?: string | null
  label: string
  unit: string
  entry_mode: 'meter' | 'usage'
  unit_rate: number | null
}

export interface UtilityFieldCreate extends UtilityFieldConfiguration {
  kind: 'cost' | 'metered'
}

export interface UtilityFieldAudit {
  id: string
  actor_user_id: string | null
  created_at: string
  old_config: UtilityFieldConfiguration | null
  new_config: UtilityFieldConfiguration
}

export type UtilityTrackingMode = 'actual' | 'fixed' | 'usage' | 'meter'

export interface UtilityContractConfiguration {
  color?: string | null
  label: string
  tracking_mode: UtilityTrackingMode
  unit: string
  start_date: string
  end_date: string | null
}

export interface UtilityContract extends UtilityContractConfiguration {
  id: string
  property_id: string
  key: string
  retired: boolean
  sort_order: number
}

export interface UtilityContractPrice {
  id: string
  effective_on: string
  price: number
}

export interface TrackedField {
  color?: string | null
  contract_id?: string
  property_id?: string
  start_date?: string
  end_date?: string | null
  tracking_mode?: UtilityTrackingMode
  retired?: boolean
  hidden?: boolean
  has_data?: boolean
  key: string
  label: string
  kind: 'cost' | 'metered'
  unit: string
  entry_mode?: 'meter' | 'usage'
  unit_rate?: number | null
}

export interface EntryGroup {
  id: string
  kind: GroupKind
  name: string
  group_type: string
  started_on?: string | null
  ended_on?: string | null
  notes: string
  metadata_payload: Record<string, unknown>
  tracked_fields: TrackedField[]
  sort_order: number
}

export interface UtilityFieldState {
  amount_source?: 'actual' | 'auto'
  amount?: number | null
  meter_reading?: number | null
  usage_amount?: number | null
}

export interface UtilityBoardMonth {
  completed?: boolean
  month: string
  values: Record<string, UtilityFieldState>
  total: number
}

export interface UtilityBoardSubject {
  id: string
  kind: 'property' | 'contract'
  name: string
  group_type: string
  started_on?: string | null
  ended_on?: string | null
  notes: string
  tracked_fields: TrackedField[]
}

export interface UtilityBoard {
  subject: UtilityBoardSubject
  trend: UtilitySeriesPoint[]
  months: UtilityBoardMonth[]
}

export interface UtilityEntryFormField extends TrackedField {
  amount_source?: 'actual' | 'auto'
  amount?: number | null
  meter_reading?: number | null
  usage_amount?: number | null
  previous_amount?: number | null
  previous_meter_reading?: number | null
  previous_usage?: number | null
}

export interface UtilityEntryForm {
  completed?: boolean
  month: string
  fields: UtilityEntryFormField[]
}

export interface UtilityEntryValue {
  amount_source?: 'actual' | 'auto'
  field_key: string
  amount?: number | null
  meter_reading?: number | null
  usage_amount?: number | null
}

