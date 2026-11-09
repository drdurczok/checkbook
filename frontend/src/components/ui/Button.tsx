import type { ButtonHTMLAttributes, ReactNode } from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'dangerGhost'
type ButtonSize = 'default' | 'compact' | 'icon'

const variantClass: Record<ButtonVariant, string> = {
  primary: '',
  secondary: 'button--ghost',
  danger: 'button--danger',
  dangerGhost: 'button--danger-ghost',
}

const sizeClass: Record<ButtonSize, string> = {
  default: '',
  compact: 'button--compact',
  icon: 'button--mobile-icon',
}

export function Button({
  variant = 'primary',
  size = 'default',
  busy = false,
  busyLabel,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
  busy?: boolean
  busyLabel?: ReactNode
}) {
  const classes = ['button', variantClass[variant], sizeClass[size], className].filter(Boolean).join(' ')
  return (
    <button {...props} aria-busy={busy || undefined} className={classes} disabled={disabled || busy}>
      {busy && busyLabel !== undefined ? busyLabel : children}
    </button>
  )
}
