import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HoldConfirmButton } from './HoldConfirmButton'

describe('HoldConfirmButton', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('confirms after holding for the full duration and shows ring progress', async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(
      <HoldConfirmButton ariaLabel="Delete card" holdMs={2000} onConfirm={onConfirm}>
        trash
      </HoldConfirmButton>,
    )

    const button = screen.getByRole('button', { name: 'Delete card' })
    await user.pointer([{ keys: '[MouseLeft>]', target: button }])

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    const midway = button.querySelector<SVGCircleElement>('.hold-confirm-button__progress')
    expect(Number(midway?.getAttribute('stroke-dashoffset'))).toBeGreaterThan(0)
    expect(onConfirm).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(1100)
    })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(button).not.toHaveClass('is-holding')
  })

  it('cancels an in-progress hold when disabled and cannot restart it', async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { rerender } = render(<HoldConfirmButton ariaLabel="Delete card" onConfirm={onConfirm}>trash</HoldConfirmButton>)
    const button = screen.getByRole('button', { name: 'Delete card' })
    await user.pointer([{ keys: '[MouseLeft>]', target: button }])
    await act(async () => { vi.advanceTimersByTime(500) })
    rerender(<HoldConfirmButton ariaLabel="Delete card" disabled onConfirm={onConfirm}>trash</HoldConfirmButton>)
    await act(async () => { vi.advanceTimersByTime(2500) })
    expect(button).toBeDisabled()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(button).not.toHaveClass('is-holding')
  })

  it('cancels when released before the duration', async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(
      <HoldConfirmButton ariaLabel="Delete card" holdMs={2000} onConfirm={onConfirm}>
        trash
      </HoldConfirmButton>,
    )

    const button = screen.getByRole('button', { name: 'Delete card' })
    await user.pointer([{ keys: '[MouseLeft>]', target: button }])
    await act(async () => {
      vi.advanceTimersByTime(800)
    })
    await user.pointer([{ keys: '[/MouseLeft]', target: button }])
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })

    expect(onConfirm).not.toHaveBeenCalled()
    expect(button).not.toHaveClass('is-holding')
    // After cancel the ring is reset: offset back at the full circumference.
    const circumference = 2 * Math.PI * 15.5
    expect(Number(button.querySelector<SVGCircleElement>('.hold-confirm-button__progress')?.getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference, 5)
  })

  it('confirms via keyboard hold and cancels on early key release', async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(
      <HoldConfirmButton ariaLabel="Delete card" holdMs={2000} onConfirm={onConfirm}>
        trash
      </HoldConfirmButton>,
    )

    const button = screen.getByRole('button', { name: 'Delete card' })
    button.focus()
    await user.keyboard('{Enter>}')
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await user.keyboard('{/Enter}')
    await act(async () => {
      vi.advanceTimersByTime(2000)
    })
    expect(onConfirm).not.toHaveBeenCalled()

    await user.keyboard('{Enter>}')
    await act(async () => {
      vi.advanceTimersByTime(2100)
    })
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
