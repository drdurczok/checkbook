import type { PropsWithChildren, ReactNode } from 'react'
import { Modal } from './Modal'

/**
 * Shared chrome for the month-table detail modals (net worth, loans,
 * utilities): the overflow menu sits far left, the title and its currency
 * follow it, and the bare "x" close stays far right — one row at every
 * width (`.detail-table-header`). The title first steps down a size and
 * only then truncates, so a long loan name never wraps the header.
 *
 * `options` takes the leading DetailActionsMenu; `closeLabel` names the
 * close button for screen readers and tests.
 */
export function DetailModal({
  title,
  currency,
  options,
  closeLabel = 'Close',
  className,
  titleId,
  onClose,
  children,
}: PropsWithChildren<{
  title: ReactNode
  currency: string
  options: ReactNode
  closeLabel?: string
  className?: string
  titleId?: string
  onClose: () => void
}>) {
  return (
    <Modal
      className={className}
      headerClassName="detail-table-header"
      title={<>{title}{' '}<span className="net-worth-modal__currency">{currency}</span></>}
      titleId={titleId}
      onClose={onClose}
      leading={options}
      actions={(
        <button
          aria-label={closeLabel}
          className="nw-close net-worth-modal__close"
          onClick={onClose}
          type="button"
        >
          x
        </button>
      )}
    >
      {children}
    </Modal>
  )
}
