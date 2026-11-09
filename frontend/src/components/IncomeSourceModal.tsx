import { DetailActionsMenu } from './DetailActionsMenu'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { OutlinedInput, OutlinedNativeSelect, OutlinedTextarea } from './ui/OutlinedField'
import { Briefcase, Calendar, Coins, Folder, List, Pencil, Plus, Repeat, Save, StickyNote, Table2, Trash2, Users, X } from 'lucide-react'
import { Modal } from './Modal'
import { InvoiceLedger } from './InvoiceLedger'
import { fmtMoney, currencySymbol, formatAmountDraft, parseAmountDraft } from '../lib/format'
import { FREQUENCY_OPTIONS, SOURCE_TYPE_OPTIONS, annualiseLine, sourceOrg } from '../lib/income'
import { incomeDateInRange, type IncomeDateRange } from '../features/income/model'
import { PayslipComposer, PayslipList, PayslipTable, SimpleLedger, SourceTypeIcon, sortedEntries } from '../features/income/IncomeEntryEditors'
import type { PayslipComposerStatus } from '../features/income/IncomeEntryEditors'
import type {
  IncomeCustomField,
  IncomeFrequency,
  IncomeLine,
  IncomeMilestone,
  IncomeSource,
  IncomeSourceEntry,
  IncomeSourceEntryPayload,
  IncomeSourcePayload,
  OwnershipScope,
} from '../types'

type Form = {
  name: string
  source_type: string
  owner_scope: OwnershipScope
  started_on: string
  ended_on: string
  notes: string
  lines: IncomeLine[]
  fields: IncomeCustomField[]
  milestones: IncomeMilestone[]
}


const emptyLine = (): IncomeLine => ({
  label: 'New line',
  amount: 0,
  frequency: 'monthly',
  owner_scope: null,
  category: '',
  started_on: null,
  ended_on: null,
  notes: '',
  fields: [],
})


const formFromSource = (source: IncomeSource): Form => ({
  name: source.name,
  source_type: source.source_type,
  owner_scope: source.owner_scope,
  started_on: source.started_on ?? '',
  ended_on: source.ended_on ?? '',
  notes: source.notes ?? '',
  lines: source.lines.map((line) => ({ ...line, fields: [...(line.fields ?? [])] })),
  fields: [...(source.fields ?? [])],
  milestones: [...(source.milestones ?? [])],
})


function CustomFields({ fields, onChange }: { fields: IncomeCustomField[]; onChange: (next: IncomeCustomField[]) => void }) {
  const fieldId = useId()
  return (
    <div className="income-custom-fields">
      {fields.map((field, index) => (
        <div className="income-custom-field" key={index}>
          <OutlinedInput
            id={`${fieldId}-field-label-${index}`}
            label="Field label"
            placeholder="Label (e.g. ZUS, Tax)"
            value={field.label}
            onChange={(event) => onChange(fields.map((item, i) => (i === index ? { ...item, label: event.target.value } : item)))}
          />
          <OutlinedInput
            id={`${fieldId}-field-value-${index}`}
            label="Field value"
            placeholder="Value"
            value={field.value}
            onChange={(event) => onChange(fields.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)))}
          />
          <button aria-label="Remove field" className="icon-button" onClick={() => onChange(fields.filter((_, i) => i !== index))} type="button">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button className="button button--compact button--ghost" onClick={() => onChange([...fields, { label: '', value: '' }])} type="button">
        <Plus className="h-3.5 w-3.5" /> Field
      </button>
    </div>
  )
}

function MilestonesEditor({ milestones, onChange }: { milestones: IncomeMilestone[]; onChange: (next: IncomeMilestone[]) => void }) {
  const fieldId = useId()
  return (
    <div className="income-custom-fields">
      {milestones.map((milestone, index) => (
        <div className="income-custom-field" key={index}>
          <OutlinedInput
            id={`${fieldId}-milestone-label-${index}`}
            label="Milestone"
            placeholder="Raise to 96,000, Promoted to Senior…"
            value={milestone.label}
            onChange={(event) => onChange(milestones.map((item, i) => (i === index ? { ...item, label: event.target.value } : item)))}
          />
          <OutlinedInput
            id={`${fieldId}-milestone-date-${index}`}
            label="When"
            placeholder="Jan 2025"
            value={milestone.date}
            onChange={(event) => onChange(milestones.map((item, i) => (i === index ? { ...item, date: event.target.value } : item)))}
          />
          <button aria-label="Remove milestone" className="icon-button" onClick={() => onChange(milestones.filter((_, i) => i !== index))} type="button">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button className="button button--compact button--ghost" onClick={() => onChange([...milestones, { label: '', date: '' }])} type="button">
        <Plus className="h-3.5 w-3.5" /> Milestone
      </button>
    </div>
  )
}

function DetailsEditor({
  form,
  currency,
  onChange,
}: {
  form: Form
  currency: string
  onChange: (next: Form) => void
}) {
  const fieldId = useId()
  // Amount lines are stored as numbers, but the box edits a text draft. The
  // in-flight draft is kept per line so a trailing decimal point survives
  // until blur; otherwise `Number("12.")` would snap the box to "12".
  const [amountDrafts, setAmountDrafts] = useState<Record<number, string>>({})

  const updateLine = (index: number, patch: Partial<IncomeLine>) =>
    onChange({ ...form, lines: form.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)) })
  const annualTotal = form.lines.reduce((sum, line) => sum + annualiseLine(line), 0)

  return (
    <div className="income-source-edit">
      <div className="form-grid">
        <OutlinedInput
          id={`${fieldId}-form-name`}
          label="Name"
          leadingIcon={<Pencil />}
          placeholder="Name" value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} />
        <OutlinedNativeSelect
          id={`${fieldId}-form-source_type`}
          label="Type"
          leadingIcon={<Briefcase />}
          value={form.source_type} onChange={(event) => onChange({ ...form, source_type: event.target.value })}>
          {SOURCE_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </OutlinedNativeSelect>
        <div className="field-pair">
          <OutlinedInput
            id={`${fieldId}-form-started_on`}
            label="From"
            leadingIcon={<Calendar />}
            type="date" value={form.started_on} onChange={(event) => onChange({ ...form, started_on: event.target.value })} />
          <OutlinedInput
            id={`${fieldId}-form-ended_on`}
            label="To"
            leadingIcon={<Calendar />}
            type="date" value={form.ended_on} onChange={(event) => onChange({ ...form, ended_on: event.target.value })} />
        </div>
        <OutlinedNativeSelect
          id={`${fieldId}-form-owner_scope`}
          label="Owner"
          leadingIcon={<Users />}
          value={form.owner_scope} onChange={(event) => onChange({ ...form, owner_scope: event.target.value as OwnershipScope })}>
          <option value="joint">Joint</option>
          <option value="self">Self</option>
          <option value="spouse">Spouse</option>
        </OutlinedNativeSelect>
        <OutlinedTextarea
          id={`${fieldId}-form-notes`}
          label="Notes"
          className="quick-add-notes"
          leadingIcon={<StickyNote />}
          placeholder="Notes" value={form.notes} onChange={(event) => onChange({ ...form, notes: event.target.value })} />
      </div>

      <section className="income-section">
        <div className="income-section__head">
          <span>Source details</span>
          <small>Tax id, ZUS, benefits</small>
        </div>
        <CustomFields fields={form.fields} onChange={(fields) => onChange({ ...form, fields })} />
      </section>

      <section className="income-section">
        <div className="income-section__head">
          <span>Milestones</span>
          <small>Raises, promotions — shown on the history timeline</small>
        </div>
        <MilestonesEditor milestones={form.milestones} onChange={(milestones) => onChange({ ...form, milestones })} />
      </section>

      <section className="income-section">
        <div className="income-section__head">
          <span>Expected lines</span>
          <strong className="income-section__total">{fmtMoney(annualTotal, currency)} / yr</strong>
        </div>
        <div className="income-lines">
          {form.lines.map((line, index) => (
            <div className="income-line" key={index}>
              <div className="income-line__top">
                <OutlinedInput
                  id={`${fieldId}-line-label-${index}`}
                  label="Line label"
                  className="income-line__label"
                  placeholder="Base salary, bonus, rent"
                  value={line.label}
                  onChange={(event) => updateLine(index, { label: event.target.value })}
                />
                <button aria-label="Remove line" className="icon-button" onClick={() => onChange({ ...form, lines: form.lines.filter((_, i) => i !== index) })} type="button">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="form-grid">
                <OutlinedInput
                  id={`${fieldId}-line-amount-${index}`}
                  label="Amount"
                  leadingIcon={<Coins />}
                  trailing={<span aria-hidden="true" className={`record-add-field-currency${line.amount ? '' : ' is-empty'}`}>{currencySymbol(currency)}</span>}
                  autoComplete="off"
                  inputMode="decimal"
                  placeholder="Amount"
                  value={amountDrafts[index] ?? formatAmountDraft(line.amount === null || line.amount === undefined ? '' : String(line.amount))}
                  onBlur={() => setAmountDrafts((current) => {
                    if (!(index in current)) {
                      return current
                    }
                    const next = { ...current }
                    delete next[index]
                    return next
                  })}
                  onChange={(event) => {
                    const draft = parseAmountDraft(event.target.value)
                    setAmountDrafts((current) => ({ ...current, [index]: draft }))
                    updateLine(index, { amount: Number(draft || 0) })
                  }}
                />
                <OutlinedNativeSelect
                  id={`${fieldId}-line-frequency-${index}`}
                  label="Frequency"
                  leadingIcon={<Repeat />}
                  value={line.frequency} onChange={(event) => updateLine(index, { frequency: event.target.value as IncomeFrequency })}>
                  {FREQUENCY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </OutlinedNativeSelect>
                <OutlinedNativeSelect
                  id={`${fieldId}-line-owner-${index}`}
                  label="Owner"
                  leadingIcon={<Users />}
                  value={line.owner_scope ?? ''} onChange={(event) => updateLine(index, { owner_scope: (event.target.value || null) as OwnershipScope | null })}>
                  <option value="">Inherit</option>
                  <option value="joint">Joint</option>
                  <option value="self">Self</option>
                  <option value="spouse">Spouse</option>
                </OutlinedNativeSelect>
                <OutlinedInput
                  id={`${fieldId}-line-category-${index}`}
                  label="Category"
                  leadingIcon={<Folder />}
                  placeholder="Category" value={line.category} onChange={(event) => updateLine(index, { category: event.target.value })} />
              </div>
            </div>
          ))}
          <button className="button button--ghost" onClick={() => onChange({ ...form, lines: [...form.lines, emptyLine()] })} type="button">
            <Plus className="h-4 w-4" /> Add line
          </button>
        </div>
      </section>
    </div>
  )
}

export function IncomeSourceModal({
  source,
  dateRange,
  currency,
  saving,
  entrySaving,
  deleting,
  onClose,
  onSave,
  onCreateEntry,
  onUpdateEntry,
  onDelete,
}: {
  source: IncomeSource
  dateRange?: IncomeDateRange
  currency: string
  saving: boolean
  entrySaving?: boolean
  deleting?: boolean
  onClose: () => void
  onSave: (payload: IncomeSourcePayload) => Promise<boolean>
  onCreateEntry: (sourceId: string, payload: IncomeSourceEntryPayload) => Promise<boolean>
  onUpdateEntry: (sourceId: string, entryId: string, payload: IncomeSourceEntryPayload) => Promise<boolean>
  onDelete?: () => Promise<void> | void
}) {
  const initialForm = useMemo(() => formFromSource(source), [source])
  const [form, setForm] = useState<Form>(() => initialForm)
  const [isEditing, setIsEditing] = useState(false)
  const [ledgerMode, setLedgerMode] = useState<'list' | 'table'>('list')
  const [composing, setComposing] = useState(false)
  const [editingEntry, setEditingEntry] = useState<IncomeSourceEntry | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const deleteCancelRef = useRef<HTMLButtonElement | null>(null)
  // The inline delete confirmation is an alert inside this dialog: focus the
  // safe action when it appears so keyboard users land on Cancel first.
  useEffect(() => {
    if (confirmDelete) {
      deleteCancelRef.current?.focus()
    }
  }, [confirmDelete])
  const payslipSubmitRef = useRef<(() => void) | null>(null)
  const [payslipStatus, setPayslipStatus] = useState<PayslipComposerStatus>({ canSave: false, net: 0 })
  const composerOpen = composing || Boolean(editingEntry)
  const hasFormChanges = JSON.stringify(form) !== JSON.stringify(initialForm)
  const returnToLedger = () => {
    if (isEditing) setForm(initialForm)
    setIsEditing(false)
    setComposing(false)
    setEditingEntry(null)
    setConfirmDelete(false)
  }
  const savePayslip = (payload: IncomeSourceEntryPayload) =>
    editingEntry ? onUpdateEntry(source.id, editingEntry.id, payload) : onCreateEntry(source.id, payload)
  const ledgerSource = dateRange ? { ...source, entries: (source.entries ?? []).filter((entry) => incomeDateInRange(entry.entry_date, dateRange)) } : source
  const entries = sortedEntries(ledgerSource.entries ?? [])
  const isEmployment = source.source_type === 'employment'
  const isBusiness = source.source_type === 'business'

  async function save() {
    const payload: IncomeSourcePayload = {
      name: form.name,
      source_type: form.source_type,
      owner_scope: form.owner_scope,
      started_on: form.started_on || null,
      ended_on: form.ended_on || null,
      notes: form.notes,
      sort_order: source.sort_order,
      fields: form.fields.filter((field) => field.label.trim() || field.value.trim()),
      milestones: form.milestones.filter((milestone) => milestone.label.trim() || milestone.date.trim()),
      lines: form.lines.map((line) => ({
        ...line,
        amount: Number(line.amount) || 0,
        started_on: line.started_on || null,
        ended_on: line.ended_on || null,
        owner_scope: line.owner_scope || null,
        fields: line.fields.filter((field) => field.label.trim() || field.value.trim()),
      })),
    }
    const saved = await onSave(payload)
    if (saved) {
      setForm({
        name: payload.name,
        source_type: payload.source_type,
        owner_scope: payload.owner_scope,
        started_on: payload.started_on ?? '',
        ended_on: payload.ended_on ?? '',
        notes: payload.notes,
        lines: payload.lines,
        fields: payload.fields,
        milestones: payload.milestones,
      })
      setIsEditing(false)
    }
  }

  const editButton = isEditing ? (
    <button aria-label="Back to ledger" className="income-edit-toggle is-active" onClick={returnToLedger} title="Back to ledger" type="button"><Pencil className="h-4 w-4" /></button>
  ) : (
    <DetailActionsMenu label="Income source actions" actions={[{ label: 'Edit source details', onClick: () => setIsEditing(true) }]} />
  )

  const modalFooter = composerOpen ? (
    <footer className="income-modal-footer">
      <span className="income-modal-footer__net">Net payable <strong>{fmtMoney(payslipStatus.net, currency)}</strong></span>
      <button className="button button--compact button--ghost" onClick={returnToLedger} type="button">
        Cancel
      </button>
      <button className="button button--compact" disabled={Boolean(entrySaving) || !payslipStatus.canSave} onClick={() => payslipSubmitRef.current?.()} type="button">
        <Save className="h-4 w-4" /> {entrySaving ? 'Saving...' : editingEntry ? 'Update payslip' : 'Save payslip'}
      </button>
    </footer>
  ) : isEditing ? (
    <footer className="income-modal-footer">
      {onDelete ? (
        <div className="income-modal-footer__delete">
          {confirmDelete ? (
            <div className="income-delete-confirm" role="alert" aria-label="Confirm delete">
              <div>
                <strong>Delete this income source?</strong>
                <small>Logged paychecks stay but become unassigned.</small>
              </div>
              <button ref={deleteCancelRef} className="button button--compact button--ghost" disabled={deleting} onClick={() => setConfirmDelete(false)} type="button">Cancel</button>
              <button className="button button--compact button--danger" disabled={deleting} onClick={() => void onDelete()} type="button">
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          ) : (
            <button className="income-delete-trigger" onClick={() => setConfirmDelete(true)} type="button">
              <Trash2 className="h-4 w-4" /> Delete income source
            </button>
          )}
        </div>
      ) : null}
      <button className="button button--compact button--ghost" onClick={returnToLedger} type="button">
        Cancel
      </button>
      {hasFormChanges ? (
        <button className="button button--compact" disabled={saving} onClick={() => void save()} type="button">
          <Save className="h-4 w-4" /> {saving ? 'Saving...' : 'Save changes'}
        </button>
      ) : null}
    </footer>
  ) : undefined

  return (
    <Modal
      className={`income-source-modal income-source-modal--designed${!isEditing && !composerOpen ? ' income-source-modal--wide' : ''}`}
      title={
        <span className="income-source-title">
          <span className={`income-source-title__icon income-source-title__icon--${source.source_type}`}>
            <SourceTypeIcon type={source.source_type} className="h-5 w-5" />
          </span>
          <span>
            <strong>{sourceOrg(source)}</strong>
            {sourceOrg(source) !== source.name ? (
              <span className="income-source-title__meta">
                <small>{source.name}</small>
              </span>
            ) : null}
          </span>
        </span>
      }
      titleId="income-source-title"
      onClose={onClose}
      footer={modalFooter}
    >
      <div className="income-source-body">
        {isEditing ? (
          <DetailsEditor form={form} currency={currency} onChange={setForm} />
        ) : composerOpen ? (
          <PayslipComposer key={editingEntry?.id ?? 'new'} source={source} entry={editingEntry} onCancel={returnToLedger} onSave={savePayslip} submitRef={payslipSubmitRef} onStatusChange={setPayslipStatus} />
        ) : isEmployment ? (
          <section className="income-ledger-panel">
            <div className="income-ledger-panel__head">
              <div className="income-ledger-panel__lead">
                <div className="segmented-control">
                  <button className={ledgerMode === 'list' ? 'is-active' : ''} onClick={() => setLedgerMode('list')} type="button"><List className="h-4 w-4" /> List</button>
                  <button className={ledgerMode === 'table' ? 'is-active' : ''} onClick={() => setLedgerMode('table')} type="button"><Table2 className="h-4 w-4" /> Table</button>
                </div>
              </div>
              <div className="income-ledger-panel__actions">
                <button className="button button--compact" onClick={() => setComposing(true)} type="button">
                  <Plus className="h-4 w-4" /> New payslip
                </button>
                {editButton}
              </div>
            </div>
            {ledgerMode === 'table' ? <PayslipTable entries={entries} currency={currency} /> : <PayslipList entries={entries} currency={currency} onEdit={setEditingEntry} />}
          </section>
        ) : isBusiness ? (
          <section className="income-ledger-panel">
            <div className="income-ledger-panel__head">
              <div className="income-ledger-panel__lead">
                <strong>Invoices</strong>
              </div>
              <div className="income-ledger-panel__actions">{editButton}</div>
            </div>
            <InvoiceLedger source={source} currency={currency} dateRange={dateRange} />
          </section>
        ) : (
          <section className="income-ledger-panel">
            <div className="income-ledger-panel__head">
              <div className="income-ledger-panel__lead">
                <strong>{entries.length} {entries.length === 1 ? 'paycheck' : 'paychecks'}</strong>
              </div>
              <div className="income-ledger-panel__actions">{editButton}</div>
            </div>
            <SimpleLedger source={ledgerSource} currency={currency} saving={Boolean(entrySaving)} onCreateEntry={onCreateEntry} />
          </section>
        )}
      </div>
    </Modal>
  )
}
