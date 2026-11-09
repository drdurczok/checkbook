import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'

/**
 * Press-and-hold confirmation button. The action fires only after the
 * pointer (or Enter/Space key) is held for `holdMs`; an SVG ring around the
 * icon fills up to visualise the progress. Releasing early cancels.
 *
 * Used for destructive actions (e.g. deleting a planning card) where a
 * single accidental tap must not trigger the operation.
 */
export function HoldConfirmButton({
  holdMs = 2000,
  disabled = false,
  ariaLabel,
  title,
  onConfirm,
  children,
}: {
  holdMs?: number
  disabled?: boolean
  ariaLabel: string
  title?: string
  onConfirm: () => void
  children: ReactNode
}) {
  const [progress, setProgress] = useState(0)
  const [isHolding, setIsHolding] = useState(false)
  const frameRef = useRef<number | null>(null)
  const startedAtRef = useRef(0)
  const onConfirmRef = useRef(onConfirm)

  useEffect(() => {
    onConfirmRef.current = onConfirm
  }, [onConfirm])

  const stopHold = useCallback(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    startedAtRef.current = 0
    setIsHolding(false)
    setProgress(0)
  }, [])

  const startHold = useCallback(() => {
    if (disabled || frameRef.current !== null) {
      return
    }
    startedAtRef.current = performance.now()
    setIsHolding(true)
    setProgress(0)
    const step = () => {
      frameRef.current = null
      const elapsed = performance.now() - startedAtRef.current
      if (elapsed >= holdMs) {
        startedAtRef.current = 0
        setIsHolding(false)
        setProgress(0)
        onConfirmRef.current()
        return
      }
      setProgress(elapsed / holdMs)
      frameRef.current = window.requestAnimationFrame(step)
    }
    frameRef.current = window.requestAnimationFrame(step)
  }, [disabled, holdMs])

  useEffect(() => stopHold, [disabled, stopHold])

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    // Prevent the browser from treating the hold as a text selection or a
    // click on release; the confirmation comes only from the timer.
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    startHold()
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.repeat) {
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      startHold()
    }
  }

  const handleKeyUp = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      stopHold()
    }
  }

  const circumference = 2 * Math.PI * 15.5

  return (
    <button
      aria-label={ariaLabel}
      disabled={disabled}
      onBlur={stopHold}
      className={`hold-confirm-button${isHolding ? ' is-holding' : ''}`}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onPointerCancel={stopHold}
      onPointerDown={handlePointerDown}
      onPointerLeave={stopHold}
      onPointerUp={stopHold}
      style={{ '--hold-progress': progress } as React.CSSProperties}
      title={title ?? `${ariaLabel} (hold to confirm)`}
      type="button"
    >
      <span aria-hidden="true" className="hold-confirm-button__icon">{children}</span>
      <svg aria-hidden="true" className="hold-confirm-button__ring" viewBox="0 0 36 36">
        <circle className="hold-confirm-button__track" cx="18" cy="18" r="15.5" />
        <circle
          className="hold-confirm-button__progress"
          cx="18"
          cy="18"
          r="15.5"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
        />
      </svg>
    </button>
  )
}
