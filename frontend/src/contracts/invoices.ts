export interface Buyer {
  id: string
  name: string
  nip: string
  address: string
  created_at: string
  updated_at: string
}

export interface BuyerPayload {
  name: string
  nip: string
  address: string
}

export interface InvoiceLineItem {
  description: string
  quantity: number
  unit_price: number
  vat_rate: string
  unit: string
  currency: string
}

export interface InvoiceTemplate {
  id: string
  name: string
  title: string
  seller_name: string
  seller_details: string
  buyer_name: string
  buyer_details: string
  currency: string
  payment_terms: string
  notes: string
  line_items: InvoiceLineItem[]
  created_at: string
  updated_at: string
}

export interface InvoiceSummary {
  id: string
  invoice_number: string
  title: string
  template_id?: string | null
  template_name: string
  income_source_id?: string | null
  seller_name: string
  seller_details: string
  buyer_name: string
  buyer_details: string
  buyer_nip: string
  buyer_address: string
  issue_date: string
  sale_date?: string | null
  due_date?: string | null
  currency: string
  status: string
  conversion_enabled: boolean
  conversion_currency: string
  conversion_rate: number
  subtotal: number
  tax_amount: number
  total_amount: number
  notes: string
  line_items: InvoiceLineItem[]
  created_at: string
  updated_at: string
}

export interface InvoiceWritePayload {
  template_id?: string | null
  save_template: boolean
  template_name?: string | null
  invoice_number?: string | null
  title: string
  income_source_id?: string | null
  seller_name: string
  seller_details: string
  buyer_name: string
  buyer_details: string
  buyer_nip: string
  buyer_address: string
  issue_date: string
  sale_date?: string | null
  due_date?: string | null
  currency: string
  status: string
  conversion_enabled: boolean
  conversion_currency: string
  conversion_rate: number
  payment_terms: string
  notes: string
  line_items: InvoiceLineItem[]
}
