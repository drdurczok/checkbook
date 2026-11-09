import type { ComponentPropsWithRef } from 'react'

/** Binary and file controls retain native behavior rather than using a text-field
 * shell. Existing labeled toggle layouts can compose these without losing refs. */
export function Checkbox(props: Omit<ComponentPropsWithRef<'input'>, 'type'>) {
  return <input {...props} type="checkbox" />
}

/** Native month picker for compact headers that supply their own visible label. */
export function MonthInput(props: Omit<ComponentPropsWithRef<'input'>, 'type'>) {
  return <input {...props} type="month" />
}

export function FileInput(props: Omit<ComponentPropsWithRef<'input'>, 'type' | 'value'>) {
  return <input {...props} type="file" />
}
