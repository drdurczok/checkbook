import { Building2, Calendar, Pencil, StickyNote, Tag } from 'lucide-react'
import { Checkbox } from '../../components/ui/NativeControls'
import { OutlinedInput, OutlinedNativeSelect, OutlinedTextarea } from '../../components/ui/OutlinedField'
import type { TrackedField } from '../../contracts/utilities'
import type { UtilitySubjectDraft } from './utilitySubjectModel'

/** Kind, identity, dates, notes, and the tracked-field checklist shared by the
 * create and edit paths for utility subjects. */
export function UtilitySubjectFields({ fieldId, draft, setDraft, catalog, lockKind }: {
  fieldId: string
  draft: UtilitySubjectDraft
  setDraft: (next: UtilitySubjectDraft) => void
  catalog: TrackedField[]
  lockKind: boolean
}) {
  return (
    <>
      <div className="form-grid">
        <OutlinedNativeSelect id={`${fieldId}-kind`} label="Kind" leadingIcon={<Building2 aria-hidden="true" className="h-4 w-4" />} disabled={lockKind} value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as UtilitySubjectDraft['type'] })}>
          <option value="property">Property</option>
          <option value="contract">Contract</option>
        </OutlinedNativeSelect>
        <OutlinedInput id={`${fieldId}-name`} label="Name" leadingIcon={<Pencil aria-hidden="true" className="h-4 w-4" />} placeholder="Name" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        <OutlinedInput id={`${fieldId}-type`} label="Type" leadingIcon={<Tag aria-hidden="true" className="h-4 w-4" />} placeholder="Type" value={draft.group_type} onChange={(event) => setDraft({ ...draft, group_type: event.target.value })} />
        <div className="field-pair">
          <OutlinedInput id={`${fieldId}-start`} label="Start" leadingIcon={<Calendar aria-hidden="true" className="h-4 w-4" />} type="date" value={draft.started_on} onChange={(event) => setDraft({ ...draft, started_on: event.target.value })} />
          <OutlinedInput id={`${fieldId}-end`} label="End" leadingIcon={<Calendar aria-hidden="true" className="h-4 w-4" />} type="date" value={draft.ended_on} onChange={(event) => setDraft({ ...draft, ended_on: event.target.value })} />
        </div>
        <OutlinedTextarea id={`${fieldId}-notes`} label="Notes" className="quick-add-notes" leadingIcon={<StickyNote aria-hidden="true" className="h-4 w-4" />} placeholder="Notes" value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
      </div>
      {!lockKind ? <fieldset className="utility-field-checklist"><legend>Tracked utilities</legend>
        {catalog.filter((field) => !field.retired).map((field) => (
          <label className="checkbox" key={field.key}>
            <Checkbox
              checked={draft.tracked_fields.includes(field.key)}
              onChange={(event) => setDraft({
                ...draft,
                tracked_fields: event.target.checked
                  ? [...draft.tracked_fields, field.key]
                  : draft.tracked_fields.filter((key) => key !== field.key),
              })}
            />
            <span>{field.label}</span>
          </label>
        ))}
      </fieldset> : <p className="property-item-note">Manage linked utilities in Configuration.</p> }
    </>
  )
}
