import type { ReactNode } from 'react'
import { EmptyState } from '../panel'

export function AsyncState({
  loading,
  error,
  empty,
  loadingLabel = 'Loading',
  emptyTitle,
  emptyBody,
  children,
}: {
  loading: boolean
  error?: string | null
  empty: boolean
  loadingLabel?: string
  emptyTitle: string
  emptyBody: string
  children: ReactNode
}) {
  if (loading) {
    return <div className="async-state" role="status">{loadingLabel}</div>
  }
  if (error) {
    return <div className="async-state async-state--error" role="alert">{error}</div>
  }
  if (empty) {
    return <EmptyState title={emptyTitle} body={emptyBody} />
  }
  return children
}
