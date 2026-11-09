import type { PropsWithChildren, ReactNode } from 'react'
import { Modal } from '../Modal'

/**
 * The shared window for every add/edit form — one chrome everywhere.
 *
 * Phones: rises from the bottom of the screen as a sheet only as tall as its
 * content; the action bar inside the form becomes the compact centered
 * footer. Desktop keeps the centered floating card. Both use a clear backdrop
 * so the actual underlying page stays visible.
 *
 * The body hosts the shared field primitives — `OutlinedInput`,
 * `OutlinedNativeSelect`, `OutlinedTextarea`, `.field-pair` rows — so a
 * window is just a form plus a footer. `title` accepts any node, letting
 * windows with a kind dropdown pass their `.record-add-kind` toggle
 * (popover included, anchored by its relative wrapper).
 */
export function FormSheet({
  eyebrow,
  title,
  titleId,
  onClose,
  className,
  headerClassName,
  leading,
  actions,
  children,
}: PropsWithChildren<{
  eyebrow?: ReactNode
  title: ReactNode
  titleId?: string
  onClose: () => void
  className?: string
  headerClassName?: string
  leading?: ReactNode
  actions?: ReactNode
}>) {
  return (
    <Modal
      className={`modal-sheet${className ? ` ${className}` : ''}`}
      backdropClassName="modal-backdrop--sheet"
      eyebrow={eyebrow}
      title={title}
      titleId={titleId}
      onClose={onClose}
      headerClassName={headerClassName}
      leading={leading}
      actions={actions}
    >
      {children}
    </Modal>
  )
}
