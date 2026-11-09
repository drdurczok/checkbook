export type PlannerSection = 'mandatory' | 'monthly' | 'flexible'
export type AllocationKind = 'expense' | 'savings' | 'transfer' | 'other'

export interface AllocationInput {
  title: string
  section: PlannerSection
  kind: AllocationKind
  category_id: string | null
  subcategory_id: string | null
  amount: string
  notes: string
  position?: number
  recurring?: boolean
  expense_group_id?: string | null
}
export interface MandatoryTemplate extends AllocationInput {
  id: string
  expense_group_name?: string | null
  category_name: string | null
  subcategory_name: string | null
  source: 'manual' | 'template' | 'suggestion'
}
export interface PlannerAllocation extends MandatoryTemplate {
  template_id: string | null
  completed: boolean
  completed_at: string | null
  actual_amount: string | null
  difference: string | null
  percentage: string | null
}
export interface PlannerSuggestion extends AllocationInput {
  key: string
  reason: string
  template_id: string | null
  expense_group_name?: string | null
  category_name: string | null
  subcategory_name: string | null
}
export interface UnplannedActual {
  category_id: string | null
  expense_group_name?: string | null
  category_name: string | null
  subcategory_id: string | null
  subcategory_name: string | null
  amount: string
}
export interface PaydayPlanner {
  month: string
  current_month: string
  currency: string
  provisional: boolean
  income: string
  total_allocated: string
  remaining: string
  completed_total: string
  actual_total: string
  unplanned_actual_total: string
  allocations: PlannerAllocation[]
  templates: MandatoryTemplate[]
  suggestions: PlannerSuggestion[]
  unplanned_actuals: UnplannedActual[]
}
