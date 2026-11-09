import type { DataSource, GoalStatus, GoalType, OwnershipScope } from './common'
import type { ImportRun } from './imports'

export interface DashboardMetric {
  label: string
  value: number
  delta?: number | null
  unit: 'currency' | 'percent' | string
}

export interface MonthlyPoint {
  period: string
  value: number
}

export interface BreakdownPoint {
  label: string
  value: number
  share: number
}

export interface MonthlyBreakdownPoint {
  period: string
  values: Record<string, number>
}

export interface CashFlowPoint {
  period: string
  income: number
  expenses: number
  net: number
}

export interface UtilitySeriesPoint {
  period: string
  values: Record<string, number>
  usage: Record<string, number>
  units: Record<string, string>
  total: number
}

export interface NetWorthComponentGroup {
  total: number
  components: Record<string, number>
  automatic_components?: Record<string, number>
}

export type NetWorthGroupKey = 'investing' | 'savings' | 'non_liquid_assets' | 'debt'

export interface NetWorthMonthPayload {
  completed: boolean
  components: Array<{ group_key: NetWorthGroupKey; label: string; value: number }>
}

export interface NetWorthComponentRow {
  period: string
  completed: boolean
  total: number
  growth?: number | null
  investing: NetWorthComponentGroup
  savings: NetWorthComponentGroup
  non_liquid_assets: NetWorthComponentGroup
  debt: NetWorthComponentGroup
}

export interface LoanSummary {
  id: string
  name: string
  current_balance: number
  monthly_payment: number
  interest_rate: number
  original_balance?: number | null
  start_date?: string | null
  end_date?: string | null
  notes?: string
  projected_payoff_months?: number | null
  interest_remaining?: number | null
  details?: Record<string, unknown>
  linked_property_id?: string | null
}

export interface LoanPaymentDetail {
  id?: string
  completed?: boolean
  date: string
  payment?: number | string
  interest?: number | string
  principal?: number | string
  extra_principal?: number | string
  outstanding_loan_balance?: number | string
  interest_balance?: number | string
  projected?: boolean
}

export interface FeedItem {
  id: string
  item_type: string
  title: string
  amount: number
  entry_date: string
  owner_scope: OwnershipScope
  source: DataSource | string
  category?: string | null
  subcategory?: string | null
  notes?: string
}

export interface GoalProgress {
  id: string
  name: string
  goal_type: GoalType
  target_amount: number
  projected_amount: number
  progress_ratio: number
  target_date?: string | null
  status: GoalStatus
}

export interface UpcomingPlannedItem {
  id: string
  name: string
  amount: number
  planned_date: string
  owner_scope: OwnershipScope
  description: string
  status: string
}

export interface DashboardOverview {
  metrics: DashboardMetric[]
  net_worth_trend: MonthlyPoint[]
  net_worth_components: NetWorthComponentRow[]
  cash_flow_trend: MonthlyPoint[]
  cash_flow_components: CashFlowPoint[]
  income_breakdown: BreakdownPoint[]
  expense_breakdown: BreakdownPoint[]
  expense_trend_by_category: MonthlyBreakdownPoint[]
  utility_trend: UtilitySeriesPoint[]
  savings_allocation: BreakdownPoint[]
  loans: LoanSummary[]
  upcoming_planned_expenses: UpcomingPlannedItem[]
  recent_activity: FeedItem[]
  goals: GoalProgress[]
  last_successful_import?: ImportRun | null
}

export interface AnalyticsResponse {
  charts: Record<string, Array<Record<string, number | string | boolean>>>
  owner_scope_options: string[]
  timeframe_options: string[]
}
