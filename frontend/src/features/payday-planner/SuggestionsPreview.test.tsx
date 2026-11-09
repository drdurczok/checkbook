import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { PlannerSuggestion } from '../../contracts/payday-planner'
import { SuggestionsPreview } from './SuggestionsPreview'

const suggestions: PlannerSuggestion[] = [{ key: 'rent', title: 'Rent', section: 'mandatory', kind: 'expense', category_id: null, subcategory_id: null, category_name: null, subcategory_name: null, amount: '123.45', notes: '', reason: 'From your mandatory template', template_id: 'template-1' }, { key: 'food', title: 'Food', section: 'monthly', kind: 'expense', category_id: 'food', subcategory_id: null, category_name: 'Food', subcategory_name: null, amount: '20.00', notes: '', reason: 'Recent spending average', template_id: null }]

describe('suggestion preview', () => {
  it('shows reasons and applies only selected editable decimal amounts', async () => {
    const user = userEvent.setup()
    const apply = vi.fn().mockResolvedValue(undefined)
    render(<SuggestionsPreview suggestions={suggestions} pending={false} onApply={apply} onClose={vi.fn()} />)
    expect(screen.getByText('From your mandatory template')).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Food' }))
    const amount = screen.getByLabelText('Amount for Rent')
    await user.clear(amount)
    await user.type(amount, '125.67')
    await user.click(screen.getByRole('button', { name: 'Apply 1 selected' }))
    expect(apply).toHaveBeenCalledWith([{ ...suggestions[0], amount: '125.67' }])
  })
  it('blocks invalid precision and rejects all without calling apply', async () => {
    const user = userEvent.setup()
    const apply = vi.fn()
    render(<SuggestionsPreview suggestions={suggestions} pending={false} onApply={apply} onClose={vi.fn()} />)
    const amount = screen.getByLabelText('Amount for Rent')
    await user.clear(amount)
    await user.type(amount, '1.001')
    expect(screen.getByRole('button', { name: 'Apply 2 selected' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Reject all' }))
    expect(screen.getByRole('button', { name: 'Apply 0 selected' })).toBeDisabled()
    expect(apply).not.toHaveBeenCalled()
  })
  it('keeps edited preview on a failed apply', async () => {
    const user = userEvent.setup()
    render(<SuggestionsPreview suggestions={suggestions} pending={false} onApply={vi.fn().mockRejectedValue(new Error('Try again'))} onClose={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Apply 2 selected' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Try again'))
    expect(screen.getByLabelText('Amount for Rent')).toHaveValue('123.45')
  })
})
