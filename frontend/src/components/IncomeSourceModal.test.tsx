import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { IncomeSource } from '../types'
import { IncomeSourceModal } from './IncomeSourceModal'

// Typing walk-throughs with per-keystroke formatting can exceed the default
// 5s per test on the shared CI runner; raise the ceiling for this file.
vi.setConfig({ testTimeout: 15000 })

const source: IncomeSource = {
  id: 'income-1',
  name: 'Senior engineer',
  source_type: 'employment',
  owner_scope: 'self',
  started_on: '2025-01-01',
  ended_on: null,
  notes: '',
  lines: [],
  fields: [{ label: 'Employer', value: 'Example Corp' }],
  milestones: [],
  sort_order: 0,
  annual_total: 120_000,
  actual_total: 10_000,
  line_count: 0,
  entries: [],
}

const linedSource: IncomeSource = {
  ...source,
  lines: [{ label: 'Base salary', amount: 4500, frequency: 'monthly', owner_scope: null, category: '', notes: '', fields: [] }],
}

describe('IncomeSourceModal', () => {
  it('filters payslip views while preserving entry editing and configured source details', async () => {
    const user = userEvent.setup()
    const onUpdateEntry = vi.fn().mockResolvedValue(true)
    const datedSource: IncomeSource = {
      ...linedSource,
      entries: [
        { id: 'past', description: 'Past', entry_date: '2026-06-15', amount: 700, owner_scope: 'self', notes: '', extra_payload: { payslip: { period: 'Visible payslip', basePay: 1000, taxAdvance: 300, grossPay: 1000, netPayable: 700 } } },
        { id: 'future', description: 'Future', entry_date: '2026-07-15', amount: 900, owner_scope: 'self', notes: '', extra_payload: { payslip: { period: 'Future payslip', grossPay: 1200, netPayable: 900 } } },
      ],
    }
    const props = { source: datedSource, currency: 'PLN', saving: false, onClose: vi.fn(), onSave: vi.fn().mockResolvedValue(true), onCreateEntry: vi.fn().mockResolvedValue(true), onUpdateEntry }
    const { rerender } = render(<IncomeSourceModal {...props} dateRange={{ start_date: '2026-06-01', end_date: '2026-06-30' }} />)
    expect(screen.getByRole('button', { name: 'Visible payslip' })).toBeVisible()
    expect(screen.queryByText('Future payslip')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Visible payslip' }))
    await user.click(screen.getByRole('button', { name: 'Edit payslip' }))
    await user.click(screen.getByRole('button', { name: 'Update payslip' }))
    expect(onUpdateEntry).toHaveBeenCalledWith(source.id, 'past', expect.objectContaining({ entry_date: '2026-06-15', amount: 700 }))
    await user.click(screen.getByRole('button', { name: 'Income source actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit source details' }))
    expect(screen.getByRole('textbox', { name: 'Amount' })).toHaveValue('4\u2009500')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    rerender(<IncomeSourceModal {...props} dateRange={{}} />)
    expect(screen.getByRole('button', { name: 'Future payslip' })).toBeVisible()
    expect(datedSource.entries).toHaveLength(2)
  })

  it('filters generic paycheck rows, counts, and totals without removing the log action', () => {
    const datedSource: IncomeSource = {
      ...source,
      source_type: 'rental',
      entries: [
        { id: 'past', description: 'Visible paycheck', entry_date: '2026-06-15', amount: 700, owner_scope: 'self', notes: '' },
        { id: 'future', description: 'Future paycheck', entry_date: '2026-07-15', amount: 900, owner_scope: 'self', notes: '' },
      ],
    }
    render(<IncomeSourceModal source={datedSource} dateRange={{ end_date: '2026-06-30' }} currency="PLN" saving={false} onClose={vi.fn()} onSave={vi.fn()} onCreateEntry={vi.fn()} onUpdateEntry={vi.fn()} />)
    expect(screen.getByText('Visible paycheck')).toBeVisible()
    expect(screen.queryByText('Future paycheck')).toBeNull()
    expect(screen.getByText('1 paycheck')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Log' })).toBeEnabled()
  })

  it('focuses Cancel when the inline delete confirmation appears', async () => {
    const user = userEvent.setup()
    render(
      <IncomeSourceModal
        source={source}
        currency="PLN"
        saving={false}
        deleting={false}
        onClose={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
        onCreateEntry={vi.fn().mockResolvedValue(true)}
        onUpdateEntry={vi.fn().mockResolvedValue(true)}
        onDelete={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Income source actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit source details' }))
    await user.click(screen.getByRole('button', { name: 'Delete income source' }))

    // The confirmation is an inline alert inside the dialog, not a nested
    // alertdialog, and keyboard users land on the safe action first.
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Delete this income source?')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })

  it('shows save only after source edits become dirty', async () => {
    const user = userEvent.setup()
    render(
      <IncomeSourceModal
        source={source}
        currency="PLN"
        saving={false}
        onClose={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
        onCreateEntry={vi.fn().mockResolvedValue(true)}
        onUpdateEntry={vi.fn().mockResolvedValue(true)}
      />,
    )

    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New payslip' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Income source actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit source details' }))
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()

    const name = screen.getByRole('textbox', { name: 'Name' })
    await user.clear(name)
    await user.type(name, 'Principal engineer')
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Income source actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit source details' }))
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Senior engineer')
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
  })

  it('styles expected-line fields with icons, grouping, and a currency', async () => {
    const user = userEvent.setup()
    render(
      <IncomeSourceModal
        source={linedSource}
        currency="PLN"
        saving={false}
        onClose={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
        onCreateEntry={vi.fn().mockResolvedValue(true)}
        onUpdateEntry={vi.fn().mockResolvedValue(true)}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Income source actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit source details' }))

    const amount = screen.getByRole('textbox', { name: 'Amount' })
    expect(amount).toHaveAttribute('inputmode', 'decimal')
    expect(amount).toHaveValue('4\u2009500')

    // The modal is portaled to document.body, not the render container.
    const badge = document.body.querySelector('.income-lines .record-add-field-currency')
    expect(badge).not.toHaveClass('is-empty')
    expect(badge?.textContent).not.toBe('')

    expect(document.body.querySelectorAll('.income-source-edit .outlined-field__icon').length).toBeGreaterThanOrEqual(10)
    expect(screen.getByLabelText('From')).toHaveAttribute('type', 'date')
    expect(screen.getByLabelText('To')).toHaveAttribute('type', 'date')
    expect(amount.closest('label')).toBeNull()
    expect(amount.closest('.outlined-field')).toBeInTheDocument()
  })

  it('labels dynamic fields uniquely and preserves native selections when saving', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(true)
    render(
      <IncomeSourceModal
        source={linedSource}
        currency="PLN"
        saving={false}
        onClose={vi.fn()}
        onSave={onSave}
        onCreateEntry={vi.fn().mockResolvedValue(true)}
        onUpdateEntry={vi.fn().mockResolvedValue(true)}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Income source actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit source details' }))
    await user.click(screen.getByRole('button', { name: 'Field' }))
    await user.click(screen.getByRole('button', { name: 'Milestone' }))
    await user.click(screen.getByRole('button', { name: 'Milestone' }))
    await user.click(screen.getByRole('button', { name: 'Add line' }))

    const fields = [
      ...screen.getAllByRole('textbox'),
      ...screen.getAllByRole('combobox'),
      screen.getByLabelText('From'),
      screen.getByLabelText('To'),
    ]
    const ids = fields.map((field) => field.id)
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    fields.forEach((field) => {
      expect(field).toHaveAccessibleName()
      expect(field.closest('.outlined-field')).toBeInTheDocument()
      expect(field.closest('label')).toBeNull()
    })

    await user.type(screen.getAllByRole('textbox', { name: 'Field label' })[1], 'Tax')
    await user.type(screen.getAllByRole('textbox', { name: 'Field value' })[1], '123')
    await user.type(screen.getAllByRole('textbox', { name: 'Milestone' })[1], 'Promotion')
    await user.type(screen.getAllByRole('textbox', { name: 'When' })[1], 'Jan 2026')
    await user.selectOptions(screen.getAllByRole('combobox', { name: 'Frequency' })[1], 'weekly')
    await user.selectOptions(screen.getAllByRole('combobox', { name: 'Owner' })[2], 'spouse')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      fields: [...source.fields, { label: 'Tax', value: '123' }],
      milestones: [{ label: 'Promotion', date: 'Jan 2026' }],
      lines: [expect.objectContaining(linedSource.lines[0]), expect.objectContaining({ frequency: 'weekly', owner_scope: 'spouse' })],
    }))
  })

  it('keeps a trailing decimal point while typing an amount line', async () => {
    const user = userEvent.setup()
    render(
      <IncomeSourceModal
        source={linedSource}
        currency="PLN"
        saving={false}
        onClose={vi.fn()}
        onSave={vi.fn().mockResolvedValue(true)}
        onCreateEntry={vi.fn().mockResolvedValue(true)}
        onUpdateEntry={vi.fn().mockResolvedValue(true)}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Income source actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Edit source details' }))

    const amount = screen.getByRole('textbox', { name: 'Amount' })
    await user.clear(amount)
    await user.type(amount, '12.')
    expect(amount).toHaveValue('12.')

    await user.tab()
    expect(amount).toHaveValue('12')
  })
})
