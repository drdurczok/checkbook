import type { LoanPaymentDetail } from './dashboard'

export interface LoanUpdatePayload {
  name: string
  current_balance?: number
  monthly_payment?: number
  interest_rate: number
  original_balance: number | null
  start_date: string | null
  end_date: string | null
  notes: string
  linked_property_id: string | null
  payment_schedule?: LoanPaymentDetail[]
}
