import { useEffect } from 'react'

/**
 * Locks page scroll while a modal is open.
 *
 * The viewport-framed app scrolls inside .app-content. Lock that element
 * without repositioning the body (and its fixed chrome/composited layers).
 * Outside the app shell, retain the fixed-body fallback for document scrolling.
 * A counter keeps stacked modals from unlocking each other prematurely.
 */

let lockCount = 0
let savedScrollY = 0
let workspaceLock: {
  element: HTMLElement
  overflow: string
  scrollbarGutter: string
} | null = null
let saved: {
  position: string
  top: string
  left: string
  right: string
  width: string
  overflow: string
  paddingRight: string
} | null = null

function lock() {
  if (lockCount === 0 && typeof document !== 'undefined') {
    const workspace = document.querySelector<HTMLElement>('.app-content')
    if (workspace) {
      workspaceLock = {
        element: workspace,
        overflow: workspace.style.overflow,
        scrollbarGutter: workspace.style.scrollbarGutter,
      }
      // Reserve an existing classic scrollbar, but don't add a new gutter to
      // short pages or platforms using overlay scrollbars.
      const style = getComputedStyle(workspace)
      const borderWidth = (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0)
      if (workspace.offsetWidth - workspace.clientWidth - borderWidth > 0) {
        workspace.style.scrollbarGutter = style.scrollbarGutter === 'auto' ? 'stable' : style.scrollbarGutter
      }
      workspace.style.overflow = 'hidden'
      lockCount += 1
      return
    }
    const body = document.body
    savedScrollY = window.scrollY
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth
    saved = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      width: body.style.width,
      overflow: body.style.overflow,
      paddingRight: body.style.paddingRight,
    }
    body.style.position = 'fixed'
    body.style.top = `-${savedScrollY}px`
    body.style.left = '0'
    body.style.right = '0'
    body.style.width = '100%'
    body.style.overflow = 'hidden'
    // Compensate for the desktop scrollbar disappearing so content doesn't shift.
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`
    }
  }
  lockCount += 1
}

function unlock() {
  lockCount = Math.max(0, lockCount - 1)
  if (lockCount === 0 && workspaceLock) {
    const { element, overflow, scrollbarGutter } = workspaceLock
    element.style.overflow = overflow
    element.style.scrollbarGutter = scrollbarGutter
    workspaceLock = null
  }
  if (lockCount === 0 && saved && typeof document !== 'undefined') {
    const body = document.body
    body.style.position = saved.position
    body.style.top = saved.top
    body.style.left = saved.left
    body.style.right = saved.right
    body.style.width = saved.width
    body.style.overflow = saved.overflow
    body.style.paddingRight = saved.paddingRight
    saved = null
    window.scrollTo(0, savedScrollY)
  }
}

export function useScrollLock(active = true) {
  useEffect(() => {
    if (!active) {
      return
    }
    lock()
    return () => unlock()
  }, [active])
}
