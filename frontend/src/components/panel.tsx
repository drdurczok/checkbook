import type { PropsWithChildren, ReactNode } from 'react'

export function SectionPanel({
  title,
  eyebrow,
  actions,
  headerCenter,
  className,
  children,
}: PropsWithChildren<{
  title?: ReactNode
  eyebrow?: string
  actions?: ReactNode
  headerCenter?: ReactNode
  className?: string
}>) {
  const hasHeader = Boolean(title || eyebrow || actions || headerCenter)

  return (
    <section className={`panel${className ? ` ${className}` : ''}`}>
      {hasHeader ? (
        <header className="panel__header">
          <div className="panel__heading">
            {eyebrow ? <p className="panel__eyebrow">{eyebrow}</p> : null}
            {title ? <h2>{title}</h2> : null}
          </div>
          {headerCenter ? <div className="panel__center">{headerCenter}</div> : null}
          {actions ? <div className="panel__actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  )
}

export function EmptyState({
  title,
  body,
}: {
  title: string
  body: string
}) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  )
}
