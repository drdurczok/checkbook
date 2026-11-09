import type { ComponentPropsWithRef, ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

export interface OutlinedControlProps {
  id: string
  'aria-describedby': string | undefined
  'aria-invalid': true | undefined
  disabled: boolean
}

export interface OutlinedFieldProps {
  id: string
  label: string
  hasValue: boolean
  leadingIcon?: ReactNode
  trailing?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  disabled?: boolean
  multiline?: boolean
  className?: string
  children: (props: OutlinedControlProps) => ReactNode
}

/** Layout and labeling only: the control stays in normal flow; the decorative
 * fieldset makes a native notch without affecting control geometry. */
export function OutlinedField({ id, label, hasValue, leadingIcon, trailing, hint, error, disabled = false, multiline = false, className = '', children }: OutlinedFieldProps) {
  const description = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined
  return (
    <div className={`outlined-field${hasValue ? ' has-value' : ''}${disabled ? ' is-disabled' : ''}${error ? ' is-invalid' : ''}${multiline ? ' is-multiline' : ''}${leadingIcon ? ' has-icon' : ''} ${className}`}>
      <div className="outlined-field__shell">
        <fieldset aria-hidden="true" className="outlined-field__outline">
          <legend><span>{label}</span></legend>
        </fieldset>
        <label className="outlined-field__label" htmlFor={id} id={`${id}-label`}>{label}</label>
        {leadingIcon ? <span aria-hidden="true" className="outlined-field__icon">{leadingIcon}</span> : null}
        <div className="outlined-field__control">
          {children({ id, 'aria-describedby': description, 'aria-invalid': error ? true : undefined, disabled })}
        </div>
        {trailing ? <span aria-hidden="true" className="outlined-field__trailing">{trailing}</span> : null}
      </div>
      {hint ? <div className="outlined-field__hint" id={`${id}-hint`}>{hint}</div> : null}
      {error ? <div className="outlined-field__error" id={`${id}-error`} role="alert">{error}</div> : null}
    </div>
  )
}

type FieldOptions = Omit<OutlinedFieldProps, 'children' | 'hasValue' | 'multiline'>
type InputProps = FieldOptions & Omit<ComponentPropsWithRef<'input'>, 'id' | 'className' | 'children' | 'value'> & { value: string | number }
export function OutlinedInput({ id, label, value, leadingIcon, trailing, hint, error, disabled, className, ...input }: InputProps) {
  return (
    <OutlinedField {...{ id, label, leadingIcon, trailing, hint, error, disabled }} hasValue={String(value).length > 0} className={`${className ?? ''}${input.type === 'date' || input.type === 'month' ? ' is-date' : ''}`}>
      {(props) => <input {...input} {...props} className="outlined-field__input" placeholder={input.placeholder ?? label} value={value} />}
    </OutlinedField>
  )
}

type NativeSelectProps = FieldOptions & Omit<ComponentPropsWithRef<'select'>, 'id' | 'className' | 'value'> & { value: string | number }

/** Native option semantics with the same shell as text and custom select controls. */
export function OutlinedNativeSelect({ id, label, value, leadingIcon, trailing, hint, error, disabled, className, children, ...select }: NativeSelectProps) {
  return (
    <OutlinedField {...{ id, label, leadingIcon, hint, error, disabled }} className={`is-native-select ${className ?? ''}`} trailing={trailing ?? <ChevronDown size={16} />} hasValue={String(value).length > 0}>
      {(props) => <select {...select} {...props} className="outlined-field__input outlined-field__native-select" value={value}>{children}</select>}
    </OutlinedField>
  )
}

type TextareaProps = FieldOptions & Omit<ComponentPropsWithRef<'textarea'>, 'id' | 'className' | 'children' | 'value'> & { value: string }
export function OutlinedTextarea({ id, label, value, leadingIcon, trailing, hint, error, disabled, className, ...textarea }: TextareaProps) {
  return (
    <OutlinedField {...{ id, label, leadingIcon, trailing, hint, error, disabled, className }} hasValue={value.length > 0} multiline>
      {(props) => <textarea {...textarea} {...props} className="outlined-field__input" placeholder={textarea.placeholder ?? label} value={value} />}
    </OutlinedField>
  )
}
