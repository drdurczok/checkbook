import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { DetailModal } from './DetailModal'
import { DetailActionsMenu } from './DetailActionsMenu'

function renderDetailModal(closeLabel?: string) {
  const onClose = vi.fn()
  render(
    <DetailModal
      className="net-worth-modal utilities-modal"
      title="Utilities"
      currency="PLN"
      titleId="detail-title"
      closeLabel={closeLabel}
      onClose={onClose}
      options={(
        <DetailActionsMenu label="Table options" placement="start"
          actions={[{ label: 'Add month', onClick: vi.fn() }]} />
      )}
    >
      <table><tbody><tr><td>row</td></tr></tbody></table>
    </DetailModal>,
  )
  return { onClose }
}

it('renders options, title with currency, and close in one shared header row', () => {
  renderDetailModal()
  const header = screen.getByRole('heading', { name: 'Utilities PLN' }).closest('.detail-table-header')
  expect(header).not.toBeNull()
  const [options, title, close] = Array.from(header!.children)
  expect(options).toContainElement(screen.getByRole('button', { name: 'Table options' }))
  expect(title).toContainElement(screen.getByRole('heading', { name: 'Utilities PLN' }))
  expect(close).toContainElement(screen.getByRole('button', { name: /^Close$/ }))
})

it('names the close button with the provided label', () => {
  renderDetailModal('Close loan details')
  expect(screen.getByRole('button', { name: 'Close loan details' })).toBeInTheDocument()
})

it('closes through the shared close button', async () => {
  const user = userEvent.setup()
  const { onClose } = renderDetailModal()
  await user.click(screen.getByRole('button', { name: /^Close$/ }))
  expect(onClose).toHaveBeenCalledTimes(1)
})
