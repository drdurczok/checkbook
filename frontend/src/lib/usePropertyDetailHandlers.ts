import type { Dispatch, SetStateAction } from 'react'
import { api } from './api'
import type { AssetSummary, PropertyValuation, TrackedField } from '../types'

type Options = {
  token: string | null
  selectedProperty: AssetSummary | null
  setError: Dispatch<SetStateAction<string | null>>
  /** Called after a project link/unlink succeeds, so the caller's own
   * records list stays in sync. */
  onRecordUpdated: (updated: AssetSummary) => void
  /** Called after a utility field is tracked/untracked, for callers that
   * keep their own derived state (e.g. a per-property utility count). */
  onUtilityFieldsChanged?: (tracked: TrackedField[]) => void
}

/** The full set of async handlers PropertyDetailModal needs — value
 * history, project linking, utility field tracking — wired against
 * whichever property is currently selected. Shared by every page that
 * opens PropertyDetailModal (Properties, Projects/Assets, Overview) so a
 * fix or new capability lands in one place instead of three. */
export function usePropertyDetailHandlers({
  token,
  selectedProperty,
  setError,
  onRecordUpdated,
  onUtilityFieldsChanged,
}: Options) {
  async function listValuations(): Promise<PropertyValuation[]> {
    if (!token || !selectedProperty) {
      return []
    }
    try {
      return await api.getPropertyValuations(token, selectedProperty.id)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not load value history.')
      return []
    }
  }

  async function addValuation(value: number, effective_date: string): Promise<PropertyValuation | null> {
    if (!token || !selectedProperty) {
      return null
    }
    try {
      return await api.createPropertyValuation(token, selectedProperty.id, { value, effective_date })
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not add value.')
      return null
    }
  }

  async function removeValuation(valuationId: string): Promise<boolean> {
    if (!token || !selectedProperty) {
      return false
    }
    try {
      await api.deletePropertyValuation(token, selectedProperty.id, valuationId)
      return true
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not remove value.')
      return false
    }
  }

  async function setProjectLink(project: AssetSummary, linkedAssetId: string | null): Promise<AssetSummary | null> {
    if (!token) {
      return null
    }
    const details: Record<string, unknown> = { ...(project.details ?? {}) }
    if (linkedAssetId) {
      details.linked_asset_id = linkedAssetId
    } else {
      delete details.linked_asset_id
      delete details.linked_section_path
    }
    try {
      const updated = await api.updateAsset(token, project.id, {
        name: project.name,
        total_cost: project.total_cost,
        valuation_date: project.valuation_date,
        status: project.status ?? 'planned',
        started_on: project.started_on ?? null,
        ended_on: project.ended_on ?? null,
        notes: project.notes ?? '',
        details,
      })
      onRecordUpdated(updated)
      return updated
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not update project link.')
      return null
    }
  }

  async function linkProject(project: AssetSummary): Promise<AssetSummary | null> {
    if (!selectedProperty) {
      return null
    }
    return setProjectLink(project, selectedProperty.id)
  }

  async function unlinkProject(project: AssetSummary): Promise<AssetSummary | null> {
    return setProjectLink(project, null)
  }

  async function listUtilityFields(): Promise<{ catalog: TrackedField[]; tracked: TrackedField[] }> {
    if (!token || !selectedProperty) {
      return { catalog: [], tracked: [] }
    }
    try {
      const [catalog, board] = await Promise.all([
        api.getUtilityFieldCatalog(token),
        api.getUtilityBoard(token, { propertyId: selectedProperty.id, months: 1 }),
      ])
      return { catalog, tracked: board.subject.tracked_fields }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not load utilities.')
      return { catalog: [], tracked: [] }
    }
  }

  async function trackUtilityField(fieldKey: string): Promise<TrackedField[] | null> {
    if (!token || !selectedProperty) {
      return null
    }
    try {
      const board = await api.trackUtilityField(token, selectedProperty.id, fieldKey)
      onUtilityFieldsChanged?.(board.subject.tracked_fields)
      return board.subject.tracked_fields
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not link utility.')
      return null
    }
  }

  async function untrackUtilityField(fieldKey: string): Promise<TrackedField[] | null> {
    if (!token || !selectedProperty) {
      return null
    }
    try {
      const board = await api.untrackUtilityField(token, selectedProperty.id, fieldKey)
      onUtilityFieldsChanged?.(board.subject.tracked_fields)
      return board.subject.tracked_fields
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not unlink utility.')
      return null
    }
  }

  return {
    listValuations,
    addValuation,
    removeValuation,
    linkProject,
    unlinkProject,
    listUtilityFields,
    trackUtilityField,
    untrackUtilityField,
  }
}
