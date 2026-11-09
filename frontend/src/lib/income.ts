import type { IncomeFrequency, IncomeLine, IncomeSource } from '../types'

export const FREQUENCY_MULTIPLIER: Record<IncomeFrequency, number> = {
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  quarterly: 4,
  yearly: 1,
  one_off: 0,
}

export const FREQUENCY_OPTIONS: Array<{ value: IncomeFrequency; label: string }> = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'biweekly', label: 'Biweekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
  { value: 'one_off', label: 'One-off' },
]

export const SOURCE_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'employment', label: 'Employment' },
  { value: 'rental', label: 'Rental' },
  { value: 'investment', label: 'Investment' },
  { value: 'business', label: 'Business' },
  { value: 'benefit', label: 'Benefit' },
  { value: 'other', label: 'Other' },
]

export const frequencyLabel = (frequency: IncomeFrequency) =>
  FREQUENCY_OPTIONS.find((option) => option.value === frequency)?.label ?? 'Monthly'

export const sourceTypeLabel = (value: string) =>
  SOURCE_TYPE_OPTIONS.find((option) => option.value === value)?.label ?? value

/** The employer/company name, read from a custom field (Employer/Company/…);
 * falls back to the source's own name when no such field is set (e.g. a
 * freelance/business source with no employer) so it stays distinguishable
 * from other sources of the same type, rather than every untitled-org
 * source collapsing to the same generic type label ("Business"). */
export const sourceOrg = (source: IncomeSource) => {
  const explicit = source.fields.find((field) => /employer|company|organization|organisation|payer|org/i.test(field.label))?.value
  return explicit?.trim() || source.name
}

/** A single line's contribution to a 12-month annualised total. */
export const annualiseLine = (line: IncomeLine) =>
  (Number(line.amount) || 0) * (FREQUENCY_MULTIPLIER[line.frequency] ?? 12)
