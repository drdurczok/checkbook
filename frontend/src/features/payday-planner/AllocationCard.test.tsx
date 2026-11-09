import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlannerAllocation } from '../../contracts/payday-planner'
import { AllocationCard } from './AllocationCard'

const item: PlannerAllocation = { id: 'payment', title: 'Rent', section: 'mandatory', kind: 'expense', category_id: null, subcategory_id: null, category_name: null, subcategory_name: null, amount: '100.00', notes: '', source: 'manual', template_id: null, completed: false, completed_at: null, actual_amount: null, difference: null, percentage: null }
function setup({ amount = '$100.00', currency = 'USD', pending = false, completed = false }: { amount?: string; currency?: string; pending?: boolean; completed?: boolean } = {}) {
  const onComplete = vi.fn()
  const onEdit = vi.fn()
  const view = render(<ul><AllocationCard item={{ ...item, completed }} amount={amount} currency={currency} pending={pending} onComplete={onComplete} onEdit={onEdit} /></ul>)
  return { ...view, card: screen.getByRole('button', { name: `Rent, ${amount}${completed ? ', completed' : ''}` }), onComplete, onEdit }
}
afterEach(() => vi.useRealTimers())

describe('allocation card actions', () => {
  it('shows the category subtitle and recurring marker only for recurring payments', () => {
    const view = render(<ul><AllocationCard item={{ ...item, template_id: 'template' }} subtitle="Home" amount="$100.00" pending={false} onComplete={vi.fn()} onEdit={vi.fn()} /></ul>)
    expect(screen.getByLabelText('Repeats every month')).toHaveClass('planner-item__recurring')
    expect(screen.getByText('Home')).toHaveClass('planner-item__category')
    view.rerender(<ul><AllocationCard item={item} amount="$100.00" pending={false} onComplete={vi.fn()} onEdit={vi.fn()} /></ul>)
    expect(screen.queryByLabelText('Repeats every month')).not.toBeInTheDocument()
    expect(screen.queryByText('Home')).not.toBeInTheDocument()
  })

  it('completes on a short click without opening an editor or leaving a hold timer', () => {
    vi.useFakeTimers()
    const { card, onComplete, onEdit } = setup()
    fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10 })
    act(() => vi.advanceTimersByTime(499))
    fireEvent.pointerUp(card)
    fireEvent.click(card)
    expect(onComplete).toHaveBeenCalledOnce()
    act(() => vi.advanceTimersByTime(600))
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('completes a touch tap even though pointerleave fires between release and click', () => {
    vi.useFakeTimers()
    const { card, onComplete, onEdit } = setup()
    fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10 })
    act(() => vi.advanceTimersByTime(499))
    fireEvent.pointerUp(card)
    fireEvent.pointerLeave(card)
    fireEvent.click(card)
    expect(onComplete).toHaveBeenCalledOnce()
    act(() => vi.advanceTimersByTime(600))
    expect(onEdit).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('clears the native long-press selection when the hold opens the editor', () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number)
    const removeAllRanges = vi.fn()
    vi.spyOn(document, 'getSelection').mockReturnValue({ removeAllRanges } as unknown as Selection)
    const { card, onEdit } = setup()
    fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10 })
    act(() => vi.advanceTimersByTime(499))
    expect(removeAllRanges).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(onEdit).toHaveBeenCalledOnce()
    expect(removeAllRanges).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(100))
    expect(removeAllRanges).toHaveBeenCalledTimes(2)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps long-press suppression when pointerleave follows the release', () => {
    vi.useFakeTimers()
    const { card, onComplete } = setup()
    fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10 })
    act(() => vi.advanceTimersByTime(500))
    fireEvent.pointerUp(card)
    fireEvent.pointerLeave(card)
    fireEvent.click(card)
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('opens the editor at 500ms and suppresses only the release click', () => {
    vi.useFakeTimers()
    const { card, onComplete, onEdit } = setup()
    fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10 })
    act(() => vi.advanceTimersByTime(499))
    expect(onEdit).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(onEdit).toHaveBeenCalledOnce()
    act(() => vi.advanceTimersByTime(1000))
    expect(onEdit).toHaveBeenCalledOnce()
    fireEvent.pointerUp(card)
    fireEvent.click(card)
    expect(onComplete).not.toHaveBeenCalled()
    fireEvent.pointerDown(card, { button: 0 })
    fireEvent.pointerUp(card)
    fireEvent.click(card)
    expect(onComplete).toHaveBeenCalledOnce()
    expect(onEdit).toHaveBeenCalledOnce()
  })

  it.each([1, 2])('does not start a hold for pointer button %s', (button) => {
    vi.useFakeTimers()
    const { card, onComplete, onEdit } = setup()
    fireEvent.pointerDown(card, { button })
    act(() => vi.advanceTimersByTime(600))
    fireEvent.pointerUp(card, { button })
    expect(onEdit).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it.each([
    [21, 10],
    [10, 21],
    [18, 18],
  ])('cancels editing and release completion after scrolling to %s, %s', (clientX, clientY) => {
    vi.useFakeTimers()
    const { card, onComplete, onEdit } = setup()
    fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(card, { clientX, clientY })
    fireEvent.pointerMove(card, { clientX: 10, clientY: 10 })
    act(() => vi.advanceTimersByTime(600))
    fireEvent.pointerUp(card)
    fireEvent.click(card)
    expect(onEdit).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
    fireEvent.pointerDown(card, { button: 0 })
    fireEvent.pointerUp(card)
    fireEvent.click(card)
    expect(onComplete).toHaveBeenCalledOnce()
  })

  it('allows a hold when movement is exactly 10px', () => {
    vi.useFakeTimers()
    const { card, onEdit } = setup()
    fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(card, { clientX: 16, clientY: 18 })
    act(() => vi.advanceTimersByTime(500))
    expect(onEdit).toHaveBeenCalledOnce()
  })

  it.each(['cancel', 'leave'])('suppresses editing and release completion after pointer %s', (event) => {
    vi.useFakeTimers()
    const { card, onComplete, onEdit } = setup()
    fireEvent.pointerDown(card, { button: 0 })
    if (event === 'cancel') fireEvent.pointerCancel(card)
    else fireEvent.pointerLeave(card)
    act(() => vi.advanceTimersByTime(600))
    fireEvent.pointerUp(card)
    fireEvent.click(card)
    expect(onEdit).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it.each(['Enter', ' '])('completes using the %s key', (key) => {
    const { card, onComplete, onEdit } = setup()
    fireEvent.keyDown(card, { key })
    fireEvent.keyUp(card, { key })
    expect(onComplete).toHaveBeenCalledOnce()
    expect(onEdit).not.toHaveBeenCalled()
  })

  it.each(['contextmenu', 'ContextMenu', 'Shift+F10'])('opens the editor using %s', (action) => {
    const { card, onComplete, onEdit } = setup()
    if (action === 'contextmenu') fireEvent.contextMenu(card)
    else fireEvent.keyDown(card, { key: action === 'ContextMenu' ? 'ContextMenu' : 'F10', shiftKey: action === 'Shift+F10' })
    expect(onEdit).toHaveBeenCalledOnce()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('does not act on unrelated keyboard shortcuts', () => {
    const { card, onComplete, onEdit } = setup()
    fireEvent.keyDown(card, { key: 'F10' })
    fireEvent.keyDown(card, { key: 'Escape' })
    expect(onEdit).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it.each([false, true])('exposes completed=%s without rendering old action options or hints', (completed) => {
    const { card, container, onComplete } = setup({ completed })
    expect(card).toHaveAttribute('aria-pressed', String(completed))
    expect(card).toHaveAttribute('aria-disabled', 'false')
    expect(card).not.toHaveAttribute('aria-expanded')
    expect(card).toHaveAccessibleDescription('Press to toggle completion. Hold, right click, or press Shift+F10 to edit.')
    if (completed) expect(container.querySelector('.planner-item')).toHaveClass('planner-item--completed')
    else expect(container.querySelector('.planner-item')).not.toHaveClass('planner-item--completed')
    fireEvent.click(card)
    expect(onComplete).toHaveBeenCalledOnce()
    expect(screen.getAllByRole('button')).toEqual([card])
    expect(screen.queryByRole('button', { name: /Edit Rent|Delete Rent|Mark completed|Mark incomplete|options/i })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Actions for Rent')).not.toBeInTheDocument()
    expect(screen.queryByText(/long press, right click, or press Enter for payment actions/i)).not.toBeInTheDocument()
  })

  it.each([false, true])('blocks all actions while pending with completed=%s', (completed) => {
    vi.useFakeTimers()
    const { card, onComplete, onEdit } = setup({ completed, pending: true })
    expect(card).toHaveAttribute('aria-disabled', 'true')
    expect(card).toHaveAttribute('aria-pressed', String(completed))
    fireEvent.pointerDown(card, { button: 0 })
    act(() => vi.advanceTimersByTime(600))
    fireEvent.pointerUp(card)
    fireEvent.click(card)
    for (const key of ['Enter', ' ', 'ContextMenu']) fireEvent.keyDown(card, { key })
    fireEvent.keyDown(card, { key: 'F10', shiftKey: true })
    fireEvent.contextMenu(card)
    expect(onComplete).not.toHaveBeenCalled()
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('clears the hold timer when unmounted', () => {
    vi.useFakeTimers()
    const { card, unmount, onComplete, onEdit } = setup()
    fireEvent.pointerDown(card, { button: 0 })
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    act(() => vi.advanceTimersByTime(600))
    expect(onEdit).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it.each([
    ['$12345678901234567890.01', 'USD', '$', '$ 12345678901234567890.01'],
    ['$100.00', 'USD', '$', '$ 100.00'],
    ['-$100', 'USD', '$', '-$ 100'],
    ['$ 100.00', 'USD', '$', '$ 100.00'],
    ['-123.4500 $', 'USD', '$', '-123.4500 $'],
    ['123,45\u00a0\u20ac', 'EUR', '\u20ac', '123,45\u00a0\u20ac'],
  ])('spaces prefix currency but preserves the original accessible amount %s', (amount, currency, symbol, displayed) => {
    const { card, container } = setup({ amount, currency })
    expect(container.querySelector('.planner-item__amount')?.textContent).toBe(displayed)
    expect(container.querySelector('.planner-item__currency')?.textContent).toBe(symbol)
    expect(card).toHaveAccessibleName(`Rent, ${amount}`)
  })

  it('leaves a formatted amount unchanged when no currency symbol matches', () => {
    const { container } = setup({ amount: '100.00 credits' })
    expect(container.querySelector('.planner-item__amount')?.textContent).toBe('100.00 credits')
    expect(container.querySelector('.planner-item__currency')).toBeNull()
  })
})
