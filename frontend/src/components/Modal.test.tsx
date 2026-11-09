import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Modal } from './Modal'

describe('Modal', () => {
  it('locks the workspace without moving the body and restores styles after stacked dialogs close', () => {
    const workspace = document.createElement('main')
    workspace.className = 'app-content'
    workspace.style.overflow = 'auto'
    workspace.style.scrollbarGutter = 'auto'
    workspace.scrollTop = 240
    Object.defineProperties(workspace, {
      offsetWidth: { value: 400 },
      clientWidth: { value: 385 },
    })
    document.body.append(workspace)
    const bodyStyle = document.body.style.cssText
    const onClose = vi.fn()
    const parent = <Modal title="Parent" onClose={onClose}>Parent content</Modal>
    const { rerender, unmount } = render(<>{parent}</>)
    try {
      expect(workspace.style.overflow).toBe('hidden')
      expect(workspace.style.scrollbarGutter).toBe('stable')
      expect(workspace.scrollTop).toBe(240)
      expect(document.body.style.cssText).toBe(bodyStyle)
      rerender(<>{parent}<Modal title="Child" onClose={onClose}>Child content</Modal></>)
      rerender(<>{parent}</>)
      expect(workspace.style.overflow).toBe('hidden')
      unmount()
      expect(workspace.style.overflow).toBe('auto')
      expect(workspace.style.scrollbarGutter).toBe('auto')
      expect(workspace.scrollTop).toBe(240)
      expect(document.body.style.cssText).toBe(bodyStyle)
    } finally {
      unmount()
      workspace.remove()
    }
  })

  it('does not add a scrollbar gutter to a workspace without a classic scrollbar', () => {
    const workspace = document.createElement('main')
    workspace.className = 'app-content'
    document.body.append(workspace)
    const { unmount } = render(<Modal title="Dialog" onClose={vi.fn()}>Content</Modal>)
    try {
      expect(workspace.style.scrollbarGutter).toBe('')
    } finally {
      unmount()
      workspace.remove()
    }
  })

  it('labels the dialog and closes on Escape', async () => {
    const onClose = vi.fn()
    render(
      <Modal title="Edit property" onClose={onClose}>
        <button type="button">Save</button>
      </Modal>,
    )

    expect(screen.getByRole('dialog', { name: 'Edit property' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('traps focus and closes only when the backdrop is pressed', () => {
    const onClose = vi.fn()
    render(
      <Modal title="Dialog" onClose={onClose}>
        <button type="button">First</button>
        <button type="button">Last</button>
      </Modal>,
    )

    const first = screen.getByRole('button', { name: 'Close' })
    const last = screen.getByRole('button', { name: 'Last' })
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(first).toHaveFocus()
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes only the topmost modal when dialogs are stacked', async () => {
    const parentClose = vi.fn()
    const childClose = vi.fn()
    const parent = (
      <Modal title="Income source" onClose={parentClose}>
        <button type="button">Launch invoice</button>
      </Modal>
    )
    const { rerender } = render(parent)

    rerender(
      <Modal title="Income source" onClose={parentClose}>
        <Modal title="Invoice builder" onClose={childClose}>
          <button type="button">Send</button>
        </Modal>
      </Modal>,
    )

    await userEvent.keyboard('{Escape}')
    expect(childClose).toHaveBeenCalledOnce()
    expect(parentClose).not.toHaveBeenCalled()

    // With the child unmounted, the parent owns Escape again.
    rerender(parent)
    await userEvent.keyboard('{Escape}')
    expect(parentClose).toHaveBeenCalledOnce()
  })
})
