import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ExpenseQuickFilters } from './ExpenseQuickFilters'

describe('expense quick filters', () => {
  it('starts collapsed, expands once and collapses with the chevron control', async () => {
    render(<ExpenseQuickFilters><button type="button">All</button><button type="button">Home</button></ExpenseQuickFilters>)
    const filters = screen.getByRole('group', { name: 'Filter by category' })
    expect(filters).not.toHaveClass('is-expanded')
    expect(screen.getByRole('button', { name: 'Expand quick filters' })).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(screen.getByRole('button', { name: 'Expand quick filters' }))
    expect(filters).toHaveClass('is-expanded')
    await userEvent.click(screen.getByRole('button', { name: 'Collapse quick filters' }))
    expect(filters).not.toHaveClass('is-expanded')
  })

  it('keeps the row collapsed when a dot filter is clicked', async () => {
    render(<ExpenseQuickFilters><button type="button">Home</button></ExpenseQuickFilters>)
    await userEvent.click(screen.getByRole('button', { name: 'Home' }))
    expect(screen.getByRole('group')).not.toHaveClass('is-expanded')
  })
})
