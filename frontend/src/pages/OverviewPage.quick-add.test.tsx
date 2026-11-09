import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { OverviewPage } from './OverviewPage'
import { SessionProvider } from '../lib/session'

function renderOverview() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <OverviewPage dateRange="month" />
      </SessionProvider>
    </QueryClientProvider>,
  )
}

async function openQuickAdd() {
  renderOverview()
  await userEvent.click(screen.getByRole('button', { name: 'Add record' }))
  return screen.getByRole('dialog', { name: 'Expense' })
}

describe('OverviewPage quick-add expense form', () => {
  it('renames Description to Name and hides notes behind a toggle', async () => {
    const dialog = await openQuickAdd()

    expect(screen.getByLabelText('Name')).toHaveAttribute(
      'placeholder',
      'Name',
    )
    expect(screen.queryByLabelText('Description')).toBeNull()
    expect(screen.queryByLabelText('Notes')).toBeNull()
    expect(dialog.querySelectorAll('.outlined-field__icon')).toHaveLength(5)
    const controls = [...dialog.querySelectorAll('input, select')]
    expect(new Set(controls.map((control) => control.id)).size).toBe(controls.length)
    controls.forEach((control) => {
      expect(control.id).not.toBe('')
      expect(control).toHaveAccessibleName()
      expect(control.closest('label')).toBeNull()
      expect(control.closest('.outlined-field')).toBeInTheDocument()
    })
    expect(screen.getByLabelText('Date')).toHaveAttribute('type', 'date')
    // Owner is a footer circle toggle, not a dropdown: one person = Self,
    // two people = Joint, and only those two scopes exist.
    expect(screen.queryByRole('combobox', { name: 'Owner' })).toBeNull()
    const ownerToggle = screen.getByRole('button', { name: /^Owner: /i })
    expect(ownerToggle).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(ownerToggle)
    expect(ownerToggle).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(ownerToggle)
    expect(ownerToggle).toHaveAttribute('aria-pressed', 'false')
  })

  it('reveals the notes field after pressing the Add Notes toggle and keeps it open', async () => {
    await openQuickAdd()

    const toggle = screen.getByRole('button', { name: 'Add Notes' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByLabelText('Notes')).toBeNull()

    await userEvent.click(toggle)
    // The toggle is additive: it disappears once the field is revealed.
    expect(screen.queryByRole('button', { name: 'Add Notes' })).toBeNull()
    const notesField = screen.getByLabelText('Notes')
    expect(notesField).toHaveAttribute('placeholder', 'Notes')

    await userEvent.type(notesField, 'farmers market')
    expect(notesField).toHaveValue('farmers market')
  })

  it('formats the amount with grouping and a currency while typing', async () => {
    const dialog = await openQuickAdd()

    const amountField = screen.getByRole('textbox', { name: 'Amount' })
    expect(amountField).toHaveAttribute('inputmode', 'decimal')

    const currencyBadge = dialog.querySelector('.record-add-field-currency')
    expect(currencyBadge).toHaveClass('is-empty')

    await userEvent.type(amountField, '1234.5')

    expect(amountField).toHaveValue('1\u2009234.5')
    expect(currencyBadge).not.toHaveClass('is-empty')
    expect(currencyBadge?.textContent).not.toBe('')
  })

  it('gives the hand-rolled dialog the shared keyboard behavior', async () => {
    renderOverview()
    const launcher = screen.getByRole('button', { name: 'Add record' })
    await userEvent.click(launcher)

    const dialog = screen.getByRole('dialog', { name: 'Expense' })
    // Focus is placed inside the dialog on open.
    expect(dialog.contains(document.activeElement)).toBe(true)

    // Tab wraps from the last focusable control back to the first.
    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ]
    focusable[focusable.length - 1].focus()
    await userEvent.tab()
    expect(document.activeElement).toBe(focusable[0])

    // Escape closes the dialog and restores the launching control.
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(launcher).toHaveFocus()
  })

  it('keeps Category left and Group right in one pair row without subgroups', async () => {
    const dialog = await openQuickAdd()

    const pair = dialog.querySelector('.record-add-pair')
    expect(pair).not.toBeNull()
    if (!pair) {
      return
    }
    expect(pair.contains(screen.getByRole('combobox', { name: 'Group' }))).toBe(true)
    expect([...pair.querySelectorAll('select')]).toEqual([
      screen.getByRole('combobox', { name: 'Category' }),
      screen.getByRole('combobox', { name: 'Group' }),
    ])
    expect(screen.queryByRole('combobox', { name: 'Subgroup' })).toBeNull()
    expect(screen.queryByRole('option', { name: 'General' })).toBeNull()
    expect(pair.querySelectorAll('.outlined-field')).toHaveLength(2)
  })

  it('gives the loan tab the same icon-led field style', async () => {
    const dialog = await openQuickAdd()

    await userEvent.click(screen.getByRole('button', { name: 'Expense' }))
    await userEvent.click(screen.getByRole('option', { name: 'Loan' }))

    const nameField = screen.getByRole('textbox', { name: 'Name' })
    expect(nameField).toHaveAttribute('placeholder', 'Name')

    const balanceField = screen.getByRole('textbox', {
      name: 'Current balance',
    })
    expect(balanceField).toHaveAttribute('inputmode', 'decimal')

    await userEvent.type(balanceField, '250000')
    expect(balanceField).toHaveValue('250\u2009000')

    const badges = dialog.querySelectorAll('.record-add-field-currency')
    expect(badges).toHaveLength(4)
    expect(badges[0]?.textContent).not.toBe('')
    expect(badges[3]?.textContent).toBe('%')
    expect(dialog.querySelectorAll('.outlined-field__icon')).toHaveLength(9)

    // Loan notes are also opt-in.
    expect(screen.queryByLabelText('Notes')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Add Notes' }))
    expect(screen.getByLabelText('Notes')).toHaveAttribute(
      'placeholder',
      'Notes',
    )
  })
})
