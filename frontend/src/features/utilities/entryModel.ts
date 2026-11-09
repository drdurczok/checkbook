import Decimal from 'decimal.js'
import type { UtilityEntryFormField, UtilityEntryValue } from '../../contracts/utilities'

export type UtilityEntryDraft = { amount: string; meter_reading: string; usage_amount: string; amount_source?: 'actual' | 'auto' }

export function utilityDraft(field: UtilityEntryFormField): UtilityEntryDraft {
  return {
    amount_source: field.amount_source ?? (field.unit_rate != null && (field.kind === 'metered' || field.tracking_mode === 'fixed') ? 'auto' : 'actual'),
    amount: field.amount == null ? '' : String(field.amount),
    meter_reading: field.meter_reading == null ? '' : String(field.meter_reading),
    usage_amount: field.usage_amount == null ? '' : String(field.usage_amount),
  }
}

function nonNegative(value: string, label: string): Decimal | null {
  if (!value.trim()) return null
  let number: Decimal
  try { number = new Decimal(value) } catch { throw new Error(`${label} must be a valid number.`) }
  if (!number.isFinite() || number.isNegative()) throw new Error(`${label} must be a non-negative number.`)
  if (number.decimalPlaces() > 4) throw new Error(`${label} supports at most four decimal places.`)
  return number
}

export function utilityEntryPreview(field: UtilityEntryFormField, draft: UtilityEntryDraft) {
  const meterMode = field.entry_mode !== 'usage'
  const metered = field.kind === 'metered'
  const reading = metered && meterMode ? nonNegative(draft.meter_reading, `${field.label} meter reading`) : null
  let usage = metered && !meterMode ? nonNegative(draft.usage_amount, `${field.label} usage`) : null
  if (reading !== null && field.previous_meter_reading != null) {
    usage = reading.minus(field.previous_meter_reading)
    if (usage.isNegative()) throw new Error(`${field.label} meter reading cannot be below the previous reading.`)
  }
  const automatic = (draft.amount_source ?? utilityDraft(field).amount_source) === 'auto'
  const amount = automatic
    ? field.unit_rate == null ? null : field.tracking_mode === 'fixed' ? new Decimal(field.unit_rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP) : usage?.times(field.unit_rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP) ?? null
    : nonNegative(draft.amount, `${field.label} amount`)
  return { amount, usage, reading }
}

export function utilityEntryPayload(field: UtilityEntryFormField, draft: UtilityEntryDraft): UtilityEntryValue {
  const preview = utilityEntryPreview(field, draft)
  return {
    field_key: field.key,
    amount_source: draft.amount_source ?? utilityDraft(field).amount_source,
    amount: (draft.amount_source ?? utilityDraft(field).amount_source) === 'auto' ? null : preview.amount?.toNumber() ?? null,
    meter_reading: preview.reading?.toNumber() ?? null,
    usage_amount: field.entry_mode === 'usage' && field.kind === 'metered' ? preview.usage?.toNumber() ?? null : null,
  }
}
