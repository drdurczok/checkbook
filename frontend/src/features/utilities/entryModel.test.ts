import { describe, expect, it } from 'vitest'
import type { UtilityEntryFormField } from '../../contracts/utilities'
import { utilityDraft, utilityEntryPayload, utilityEntryPreview } from './entryModel'

const field: UtilityEntryFormField = { key: 'water', label: 'Water', kind: 'metered', unit: 'm3', entry_mode: 'meter', unit_rate: 0.15, previous_meter_reading: 100 }

describe('utility entry calculations', () => {
  it('subtracts readings and rounds decimal charges half-up', () => {
    const preview = utilityEntryPreview(field, { amount: '', meter_reading: '100.1', usage_amount: '' })
    expect(preview.usage?.toString()).toBe('0.1')
    expect(preview.amount?.toString()).toBe('0.02')
    expect(utilityEntryPayload(field, { amount: '999', meter_reading: '100.1', usage_amount: '' })).toEqual({ field_key: 'water', amount_source: 'auto', amount: null, meter_reading: 100.1, usage_amount: null })
  })
  it('keeps a first reading as an unknown usage baseline', () => {
    const preview = utilityEntryPreview({ ...field, previous_meter_reading: null }, { amount: '', meter_reading: '20', usage_amount: '' })
    expect(preview.usage).toBeNull()
    expect(preview.amount).toBeNull()
  })
  it('accepts usage directly without subtracting a prior reading', () => {
    expect(utilityEntryPayload({ ...field, entry_mode: 'usage' }, { amount: '', meter_reading: '999', usage_amount: '0' })).toEqual({ field_key: 'water', amount_source: 'auto', amount: null, meter_reading: null, usage_amount: 0 })
  })
  it('keeps legacy manual charges and restores direct usage drafts', () => {
    const legacy = { ...field, unit_rate: null, usage_amount: 2 }
    expect(utilityDraft(legacy).usage_amount).toBe('2')
    expect(utilityEntryPayload(legacy, { amount: '12.34', meter_reading: '110', usage_amount: '' }).amount).toBe(12.34)
  })
  it('preserves actual bill overrides when measurements or rates change', () => {
    const actual = { ...field, amount: 42.17, amount_source: 'actual' as const }
    const draft = { ...utilityDraft(actual), meter_reading: '200' }
    expect(utilityEntryPreview(actual, draft).amount?.toString()).toBe('42.17')
    expect(utilityEntryPayload(actual, draft)).toMatchObject({ amount: 42.17, amount_source: 'actual', meter_reading: 200 })
    expect(utilityEntryPayload(actual, { ...draft, amount_source: 'auto' })).toMatchObject({ amount: null, amount_source: 'auto' })
  })
  it('previews fixed monthly prices without requiring usage', () => {
    const fixed: UtilityEntryFormField = { key: 'rent', label: 'Rent', kind: 'cost', unit: '', tracking_mode: 'fixed', unit_rate: 1500, amount_source: 'auto' }
    expect(utilityEntryPreview(fixed, utilityDraft(fixed)).amount?.toString()).toBe('1500')
  })
  it('rejects decreasing, non-finite, negative and malformed input', () => {
    for (const value of ['99', 'Infinity', 'NaN', '-1', 'wrong', '100.12345']) {
      expect(() => utilityEntryPreview(field, { amount: '', meter_reading: value, usage_amount: '' })).toThrow()
    }
  })
  it('preserves empty entries rather than introducing zero readings', () => {
    expect(utilityEntryPayload(field, utilityDraft(field))).toEqual({ field_key: 'water', amount_source: 'auto', amount: null, meter_reading: null, usage_amount: null })
  })
})
