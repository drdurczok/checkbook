import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { OutlinedInput, OutlinedTextarea } from './OutlinedField'

describe('outlined field', () => {
  it('keeps accessible labels and control outside the decorative outline', () => {
    const { rerender } = render(<OutlinedInput id="title" label="Title" value="" onChange={() => {}} />)
    const input = screen.getByRole('textbox', { name: 'Title' })
    expect(input.closest('fieldset')).toBeNull()
    expect(input.closest('.outlined-field')).not.toHaveClass('has-value')
    rerender(<OutlinedInput id="title" label="Title" value="Rent" onChange={() => {}} />)
    expect(input.closest('.outlined-field')).toHaveClass('has-value')
    expect(input.closest('.outlined-field')?.querySelector('fieldset')).toHaveAttribute('aria-hidden', 'true')
  })

  it('keeps hints, actions, and errors outside the input shell', () => {
    render(<OutlinedInput id="amount" label="Amount" value="12" onChange={() => {}} hint={<button>Use suggestion</button>} error="Too much" />)
    const input = screen.getByRole('textbox', { name: 'Amount' })
    expect(input).toHaveAttribute('aria-describedby', 'amount-hint amount-error')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: 'Use suggestion' }).closest('.outlined-field__shell')).toBeNull()
    expect(screen.getByRole('alert').closest('.outlined-field__shell')).toBeNull()
  })

  it('preserves multiline flow and disabled semantics', () => {
    render(<OutlinedTextarea id="notes" label="Notes" value="Line 1\nLine 2" disabled hint="Extra details" />)
    const input = screen.getByRole('textbox', { name: 'Notes' })
    expect(input).toBeDisabled()
    expect(input.closest('.outlined-field')).toHaveClass('is-multiline')
    expect(input).toHaveAccessibleDescription('Extra details')
  })
})
