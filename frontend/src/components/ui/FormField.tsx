import type { LabelHTMLAttributes, PropsWithChildren, ReactNode } from 'react'

export function FormField({
  label,
  hint,
  className,
  children,
  ...props
}: PropsWithChildren<LabelHTMLAttributes<HTMLLabelElement> & {
  label: ReactNode
  hint?: ReactNode
}>) {
  return (
    <label {...props} className={['inline-field', className].filter(Boolean).join(' ')}>
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  )
}
