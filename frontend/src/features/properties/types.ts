export type PropertyCategory = 'property' | 'vehicle' | 'other' | 'account'

export type PropertySavePayload = {
  name: string
  total_cost: number
  valuation_date: string
  started_on: string | null
  ended_on: string | null
  notes: string
  category: PropertyCategory
  depreciation_rate: number
  depreciation_enabled: boolean
  utilities_enabled: boolean
  projects_enabled: boolean
  expenses_enabled: boolean
  linked_category_ids: string[]
  details: Record<string, unknown>
}
