import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Modal } from '../Modal'
import { OutlinedSelect, type OutlinedSelectOption } from './OutlinedSelect'

const options: OutlinedSelectOption[] = [
  { value: '', label: 'None' },
  { value: 'alpha', label: 'Alpha', secondary: 'Every month', icon: <svg data-testid="option-icon" /> },
  { value: 'beta', label: 'Beta' },
  { value: 'bravo', label: 'Bravo' },
  { value: 'other', label: 'Other' },
]

function select(props: Partial<React.ComponentProps<typeof OutlinedSelect>> = {}) {
  return <OutlinedSelect id="category" label="Category" value="" options={options} onChange={vi.fn()} {...props} />
}

async function openMenu() {
  await userEvent.click(screen.getByRole('combobox'))
  return screen.findByRole('listbox', { name: 'Category' })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('OutlinedSelect', () => {
  it('uses the shared shell, real control label, and placeholder for an empty value', async () => {
    render(select({ className: 'custom-select', leadingIcon: <svg data-testid="leading-icon" /> }))
    const trigger = screen.getByRole('combobox', { name: 'Category' })
    expect(trigger).toHaveAttribute('id', 'category')
    expect(trigger).toHaveAttribute('aria-labelledby', 'category-label')
    expect(trigger).toHaveClass('outlined-field__input', 'outlined-select__trigger')
    expect(trigger.closest('.outlined-field')).toHaveClass('custom-select')
    expect(trigger.closest('.outlined-field')).not.toHaveClass('has-value')
    expect(trigger).toHaveTextContent('Category')
    expect(trigger).not.toHaveTextContent('None')
    expect(screen.getByTestId('leading-icon')).toBeInTheDocument()
    expect(document.getElementById('category-label')).toHaveAttribute('for', 'category')

    const listbox = await openMenu()
    expect(listbox.parentElement).toBe(trigger.parentElement)
    expect(trigger).toHaveAttribute('aria-controls', listbox.id)
    expect(screen.getByRole('option', { name: 'None' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('option', { name: 'Other' })).toBeInTheDocument()
    expect(screen.getByTestId('option-icon')).toBeInTheDocument()
  })

  it('shows selected metadata and forwards hint, error, and disabled semantics', async () => {
    const onChange = vi.fn()
    render(select({ value: 'alpha', hint: 'Choose an account', error: 'Required', disabled: true, onChange }))
    const trigger = screen.getByRole('combobox', { name: 'Category Alpha' })
    expect(trigger).toHaveTextContent('Every month')
    expect(trigger.closest('.outlined-field')).toHaveClass('has-value')
    expect(trigger).toHaveAttribute('aria-describedby', 'category-hint category-error')
    expect(trigger).toHaveAttribute('aria-invalid', 'true')
    expect(trigger).toBeDisabled()
    await userEvent.click(trigger)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('selects with the pointer without moving focus from the trigger', async () => {
    const onChange = vi.fn()
    render(select({ onChange }))
    await openMenu()
    await userEvent.click(screen.getByRole('option', { name: 'Alpha Every month' }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith('alpha')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox')).toHaveFocus()
  })

  it('navigates with arrows, Home, and End without selecting until Enter', async () => {
    const onChange = vi.fn()
    render(select({ value: 'alpha', onChange }))
    const trigger = screen.getByRole('combobox')
    trigger.focus()
    await userEvent.keyboard('{ArrowDown}')
    await screen.findByRole('listbox')
    expect(trigger).toHaveAttribute('aria-activedescendant', 'category-option-1')
    await userEvent.keyboard('{ArrowDown}')
    expect(trigger).toHaveAttribute('aria-activedescendant', 'category-option-2')
    expect(screen.getByRole('option', { name: 'Alpha Every month' })).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{End}')
    expect(trigger).toHaveAttribute('aria-activedescendant', 'category-option-4')
    await userEvent.keyboard('{ArrowDown}')
    expect(trigger).toHaveAttribute('aria-activedescendant', 'category-option-0')
    await userEvent.keyboard('{ArrowUp}')
    expect(trigger).toHaveAttribute('aria-activedescendant', 'category-option-4')
    await userEvent.keyboard('{Home}')
    expect(trigger).toHaveAttribute('aria-activedescendant', 'category-option-0')
    expect(onChange).not.toHaveBeenCalled()
    await userEvent.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledExactlyOnceWith('')
    expect(trigger).toHaveFocus()
    expect(trigger).not.toHaveAttribute('aria-activedescendant')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('supports Space opening and selection without a native button click toggling it again', async () => {
    const onChange = vi.fn()
    render(select({ onChange }))
    screen.getByRole('combobox').focus()
    await userEvent.keyboard(' ')
    await screen.findByRole('listbox')
    await userEvent.keyboard('{End} ')
    expect(onChange).toHaveBeenCalledExactlyOnceWith('other')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('supports case-insensitive typeahead and repeated-character cycling', async () => {
    render(select())
    const trigger = screen.getByRole('combobox')
    trigger.focus()
    await userEvent.keyboard('b')
    await screen.findByRole('listbox')
    expect(trigger).toHaveAttribute('aria-activedescendant', 'category-option-2')
    await userEvent.keyboard('b')
    expect(trigger).toHaveAttribute('aria-activedescendant', 'category-option-3')
    await userEvent.keyboard('{Escape}AL')
    await screen.findByRole('listbox')
    expect(trigger).toHaveAttribute('aria-activedescendant', 'category-option-1')
  })

  it('closes only its listbox on Escape before allowing an enclosing modal to close', async () => {
    const onClose = vi.fn()
    render(<Modal title="Edit category" onClose={onClose}>{select()}</Modal>)
    await openMenu()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox')).toHaveFocus()
    expect(onClose).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('allows Tab and Shift+Tab to leave the control while closing the listbox', async () => {
    render(<><button>Before</button>{select()}<button>After</button></>)
    await openMenu()
    await userEvent.tab()
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    await openMenu()
    await userEvent.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'Before' })).toHaveFocus()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('dismisses on an outside pointer press and does not select an option', async () => {
    const onChange = vi.fn()
    render(<>{select({ onChange })}<button>Outside</button></>)
    await openMenu()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('closes if disabled while open and does not reopen when re-enabled', async () => {
    const { rerender } = render(select())
    await openMenu()
    rerender(select({ disabled: true }))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    rerender(select())
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-expanded', 'false')
  })

  it('handles an empty options list without an invalid active descendant', async () => {
    render(select({ options: [] }))
    const trigger = screen.getByRole('combobox')
    trigger.focus()
    await userEvent.keyboard('{ArrowUp}{ArrowDown}{Home}{End}x{Enter}')
    expect(trigger).not.toHaveAttribute('aria-activedescendant')
    await userEvent.keyboard('{Escape}')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  it('limits menu height and width in a narrow viewport', async () => {
    vi.stubGlobal('innerWidth', 320)
    vi.stubGlobal('innerHeight', 300)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: -10, y: 100, top: 100, right: 390, bottom: 156, left: -10, width: 400, height: 56, toJSON: () => ({}),
    })
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500)
    render(select())
    const menu = await openMenu()
    expect(menu).not.toHaveClass('is-above')
    expect(menu).toHaveStyle({ maxHeight: '130px', width: '304px', left: '18px' })
  })

  it('closes when scrolling the trigger out of the viewport', async () => {
    render(select())
    await openMenu()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: -100, top: -100, right: 300, bottom: -44, left: 0, width: 300, height: 56, toJSON: () => ({}),
    })
    fireEvent.scroll(window)
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
  })

  it('constrains placement to the viewport and measures again on scroll and resize', async () => {
    let rect = { x: 900, y: 680, top: 680, right: 1200, bottom: 736, left: 900, width: 300, height: 56, toJSON: () => ({}) }
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect)
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500)
    render(select())
    const menu = await openMenu()
    expect(menu).toHaveClass('is-above')
    expect(menu).toHaveStyle({ maxHeight: '320px', left: '-184px', width: '300px' })

    rect = { ...rect, top: 20, bottom: 76, left: 0, right: 300 }
    fireEvent.scroll(window)
    await waitFor(() => expect(menu).not.toHaveClass('is-above'))
    expect(menu).toHaveStyle({ left: '8px' })

    rect = { ...rect, top: 430, bottom: 486, width: 1400 }
    fireEvent.resize(window)
    await waitFor(() => expect(menu).toHaveClass('is-above'))
    expect(menu).toHaveStyle({ maxHeight: '320px', width: '1008px' })
  })
})
