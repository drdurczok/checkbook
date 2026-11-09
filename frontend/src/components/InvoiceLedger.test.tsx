import { render, screen } from '@testing-library/react'
import { fmtMoney } from '../lib/format'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomeSource, InvoiceSummary } from '../types'
import { InvoiceLedger } from './InvoiceLedger'

vi.mock('../lib/session', () => ({
  useSession: () => ({ token: 'test-token', currency: 'PLN', setError: vi.fn(), setMessage: vi.fn() }),
}))

vi.mock('./InvoiceBuilderModal', () => ({
  InvoiceBuilderModal: ({ invoice, sourceId }: { invoice: InvoiceSummary | null; sourceId: string }) => (
    <div role="dialog" aria-label="Invoice editor">{invoice ? `${invoice.id} ${invoice.buyer_name}` : `New invoice for ${sourceId}`}</div>
  ),
}))

const getInvoices = vi.fn()
vi.mock('../lib/api', () => ({ api: { getInvoices: (...args: unknown[]) => getInvoices(...args) } }))

const source: IncomeSource = {
  id: 'income-1',
  name: 'Design studio',
  source_type: 'business',
  owner_scope: 'self',
  started_on: '2025-01-01',
  ended_on: null,
  notes: '',
  lines: [],
  fields: [],
  milestones: [],
  sort_order: 0,
  annual_total: 0,
  actual_total: 0,
  line_count: 0,
  entries: [],
}

const invoice: InvoiceSummary = {
  id: 'inv-1',
  invoice_number: '01/2026',
  buyer_name: 'Acme',
  issue_date: '2026-01-31',
  status: 'sent',
  total_amount: 1200,
  subtotal: 1000,
  currency: 'PLN',
} as InvoiceSummary

beforeEach(() => {
  getInvoices.mockReset()
})

describe('InvoiceLedger load states', () => {
  it('filters displayed rows and totals by issue date, retaining full invoices for editing', async () => {
    const paid = { ...invoice, status: 'paid', issue_date: '2026-06-01' }
    const sent = { ...invoice, id: 'inv-2', invoice_number: '02/2026', issue_date: '2026-06-15', total_amount: 300 }
    const future = { ...invoice, id: 'inv-future', invoice_number: 'Future', issue_date: '2026-06-16', total_amount: 900 }
    const older = { ...invoice, id: 'inv-old', invoice_number: 'Older', issue_date: '2026-05-31', total_amount: 800 }
    getInvoices.mockResolvedValue([paid, sent, future, older])
    const { rerender } = render(<InvoiceLedger source={source} currency="PLN" dateRange={{ start_date: '2026-06-01', end_date: '2026-06-15' }} />)
    expect(await screen.findByText('01/2026')).toBeVisible()
    expect(screen.getByText('02/2026')).toBeVisible()
    expect(screen.queryByText('Future')).toBeNull()
    expect(screen.queryByText('Older')).toBeNull()
    expect(screen.getByText('2 invoices')).toBeVisible()
    for (const [label, amount] of [['Issued', 1500], ['Paid', 1200], ['Outstanding', 300]] as const) {
      expect(screen.getByText(label, { selector: '.invoice-ledger__stat > span' }).parentElement).toHaveTextContent(fmtMoney(amount, 'PLN').replace(/\s/g, ' '))
    }
    await userEvent.click(screen.getByRole('button', { name: /01\/2026/ }))
    expect(screen.getByRole('dialog', { name: 'Invoice editor' })).toHaveTextContent('inv-1 Acme')
    rerender(<InvoiceLedger source={source} currency="PLN" dateRange={{}} />)
    expect(screen.getByText('Future')).toBeVisible()
    expect(screen.getByText('Older')).toBeVisible()
    expect(getInvoices).toHaveBeenCalledTimes(1)
  })

  it('keeps new invoice creation available when the date range hides every invoice', async () => {
    getInvoices.mockResolvedValue([invoice])
    render(<InvoiceLedger source={source} currency="PLN" dateRange={{ end_date: '2025-12-31' }} />)
    expect(await screen.findByText('No invoices yet.')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'New invoice' }))
    expect(screen.getByRole('dialog', { name: 'Invoice editor' })).toHaveTextContent(`New invoice for ${source.id}`)
  })

  it('distinguishes a failed load from an empty ledger', async () => {
    getInvoices.mockRejectedValueOnce(new Error('Network down'))
    getInvoices.mockResolvedValueOnce([invoice])
    render(<InvoiceLedger source={source} currency="PLN" />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Invoices could not be loaded.')
    // No misleading empty-state or zero-total summary while errored.
    expect(screen.queryByText('No invoices yet.')).toBeNull()
    expect(screen.queryByText('Issued')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('01/2026')).toBeVisible()
    expect(getInvoices).toHaveBeenCalledTimes(2)
  })

  it('shows the empty state only for a successful empty load', async () => {
    getInvoices.mockResolvedValue([])
    render(<InvoiceLedger source={source} currency="PLN" />)

    expect(await screen.findByText('No invoices yet.')).toBeVisible()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
