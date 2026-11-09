import { useEffect, useId, useState } from 'react'
import { Calendar, Check, Coins, Gauge, Pencil, Save } from 'lucide-react'
import { Checkbox } from '../../components/ui/NativeControls'
import { FormSheet } from '../../components/ui/FormSheet'
import { OutlinedInput } from '../../components/ui/OutlinedField'
import { api } from '../../lib/api'
import { fmtMoney, currencySymbol, todayInputValue } from '../../lib/format'
import { useSession } from '../../lib/session'
import type { UtilityEntryForm } from '../../contracts/utilities'
import type { UtilitySubjectRef } from './queries'
import { utilityDraft, utilityEntryPayload, utilityEntryPreview, type UtilityEntryDraft } from './entryModel'

const currentMonth = () => todayInputValue().slice(0, 7)

export function UtilityValuesModal({ subject, subjectName, initialMonth, onClose, onSaved }: {
  subject: UtilitySubjectRef
  subjectName: string
  initialMonth?: string
  onClose: () => void
  onSaved: () => Promise<void> | void
}) {
  const fieldId = useId()
  const { token, currency, setError, setMessage } = useSession()
  const [busy, setBusy] = useState(false)
  const [entryMonth, setEntryMonth] = useState(() => initialMonth ?? currentMonth())
  const [entryForm, setEntryForm] = useState<UtilityEntryForm | null>(null)
  const [entryValues, setEntryValues] = useState<Record<string, UtilityEntryDraft>>({})
  const [completed, setCompleted] = useState(false)
  const [editing, setEditing] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [validationError, setValidationError] = useState<string | null>(null)
  const { type, id } = subject

  useEffect(() => {
    if (!token) return
    let cancelled = false
    setLoading(true)
    setValidationError(null)
    void (async () => {
      try {
        const nextForm = await api.getUtilityForm(token, {
          propertyId: type === 'property' ? id : undefined,
          groupId: type === 'contract' ? id : undefined,
          month: entryMonth,
        })
        if (cancelled) return
        setEntryForm(nextForm)
        setCompleted(nextForm.completed ?? false)
        setEditing({})
        setEntryValues(Object.fromEntries(nextForm.fields.map((field) => [field.key, utilityDraft(field)])))
      } catch (error) {
        if (!cancelled) {
          setEntryForm(null)
          setError(error instanceof Error ? error.message : 'Utilities load failed.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [entryMonth, setError, type, id, token])

  async function saveEntries() {
    if (!token || loading || !entryForm || busy) return
    setBusy(true)
    setValidationError(null)
    try {
      const entries = entryForm.fields.flatMap((field) => {
        const draft = entryValues[field.key] ?? utilityDraft(field)
        const original = utilityDraft(field)
        const changed = draft.amount_source !== original.amount_source || draft.amount !== original.amount || draft.meter_reading !== original.meter_reading || draft.usage_amount !== original.usage_amount
        return changed ? [utilityEntryPayload(field, draft)] : []
      })
      const target = { propertyId: type === 'property' ? id : undefined, groupId: type === 'contract' ? id : undefined }
      const reopenFirst = Boolean(entryForm.completed && completed && entries.length)
      await api.upsertUtilityEntries(token, { month: entryMonth, completed: reopenFirst ? false : completed, entries }, target)
      if (reopenFirst) {
        // The explicit reopen applies edits before the month can be completed again.
        setEntryForm({ ...entryForm, completed: false })
        await api.upsertUtilityEntries(token, { month: entryMonth, completed: true, entries: [] }, target)
      }
      await onSaved()
      onClose()
      setMessage('Utilities saved.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Utilities save failed.'
      setValidationError(message)
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <FormSheet className="quick-add-modal utilities-entry-modal" eyebrow={subjectName} title="Utility values" titleId="utility-values-title" onClose={onClose}>
      <form className="utility-values-form" onSubmit={(event) => { event.preventDefault(); void saveEntries() }}>
        <div className="utility-values-form__body">
          <OutlinedInput id={`${fieldId}-month`} label="Month" leadingIcon={<Calendar className="h-4 w-4" />} type="month" value={entryMonth} disabled={busy} onChange={(event) => setEntryMonth(event.target.value)} />
          <label className="utility-values-form__status"><Checkbox checked={completed} disabled={busy || loading || !entryForm} onChange={(event) => { setCompleted(event.target.checked); setEditing({}) }} />Completed</label>
          {completed ? <p className="muted">Manual values are locked. Untick Completed to edit them.</p> : null}
          {loading ? <p role="status">Loading utility values...</p> : null}
          {validationError ? <p role="alert">{validationError}</p> : null}
          <div className="utility-entry-grid">
            {(loading ? [] : entryForm?.fields ?? []).map((field) => {
              const draft = entryValues[field.key] ?? utilityDraft(field)
              const editable = !completed && Boolean(editing[field.key])
              const meterMode = field.entry_mode !== 'usage'
              const supportsAutomatic = field.tracking_mode === 'fixed' || (field.kind === 'metered' && field.unit_rate != null)
              const automatic = draft.amount_source === 'auto'
              let preview = null
              let previewError = null
              try { preview = utilityEntryPreview(field, draft) } catch (error) { previewError = error instanceof Error ? error.message : 'Invalid value.' }
              return (
                <div className="utility-entry-row" key={field.key}>
                  <div className="utility-entry-row__title">
                    <strong>{field.label}</strong>
                    <button
                      type="button"
                      className="record-add-close"
                      aria-label={`${editable ? 'Done editing' : 'Edit'} ${field.label}`}
                      title={`${editable ? 'Done editing' : 'Edit'} ${field.label}`}
                      disabled={busy || completed}
                      onClick={() => setEditing({ ...editing, [field.key]: !editable })}
                    >
                      {editable ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
                    </button>
                  </div>
                  {!editable ? <dl className="utility-entry-row__values">
                    {field.kind === 'metered' ? <div><dt>{meterMode ? 'Meter reading' : 'Usage'}</dt><dd>{(meterMode ? draft.meter_reading : draft.usage_amount) || 'Not yet known'} {(meterMode ? draft.meter_reading : draft.usage_amount) ? field.unit : ''}</dd></div> : null}
                    {field.kind === 'metered' && meterMode ? <div><dt>Usage</dt><dd>{preview?.usage != null ? `${preview.usage.toString()} ${field.unit}` : 'Not yet known'}</dd></div> : null}
                    <div><dt>Amount</dt><dd>{preview?.amount != null ? fmtMoney(preview.amount.toNumber(), currency) : 'Not yet known'}</dd></div>
                  </dl> : <>
                  {supportsAutomatic ? <label><Checkbox checked={automatic} disabled={busy} onChange={(event) => setEntryValues({ ...entryValues, [field.key]: { ...draft, amount_source: event.target.checked ? 'auto' : 'actual' } })} />Calculate automatically from price history</label> : null}
                  {!automatic ? (
                    <OutlinedInput
                      id={`${fieldId}-${field.key}-amount`}
                      label={`${field.label} amount`}
                      leadingIcon={<Coins className="h-4 w-4" />}
                      trailing={currencySymbol(currency)}
                      hint={field.previous_amount != null ? `Last ${fmtMoney(field.previous_amount, currency)}` : field.unit}
                      aria-label={`${field.label} amount`}
                      inputMode="decimal"
                      placeholder="Amount"
                      value={draft.amount}
                      disabled={busy}
                      onChange={(event) => setEntryValues({ ...entryValues, [field.key]: { ...draft, amount: event.target.value } })}
                    />
                  ) : null}
                  {field.kind === 'metered' ? (
                    <OutlinedInput
                      id={`${fieldId}-${field.key}-measurement`}
                      label={`${field.label} ${meterMode ? 'meter reading' : 'usage amount'}`}
                      leadingIcon={<Gauge className="h-4 w-4" />}
                      hint={meterMode ? field.previous_meter_reading != null ? `Previous reading: ${field.previous_meter_reading} ${field.unit}` : 'First reading establishes the baseline; usage needs a previous reading.' : field.unit}
                      aria-label={`${field.label} ${meterMode ? 'meter reading' : 'usage amount'}`}
                      inputMode="decimal"
                      placeholder={meterMode ? 'Meter' : 'Usage'}
                      value={meterMode ? draft.meter_reading : draft.usage_amount}
                      disabled={busy}
                      onChange={(event) => setEntryValues({ ...entryValues, [field.key]: { ...draft, [meterMode ? 'meter_reading' : 'usage_amount']: event.target.value } })}
                    />
                  ) : null}
                  </>}
                  {previewError ? <p role="alert">{previewError}</p> : editable && field.kind === 'metered' ? (
                    <p className="utility-entry-row__calculation">
                      Usage: {preview?.usage?.toString() ?? 'Not yet known'} {preview?.usage != null ? field.unit : ''}
                      {automatic ? ` · ${field.unit_rate} ${currencySymbol(currency)} / ${field.unit} · Charge: ${preview?.amount != null ? fmtMoney(preview.amount.toNumber(), currency) : 'Not yet known'}` : ''}
                    </p>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
        <footer className="utility-values-form__footer">
          <button className="button button--compact" disabled={busy || loading || !entryForm?.fields.length} type="submit">
            <Save className="h-4 w-4" /><span>{busy ? 'Saving...' : 'Save'}</span>
          </button>
        </footer>
      </form>
    </FormSheet>
  )
}
