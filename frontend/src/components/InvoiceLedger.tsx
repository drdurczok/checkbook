import { useCallback, useEffect, useMemo, useState } from 'react'
import { FileText, Plus } from 'lucide-react'
import { api } from '../lib/api'
import { fmtMoney } from '../lib/format'
import { useSession } from '../lib/session'
import { incomeDateInRange, type IncomeDateRange } from '../features/income/model'
import type { IncomeSource, InvoiceSummary } from '../types'
import { InvoiceBuilderModal, type SellerDefaults } from './InvoiceBuilderModal'

const STATUS_LABELS: Record<string, string> = { draft: 'Draft', sent: 'Sent', paid: 'Paid', overdue: 'Overdue' }
const statusLabel = (status: string) => STATUS_LABELS[status] ?? status

const fieldValue = (source: IncomeSource, test: RegExp) =>
  source.fields?.find((field) => test.test(field.label))?.value?.trim() ?? ''

/** Compose a seller block from the business source's name + custom fields. */
function sellerFromSource(source: IncomeSource): SellerDefaults {
  const address = fieldValue(source, /address|ulica|siedziba/i)
  const nip = fieldValue(source, /nip|tax\s*id|vat\s*id/i)
  const iban = fieldValue(source, /iban|account|konto|bank/i)
  const details = [address, nip ? `NIP ${nip}` : '', iban ? `IBAN ${iban}` : '']
    .filter(Boolean)
    .join('\n')
  return { name: source.name, details }
}

export function InvoiceLedger({ source, currency, dateRange }: { source: IncomeSource; currency: string; dateRange?: IncomeDateRange }) {
  const { token } = useSession()
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<InvoiceSummary | null | 'new'>(null)
  const seller = useMemo(() => sellerFromSource(source), [source])

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      setInvoices(await api.getInvoices(token, { income_source_id: source.id }))
    } catch (nextError) {
      // A failed load must not masquerade as an empty ledger with zero totals.
      setInvoices([])
      setError(nextError instanceof Error ? nextError.message : 'Invoices could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [token, source.id])

  useEffect(() => {
    void load()
  }, [load])

  const visibleInvoices = invoices.filter((invoice) => !dateRange || incomeDateInRange(invoice.issue_date, dateRange))
  const issued = visibleInvoices.reduce((sum, inv) => sum + (inv.total_amount || 0), 0)
  const paid = visibleInvoices.filter((inv) => inv.status === 'paid').reduce((sum, inv) => sum + (inv.total_amount || 0), 0)
  const outstanding = issued - paid

  const onSaved = () => {
    setEditing(null)
    void load()
  }

  return (
    <div className="invoice-ledger">
      {error ? (
        <div className="invoice-ledger__error" role="alert">
          <strong>Invoices could not be loaded.</strong>
          <span>{error}</span>
          <button className="button button--compact button--ghost" onClick={() => void load()} type="button">
            Try again
          </button>
        </div>
      ) : (
        <>
          <div className="invoice-ledger__summary">
            <div className="invoice-ledger__stat"><span>Issued</span><strong>{fmtMoney(issued, currency)}</strong></div>
            <div className="invoice-ledger__stat"><span>Paid</span><strong className="is-positive">{fmtMoney(paid, currency)}</strong></div>
            <div className="invoice-ledger__stat"><span>Outstanding</span><strong className={outstanding > 0 ? 'is-warn' : ''}>{fmtMoney(outstanding, currency)}</strong></div>
          </div>

          <div className="invoice-ledger__head">
            <p className="invoice-ledger__count">{visibleInvoices.length} {visibleInvoices.length === 1 ? 'invoice' : 'invoices'}</p>
            <button className="button button--compact" onClick={() => setEditing('new')} type="button"><Plus className="h-4 w-4" /> New invoice</button>
          </div>

          {loading ? (
            <div className="income-ledger-empty">Loading invoices…</div>
          ) : visibleInvoices.length ? (
            <div className="invoice-ledger__list">
              {visibleInvoices.map((inv) => (
                <button className="invoice-ledger__row" key={inv.id} onClick={() => setEditing(inv)} type="button">
                  <span className="invoice-ledger__icon"><FileText className="h-4 w-4" /></span>
                  <span className="invoice-ledger__identity">
                    <strong>{inv.invoice_number}</strong>
                    <small>{inv.buyer_name || '—'} · {inv.issue_date}</small>
                  </span>
                  <span className="invoice-ledger__grow" />
                  <span className={`invoice-status invoice-status--${inv.status}`}>{statusLabel(inv.status)}</span>
                  <span className="invoice-ledger__amount">
                    <strong>{fmtMoney(inv.total_amount, inv.currency)}</strong>
                    <small>net {fmtMoney(inv.subtotal, inv.currency)}</small>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="income-ledger-empty">No invoices yet.</div>
          )}
        </>
      )}

      {editing ? (
        <InvoiceBuilderModal
          invoice={editing === 'new' ? null : editing}
          sourceId={source.id}
          seller={seller}
          defaultCurrency={currency}
          onClose={() => setEditing(null)}
          onSaved={onSaved}
        />
      ) : null}
    </div>
  )
}
