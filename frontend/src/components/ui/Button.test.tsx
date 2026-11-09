import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Button } from './Button'

describe('Button', () => {
  it('applies variants and exposes pending state consistently', () => {
    render(<Button busy busyLabel="Saving" size="compact" variant="secondary">Save</Button>)
    const button = screen.getByRole('button', { name: 'Saving' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveClass('button', 'button--ghost', 'button--compact')
  })

  it('keeps size orthogonal to the semantic variant', () => {
    const { rerender } = render(<Button size="compact">Save</Button>)
    const button = screen.getByRole('button', { name: 'Save' })
    expect(button).toHaveClass('button', 'button--compact')
    // Compact is a size, not a variant: it must not silently demote the
    // default primary treatment to the neutral ghost fill.
    expect(button).not.toHaveClass('button--ghost')

    rerender(<Button size="compact" variant="danger">Delete</Button>)
    expect(button).toHaveClass('button--compact', 'button--danger')
    expect(button).not.toHaveClass('button--ghost')
  })
})
