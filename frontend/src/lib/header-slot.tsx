/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { DependencyList, PropsWithChildren, ReactNode } from 'react'

type HeaderSlotContextValue = {
  headerControls: ReactNode | null
  setHeaderControls: (node: ReactNode | null) => void
  headerActions: ReactNode | null
  setHeaderActions: (node: ReactNode | null) => void
}

const HeaderSlotContext = createContext<HeaderSlotContextValue | null>(null)

export function HeaderSlotProvider({ children }: PropsWithChildren) {
  const [headerControls, setHeaderControls] = useState<ReactNode | null>(null)
  const [headerActions, setHeaderActions] = useState<ReactNode | null>(null)

  const value = useMemo<HeaderSlotContextValue>(
    () => ({ headerControls, setHeaderControls, headerActions, setHeaderActions }),
    [headerControls, headerActions],
  )

  return <HeaderSlotContext.Provider value={value}>{children}</HeaderSlotContext.Provider>
}

export function useHeaderSlotContext() {
  const context = useContext(HeaderSlotContext)
  if (!context) {
    throw new Error('useHeaderSlotContext must be used within a HeaderSlotProvider')
  }
  return context
}

/**
 * Inject controls into the app topbar for the lifetime of the calling component.
 * The node is set on mount and whenever `deps` change, and cleared on unmount.
 */
export function useHeaderSlot(node: ReactNode, deps: DependencyList) {
  const { setHeaderControls } = useHeaderSlotContext()

  useEffect(() => {
    setHeaderControls(node)
    return () => setHeaderControls(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

/**
 * Inject a leading control into the topbar's right-hand actions cluster
 * (before the shared date filter and profile) for the lifetime of the
 * calling component. Cleared on unmount just like useHeaderSlot.
 */
export function useHeaderActions(node: ReactNode, deps: DependencyList) {
  const { setHeaderActions } = useHeaderSlotContext()

  useEffect(() => {
    setHeaderActions(node)
    return () => setHeaderActions(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
