export type ProjectStatus = 'planned' | 'active' | 'completed'

export type AccountType = 'savings' | 'stocks' | 'options'
export type AccountRegistration = 'regular' | 'retirement'

/** A single lot held inside a brokerage/savings account asset. */
export interface AccountHolding {
  id: string
  name: string
  ticker?: string | null
  quantity?: number | null
  unit_price?: number | null
  value: number
  purchased_on?: string | null
  sold_on?: string | null
  sell_value?: number | null
  notes?: string
}

export interface AssetSummary {
  id: string
  name: string
  total_cost: number
  valuation_date: string
  status?: ProjectStatus
  started_on?: string | null
  ended_on?: string | null
  notes?: string
  details?: Record<string, unknown>
  item_count?: number
  completed_item_count?: number
  completed_cost?: number
  completion_percent?: number
  derived_status?: ProjectStatus | null
  kind?: 'asset' | 'project'
  category?: 'property' | 'vehicle' | 'other' | 'account'
  /** Brokerage/savings account flavor; only meaningful when category='account'. */
  account_type?: AccountType | null
  /** Tax registration of the account; defaults to 'regular'. */
  account_registration?: AccountRegistration | null
  /** Complete holdings list; savings accounts may carry a single cash entry. */
  holdings?: AccountHolding[]
  account_id?: string | null
  linked_asset_id?: string | null
  linked_asset_name?: string | null
  /** Signed monthly appreciation (+) / depreciation (-) fraction, e.g. -0.02 for -2%/month. */
  depreciation_rate?: number
  /** Whether the depreciation/appreciation card is shown; the rate above is
   * preserved even when this is false so re-enabling doesn't lose it. */
  depreciation_enabled?: boolean
  /** The last manually-set value `total_cost` compounds forward from as of `valuation_date`. */
  original_total_cost?: number
  /** Feature toggles: hides this property from other pages/areas (utilities
   * board, projects filter, expense rollups) without deleting its data. */
  utilities_enabled?: boolean
  projects_enabled?: boolean
  expenses_enabled?: boolean
  /** Expense category ids whose spend rolls up against this property. */
  linked_category_ids?: string[]
  /** All-time sum of expenses tagged with any linked category. */
  linked_expense_total?: number
}

/** A user-entered supplementary value/date history point for a property,
 * distinct from its `total_cost`/`valuation_date` compounding anchor. */
export interface PropertyValuation {
  id: string
  value: number
  effective_date: string
}

export interface ManualRecordResponse {
  id: string
  record_type: string
  name: string
}

export interface AssetDetailItem {
  name: string
  unit_price?: unknown
  quantity?: unknown
  total_cost: number
  notes?: string
  completed?: boolean
  asset_id?: string | null
  project_id?: string | null
}

export interface AssetDetailSection {
  name: string
  total: number
  items: AssetDetailItem[]
  notes?: string
}

export interface AssetDetailRoom {
  name: string
  total: number
  sections: AssetDetailSection[]
  notes?: string
}


export interface HoldingPrice {
  ticker: string
  currency: 'USD'
  close: number | null
  price_date: string | null
  fetched_at: string | null
  stale: boolean
  error: string | null
}

export interface HoldingPricesResponse {
  prices: HoldingPrice[]
}
