import { X } from 'lucide-react'
import { useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { PropsWithChildren, ReactNode } from 'react'
import { useScrollLock } from '../lib/scroll-lock'
import { keepFocusInDialog, useDialogBehavior } from '../lib/use-dialog'

/**
 * Shared modal chrome: `div.modal-backdrop > section.modal-shell[role=dialog]`
 * with the `drive-picker__header` header (optional leading slot, eyebrow span,
 * h2, close button).
 *
 * Pass `leading` to place a control at the far left of the header row (e.g.
 * an overflow-menu trigger) beside the title block.
 *
 * Pass `actions` to replace the default X close button with bespoke header
 * controls (e.g. a "Close" text button or a button group) so the existing
 * markup of migrated modals stays byte-for-byte identical.
 */
export function Modal({
  eyebrow,
  title,
  titleId,
  onClose,
  className,
  backdropClassName,
  headerClassName,
  leading,
  actions,
  footer,
  children,
}: PropsWithChildren<{
  eyebrow?: ReactNode
  title: ReactNode
  titleId?: string
  onClose: () => void
  className?: string
  backdropClassName?: string
  headerClassName?: string
  leading?: ReactNode
  actions?: ReactNode
  footer?: ReactNode
}>) {
  useScrollLock()
  const generatedTitleId = useId()
  const resolvedTitleId = titleId ?? generatedTitleId
  const dialogRef = useRef<HTMLElement | null>(null)
  useDialogBehavior(dialogRef, onClose)

  // Portaled to the document body: the modal must not live inside the
  // workspace's overflow scroller, where WebKit stops backdrop-filter from
  // sampling the page behind it (the frosted sheet would render as a flat
  // single color instead of a blur).
  return createPortal(
    <div
      className={`modal-backdrop${backdropClassName ? ` ${backdropClassName}` : ''}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      role="presentation"
    >
      <section
        ref={dialogRef}
        className={`modal-shell${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={resolvedTitleId}
        onKeyDown={keepFocusInDialog}
        tabIndex={-1}
      >
        <div className={`drive-picker__header${headerClassName ? ` ${headerClassName}` : ''}`}>
          {leading ? <div className="drive-picker__header-leading">{leading}</div> : null}
          <div className="drive-picker__header-title">
            {eyebrow ? <span>{eyebrow}</span> : null}
            <h2 id={resolvedTitleId}>{title}</h2>
          </div>
          {actions ?? (
            <button aria-label="Close" className="record-add-close" onClick={onClose} type="button">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        {children}
        {footer ?? null}
      </section>
    </div>,
    document.body,
  )
}
