import { api } from '../../lib/api'
import { todayInputValue } from '../../lib/format'
import type { AssetSummary } from '../../types'
import type { EntryGroup, TrackedField } from '../../contracts/utilities'
import type { UtilitySubjectRef } from './queries'

export type UtilitySubjectType = 'property' | 'contract'

export type UtilitySubjectDraft = {
  type: UtilitySubjectType
  name: string
  group_type: string
  started_on: string
  ended_on: string
  notes: string
  tracked_fields: string[]
}

export type UtilitySubjectEditing =
  | { type: 'property'; record: AssetSummary }
  | { type: 'contract'; record: EntryGroup }
  | null

export const emptyUtilitySubjectDraft = (type: UtilitySubjectType = 'property'): UtilitySubjectDraft => ({
  type,
  name: '',
  group_type: type === 'property' ? 'flat' : '',
  started_on: '',
  ended_on: '',
  notes: '',
  tracked_fields: ['rent', 'electricity', 'internet'],
})

export const draftFromProperty = (record: AssetSummary): UtilitySubjectDraft => {
  const utilities = record.details?.utilities as { group_type?: string; tracked_fields?: Array<{ key: string }> } | undefined
  return {
    type: 'property',
    name: record.name,
    group_type: utilities?.group_type ?? '',
    started_on: record.started_on || '',
    ended_on: record.ended_on || '',
    notes: record.notes || '',
    tracked_fields: utilities?.tracked_fields?.map((field) => field.key) ?? [],
  }
}

export const draftFromContract = (record: EntryGroup): UtilitySubjectDraft => ({
  type: 'contract',
  name: record.name,
  group_type: record.group_type || '',
  started_on: record.started_on || '',
  ended_on: record.ended_on || '',
  notes: record.notes || '',
  tracked_fields: record.tracked_fields.map((field) => field.key),
})

/** Persists a utility subject draft: properties are assets carrying their
 * utilities details, contracts are household groups. Returns the saved
 * subject reference, or null when the draft has no name to save under. */
export async function saveUtilitySubject({ token, draft, catalog, editing, contractCount }: {
  token: string
  draft: UtilitySubjectDraft
  catalog: TrackedField[]
  editing: UtilitySubjectEditing
  contractCount: number
}): Promise<UtilitySubjectRef | null> {
  if (!draft.name.trim()) {
    return null
  }
  const fields = catalog.filter((field) => draft.tracked_fields.includes(field.key))
  let ref: UtilitySubjectRef
  if (draft.type === 'property') {
    const utilities = { group_type: draft.group_type, tracked_fields: fields }
    if (editing?.type === 'property') {
      const record = editing.record
      const details = { ...(record.details ?? {}), kind: 'asset', utilities }
      await api.updateAsset(token, record.id, {
        name: draft.name,
        total_cost: record.total_cost,
        valuation_date: record.valuation_date,
        status: record.status ?? 'completed',
        started_on: draft.started_on || null,
        ended_on: draft.ended_on || null,
        notes: draft.notes,
        details,
      })
      ref = { type: 'property', id: record.id }
    } else {
      const created = await api.createAsset(token, {
        name: draft.name,
        total_cost: 0,
        valuation_date: todayInputValue(),
        kind: 'asset',
        category: 'property',
        started_on: draft.started_on || null,
        ended_on: draft.ended_on || null,
        notes: draft.notes,
        details: { utilities },
      })
      ref = { type: 'property', id: created.id }
    }
  } else {
    const payload = {
      kind: 'contract' as const,
      name: draft.name,
      group_type: draft.group_type,
      started_on: draft.started_on || null,
      ended_on: draft.ended_on || null,
      notes: draft.notes,
      metadata_payload: {},
      tracked_fields: fields,
      sort_order: contractCount,
    }
    if (editing?.type === 'contract') {
      const updated = await api.updateGroup(token, editing.record.id, { ...payload, sort_order: editing.record.sort_order })
      ref = { type: 'contract', id: updated.id }
    } else {
      const created = await api.createGroup(token, payload)
      ref = { type: 'contract', id: created.id }
    }
  }
  return ref
}
