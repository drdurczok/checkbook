import type { OwnershipScope } from './common'

export type ExpenseCadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly'

export interface RecurringExpensePayload {
  description: string
  amount: number
  start_date: string
  end_date: string | null
  cadence?: ExpenseCadence
  owner_scope: OwnershipScope
  category_name: string
  notes: string
}

export interface RecurringExpense extends RecurringExpensePayload {
  id: string
  cadence: ExpenseCadence
  next_due_date: string | null
  category_id: string | null
  is_active: boolean
  price_history: { amount: number; changed_at: string }[]
}

export interface ExpenseNameSuggestion {
  description: string
  category_id: string
  category_name: string
  expense_group_id: string | null
}

export interface Category {
  id: string
  kind: string
  name: string
  normalized_name: string
  parent_id?: string | null
  is_system: boolean
  sort_order: number
}

export interface ExpenseGroup {
  id: string
  name: string
  color: string
  notes: string
  sort_order: number
  is_retired: boolean
  can_delete: boolean
  is_source_linked: boolean
}

export interface ExpenseGroupPayload {
  name: string
  color?: string
  notes?: string
  sort_order?: number
  is_retired?: boolean
}

export interface ExpenseCategorySummary {
  /** Read-only projection of property utility bills, not a writable expense category. */
  utility_property_id?: string | null
  id: string
  name: string
  parent_id?: string | null
  expense_group_id?: string | null
  is_system: boolean
  is_retired: boolean
  can_delete: boolean
  is_source_linked: boolean
  sort_order: number
  total_amount: number
  monthly_average: number
  entry_count: number
  first_entry_date?: string | null
  last_entry_date?: string | null
}

export interface ExpenseCategoryPayload {
  name: string
  expense_group_id?: string | null
  sort_order?: number
  is_retired?: boolean
}

export interface ExpensesBoard {
  groups: ExpenseGroup[]
  categories: ExpenseCategorySummary[]
  monthly_totals: ExpenseCategoryMonthlyPoint[]
}

export interface ExpenseCategoryMonthlyPoint {
  category_id: string | null
  period: string
  value: number
}

export interface ExpenseSubcategory {
  id: string
  name: string
  sort_order: number
}

export interface ExpenseMonthlyPoint {
  period: string
  value: number
}

export interface ExpenseEntry {
  id: string
  description: string
  amount: number
  entry_date?: string | null
  owner_scope: OwnershipScope
  notes: string
  data_source: string
  category_id?: string | null
  subcategory_id?: string | null
  extra_payload?: Record<string, unknown>
}

export interface ExpenseCategoryDetail {
  id: string
  name: string
  expense_group_id?: string | null
  is_system: boolean
  is_retired: boolean
  can_delete: boolean
  is_source_linked: boolean
  sort_order: number
  subcategories: ExpenseSubcategory[]
  monthly_totals: ExpenseMonthlyPoint[]
  entries: ExpenseEntry[]
}

export interface ExpenseEntryUpdatePayload {
  description: string
  amount: number
  entry_date: string
  owner_scope: string
  notes?: string
  category_id?: string | null
  subcategory_id?: string | null
}

