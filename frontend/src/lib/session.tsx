/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { Dispatch, PropsWithChildren, SetStateAction } from 'react'
import type { SessionResponse } from '../types'

export const STORAGE_KEY = 'checkbook.session'

type SessionContextValue = {
  session: SessionResponse | null
  token: string
  currency: string
  applySession: (next: SessionResponse) => void
  clearSession: () => void
  error: string | null
  setError: Dispatch<SetStateAction<string | null>>
  message: string | null
  setMessage: Dispatch<SetStateAction<string | null>>
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<SessionResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const applySession = useCallback((next: SessionResponse) => {
    window.localStorage.setItem(STORAGE_KEY, next.token)
    setSession(next)
  }, [])

  const clearSession = useCallback(() => {
    window.localStorage.removeItem(STORAGE_KEY)
    setSession(null)
  }, [])

  const value = useMemo<SessionContextValue>(
    () => ({
      session,
      token: session?.token ?? '',
      currency: session?.household.base_currency ?? 'PLN',
      applySession,
      clearSession,
      error,
      setError,
      message,
      setMessage,
    }),
    [session, applySession, clearSession, error, message],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession() {
  const context = useContext(SessionContext)
  if (!context) {
    throw new Error('useSession must be used within a SessionProvider')
  }
  return context
}
