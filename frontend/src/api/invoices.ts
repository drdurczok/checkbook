import type { Buyer, BuyerPayload, InvoiceSummary, InvoiceTemplate, InvoiceWritePayload } from '../contracts/invoices'
import { request, requestBlob } from './http'

export const invoicesApi = {
  getBuyers: (token: string) => request<Buyer[]>('/household/buyers', { token }),
  createBuyer: (token: string, payload: BuyerPayload) =>
    request<Buyer>('/household/buyers', { method: 'POST', token, body: payload }),
  getInvoices: (token: string, params?: { income_source_id?: string }) =>
    request<InvoiceSummary[]>(
      `/household/invoices${params?.income_source_id ? `?income_source_id=${encodeURIComponent(params.income_source_id)}` : ''}`,
      { token },
    ),
  getInvoiceTemplates: (token: string) => request<InvoiceTemplate[]>('/household/invoice-templates', { token }),
  generateInvoice: (token: string, payload: InvoiceWritePayload) =>
    request<InvoiceSummary>('/household/invoices/generate', { method: 'POST', token, body: payload }),
  updateInvoice: (token: string, invoiceId: string, payload: InvoiceWritePayload) =>
    request<InvoiceSummary>(`/household/invoices/${invoiceId}`, { method: 'PUT', token, body: payload }),
  downloadInvoicePdf: (token: string, invoiceId: string) =>
    requestBlob(`/household/invoices/${invoiceId}/pdf`, token),
  deleteInvoice: (token: string, invoiceId: string) =>
    request<{ ok: boolean }>(`/household/invoices/${invoiceId}`, { method: 'DELETE', token }),
}
