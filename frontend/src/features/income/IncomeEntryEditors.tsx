/* eslint-disable react-refresh/only-export-components */
import { useEffect, useId, useMemo, useState } from 'react'
import type { MutableRefObject } from 'react'
import { Banknote, Briefcase, Building2, ChevronDown, Landmark, LineChart, Pencil, Plus, Zap } from 'lucide-react'
import { OutlinedInput } from '../../components/ui/OutlinedField'
import { fmtDate, fmtMoney, todayInputValue } from '../../lib/format'
import type { IncomeSource, IncomeSourceEntry, IncomeSourceEntryPayload } from '../../contracts/income'

export type PayslipGroup = 'earn' | 'contrib' | 'adjust'

export type PayslipKey =
  | 'basePay'
  | 'taxableAdditions'
  | 'taxableDeductions'
  | 'socialInsurance'
  | 'healthInsurance'
  | 'ppkContribution'
  | 'taxAdvance'
  | 'nonTaxableAdditions'
  | 'nonTaxableDeductions'

export type PayslipTotalKey = 'grossPay' | 'netPayable'

export type PayslipForm = Record<PayslipKey | PayslipTotalKey, string> & { entry_date: string; period: string; notes: string }

export const PAYSLIP_FIELDS: Array<{ key: PayslipKey; label: string; polish: string; group: PayslipGroup; sign: 1 | -1 }> = [
  { key: 'basePay', label: 'Base pay', polish: 'Wynagrodzenie zasadnicze', group: 'earn', sign: 1 },
  { key: 'taxableAdditions', label: 'Taxable additions', polish: 'Opodatkowane dodatki', group: 'earn', sign: 1 },
  { key: 'taxableDeductions', label: 'Taxable deductions', polish: 'Opodatkowane potracenia', group: 'earn', sign: -1 },
  { key: 'socialInsurance', label: 'Social insurance (ZUS)', polish: 'Skladka na ubezp. spoleczne', group: 'contrib', sign: -1 },
  { key: 'healthInsurance', label: 'Health insurance', polish: 'Skladka na ubezp. zdrowotne', group: 'contrib', sign: -1 },
  { key: 'ppkContribution', label: 'PPK contribution', polish: 'Skladka na PPK', group: 'contrib', sign: -1 },
  { key: 'taxAdvance', label: 'Income tax advance', polish: 'Pobrana zaliczka podatku', group: 'contrib', sign: -1 },
  { key: 'nonTaxableAdditions', label: 'Non-taxable additions', polish: 'Nieopodatkowane dodatki', group: 'adjust', sign: 1 },
  { key: 'nonTaxableDeductions', label: 'Non-taxable deductions', polish: 'Nieopodatkowane potracenia', group: 'adjust', sign: -1 },
]

export const GROSS_FIELD = { key: 'grossPay' as const, label: 'Gross pay', polish: 'Wynagrodzenie brutto' }
export const NET_FIELD = { key: 'netPayable' as const, label: 'Net payable', polish: 'Kwota do wyplaty' }
export const groupFields = (group: PayslipGroup) => PAYSLIP_FIELDS.filter((field) => field.group === group)
export const GROUP_TITLES: Record<PayslipGroup, string> = { earn: 'Earnings', contrib: 'Contributions & tax', adjust: 'Adjustments' }

export const emptyPayslipForm = (): PayslipForm => ({
  entry_date: todayInputValue(),
  period: '',
  basePay: '',
  taxableAdditions: '',
  taxableDeductions: '',
  grossPay: '',
  socialInsurance: '',
  healthInsurance: '',
  ppkContribution: '',
  taxAdvance: '',
  nonTaxableAdditions: '',
  nonTaxableDeductions: '',
  netPayable: '',
  notes: '',
})

export const periodLabel = (value?: string | null) => {
  if (!value) return 'Payslip'
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return 'Payslip'
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

export const moneyNumber = (value: string | number | undefined | null) => {
  const amount = Number(String(value ?? '').replace(',', '.'))
  return Number.isFinite(amount) ? amount : 0
}

export function SourceTypeIcon({ type, className }: { type: string; className?: string }) {
  if (type === 'business') {
    return <Building2 className={className} aria-hidden="true" />
  }
  if (type === 'rental') {
    return <Landmark className={className} aria-hidden="true" />
  }
  if (type === 'investment') {
    return <LineChart className={className} aria-hidden="true" />
  }
  if (type === 'benefit') {
    return <Zap className={className} aria-hidden="true" />
  }
  return <Briefcase className={className} aria-hidden="true" />
}

export const getPayslip = (entry: IncomeSourceEntry) => {
  const payload = entry.extra_payload
  const payslip = payload?.payslip
  return payslip && typeof payslip === 'object' ? payslip as Record<string, unknown> : null
}

export const payslipValue = (entry: IncomeSourceEntry, key: PayslipKey | PayslipTotalKey) => moneyNumber(getPayslip(entry)?.[key] as string | number | undefined)
export const entryGross = (entry: IncomeSourceEntry) => payslipValue(entry, 'grossPay')
export const entryNet = (entry: IncomeSourceEntry) => (getPayslip(entry) ? payslipValue(entry, 'netPayable') : entry.amount)

export const sortedEntries = (entries: IncomeSourceEntry[]) =>
  [...entries].sort((left, right) => String(right.entry_date ?? '').localeCompare(String(left.entry_date ?? '')))

export function PayslipField({ field, value, onChange }: { field: { key: PayslipKey; label: string; polish: string; sign: 1 | -1 }; value: string; onChange: (next: string) => void }) {
  const id = useId()
  const negative = field.sign < 0
  return (
    <OutlinedInput
      id={`${id}-${field.key}`}
      label={field.label}
      hint={`Polish: ${field.polish}`}
      leadingIcon={negative ? '−' : '+'}
      type="number"
      step="0.01"
      inputMode="decimal"
      placeholder="0"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export function PayslipTotalRow({ label, polish, value, auto, computed, accent, onValue, onAuto }: {
  label: string
  polish: string
  value: string
  auto: boolean
  computed: number
  accent?: boolean
  onValue: (next: string) => void
  onAuto: () => void
}) {
  const id = useId()
  return (
    <div className={`income-payslip-total${accent ? ' income-payslip-total--accent' : ''}`}>
      <button className={`income-payslip-total__toggle${auto ? ' is-auto' : ''}`} onClick={onAuto} title="Recalculate automatically" type="button">{auto ? 'AUTO' : 'manual'}</button>
      <OutlinedInput
        id={`${id}-total`}
        label={label}
        hint={`Polish: ${polish}`}
        className="income-payslip-total__grow"
        type="number"
        step="0.01"
        inputMode="decimal"
        value={auto ? computed.toFixed(2) : value}
        onChange={(event) => onValue(event.target.value)}
      />
    </div>
  )
}

export const payslipFormFromEntry = (entry: IncomeSourceEntry): PayslipForm => {
  const payslip: Record<string, unknown> = getPayslip(entry) ?? {}
  const numStr = (key: string) => {
    const raw = payslip[key]
    return raw === undefined || raw === null || raw === '' || Number(raw) === 0 ? '' : String(raw)
  }
  return {
    entry_date: entry.entry_date ?? todayInputValue(),
    period: typeof payslip.period === 'string' ? payslip.period : '',
    basePay: numStr('basePay'),
    taxableAdditions: numStr('taxableAdditions'),
    taxableDeductions: numStr('taxableDeductions'),
    grossPay: numStr('grossPay'),
    socialInsurance: numStr('socialInsurance'),
    healthInsurance: numStr('healthInsurance'),
    ppkContribution: numStr('ppkContribution'),
    taxAdvance: numStr('taxAdvance'),
    nonTaxableAdditions: numStr('nonTaxableAdditions'),
    nonTaxableDeductions: numStr('nonTaxableDeductions'),
    netPayable: numStr('netPayable'),
    notes: entry.notes ?? '',
  }
}

export type PayslipComposerStatus = { canSave: boolean; net: number }

export function PayslipComposer({
  source,
  entry,
  onCancel,
  onSave,
  submitRef,
  onStatusChange,
}: {
  source: IncomeSource
  entry?: IncomeSourceEntry | null
  onCancel: () => void
  onSave: (payload: IncomeSourceEntryPayload) => Promise<boolean>
  submitRef: MutableRefObject<(() => void) | null>
  onStatusChange: (status: PayslipComposerStatus) => void
}) {
  const id = useId()
  const [form, setForm] = useState<PayslipForm>(() => entry ? payslipFormFromEntry(entry) : emptyPayslipForm())
  const [autoGross, setAutoGross] = useState(true)
  const [autoNet, setAutoNet] = useState(true)
  const set = (key: keyof PayslipForm) => (value: string) => setForm((current) => ({ ...current, [key]: value }))

  const computedGross = moneyNumber(form.basePay) + moneyNumber(form.taxableAdditions) - moneyNumber(form.taxableDeductions)
  const gross = autoGross ? computedGross : moneyNumber(form.grossPay)
  const contributions = useMemo(() => {
    const socialInsurance = Math.round(gross * 0.1371)
    const healthInsurance = Math.round(Math.max(0, gross - socialInsurance) * 0.09)
    const ppkContribution = Math.round(gross * 0.02)
    const taxAdvance = Math.max(0, Math.round((gross - socialInsurance - 250) * 0.12 - 300))
    return { socialInsurance, healthInsurance, ppkContribution, taxAdvance }
  }, [gross])
  const computedNet =
    gross -
    moneyNumber(form.socialInsurance) -
    moneyNumber(form.healthInsurance) -
    moneyNumber(form.ppkContribution) -
    moneyNumber(form.taxAdvance) +
    moneyNumber(form.nonTaxableAdditions) -
    moneyNumber(form.nonTaxableDeductions)
  const net = autoNet ? computedNet : moneyNumber(form.netPayable)

  const autoFill = () => setForm((current) => ({
    ...current,
    socialInsurance: String(contributions.socialInsurance),
    healthInsurance: String(contributions.healthInsurance),
    ppkContribution: String(contributions.ppkContribution),
    taxAdvance: String(contributions.taxAdvance),
  }))

  async function submit() {
    const values = Object.fromEntries(PAYSLIP_FIELDS.map((field) => [field.key, moneyNumber(form[field.key])]))
    const saved = await onSave({
      description: form.period.trim() || `${source.name} ${periodLabel(form.entry_date)}`,
      amount: net,
      entry_date: form.entry_date,
      owner_scope: source.owner_scope,
      notes: form.notes,
      extra_payload: { kind: 'employment_payslip', payslip: { ...values, period: form.period.trim() || periodLabel(form.entry_date), grossPay: gross, netPayable: net } },
    })
    if (saved) onCancel()
  }

  // Bridge the composer's save action up to the modal footer. Keep the ref pointed
  // at the latest closure (so it sees current form values) and report save-ability
  // plus the live net so the footer can render and gate the Save payslip button.
  useEffect(() => {
    submitRef.current = () => { void submit() }
    return () => { submitRef.current = null }
  })
  useEffect(() => {
    onStatusChange({ canSave: Boolean(form.entry_date), net })
  }, [form.entry_date, net, onStatusChange])

  return (
    <div className="income-payslip-composer">
      <div className="income-payslip-composer__head">
        <OutlinedInput id={`${id}-period`} label="Pay period" placeholder={periodLabel(form.entry_date)} value={form.period} onChange={(event) => set('period')(event.target.value)} />
        <OutlinedInput id={`${id}-date`} label="Pay date" type="date" value={form.entry_date} onChange={(event) => set('entry_date')(event.target.value)} />
      </div>

      <div className="income-payslip-group income-payslip-group--earn">
        <p className="income-payslip-group__title">{GROUP_TITLES.earn}</p>
        <div className="income-payslip-group__grid">
          {groupFields('earn').map((field) => (
            <PayslipField key={field.key} field={field} value={form[field.key]} onChange={set(field.key)} />
          ))}
        </div>
      </div>
      <PayslipTotalRow label={GROSS_FIELD.label} polish={GROSS_FIELD.polish} value={form.grossPay} auto={autoGross} computed={computedGross} onValue={(value) => { setAutoGross(false); set('grossPay')(value) }} onAuto={() => setAutoGross(true)} />

      <div className="income-payslip-group income-payslip-group--contrib">
        <div className="income-payslip-group__head">
          <p className="income-payslip-group__title">{GROUP_TITLES.contrib}</p>
          <button className="income-payslip-autofill" onClick={autoFill} type="button"><Zap className="h-3.5 w-3.5" /> Auto-fill from gross</button>
        </div>
        <div className="income-payslip-group__grid">
          {groupFields('contrib').map((field) => (
            <PayslipField key={field.key} field={field} value={form[field.key]} onChange={set(field.key)} />
          ))}
        </div>
      </div>

      <div className="income-payslip-group income-payslip-group--adjust">
        <p className="income-payslip-group__title">{GROUP_TITLES.adjust}</p>
        <div className="income-payslip-group__grid">
          {groupFields('adjust').map((field) => (
            <PayslipField key={field.key} field={field} value={form[field.key]} onChange={set(field.key)} />
          ))}
        </div>
      </div>
      <PayslipTotalRow accent label={NET_FIELD.label} polish={NET_FIELD.polish} value={form.netPayable} auto={autoNet} computed={computedNet} onValue={(value) => { setAutoNet(false); set('netPayable')(value) }} onAuto={() => setAutoNet(true)} />

      <OutlinedInput id={`${id}-notes`} label="Note" placeholder="Salary + Q1 bonus…" value={form.notes} onChange={(event) => set('notes')(event.target.value)} />
    </div>
  )
}

export function PayslipRow({ entry, currency, open, onToggle, onEdit }: { entry: IncomeSourceEntry; currency: string; open: boolean; onToggle: () => void; onEdit: (entry: IncomeSourceEntry) => void }) {
  const payslip = getPayslip(entry)
  const groups: Array<[PayslipGroup, string]> = [['earn', GROUP_TITLES.earn], ['contrib', GROUP_TITLES.contrib], ['adjust', GROUP_TITLES.adjust]]
  return (
    <div className={`income-payslip-row${open ? ' is-open' : ''}`}>
      <div className="income-payslip-row__summary">
        <button className="income-payslip-row__toggle" onClick={onToggle} type="button" aria-expanded={open}>
          <span className="income-payslip-row__icon"><Banknote className="h-4 w-4" /></span>
          <span className="income-payslip-row__identity">
            <strong>{String(payslip?.period ?? '') || periodLabel(entry.entry_date)}</strong>
          </span>
        </button>
        {open ? (
          <button className="income-payslip-row__edit" onClick={() => onEdit(entry)} type="button" aria-label="Edit payslip">
            <Pencil className="h-3.5 w-3.5" />
          </button>
        ) : null}
        <button className="income-payslip-row__toggle income-payslip-row__toggle--amount" onClick={onToggle} type="button" aria-label="Toggle payslip details">
          <span className="income-payslip-row__grow" />
          <span className="income-payslip-row__amount">
            <strong>{fmtMoney(entryNet(entry), currency)}</strong>
            <small>{fmtMoney(entryGross(entry), currency)} gross</small>
          </span>
          <ChevronDown className={`income-payslip-row__chevron${open ? ' is-open' : ''} h-4 w-4`} aria-hidden="true" />
        </button>
      </div>
      {open ? (
        <div className="income-payslip-row__details">
          {groups.map(([group, title]) => {
            const fields = groupFields(group).filter((field) => payslipValue(entry, field.key) !== 0)
            const rows = [
              ...fields,
              ...(group === 'earn' ? [{ key: GROSS_FIELD.key, label: GROSS_FIELD.label, polish: GROSS_FIELD.polish, sign: 1 as const, total: true }] : []),
              ...(group === 'adjust' ? [{ key: NET_FIELD.key, label: NET_FIELD.label, polish: NET_FIELD.polish, sign: 1 as const, total: true }] : []),
            ]
            if (!rows.length) return null
            return (
              <div className="income-payslip-row__group" key={group}>
                <p>{title}</p>
                {rows.map((field) => {
                  const value = field.key === NET_FIELD.key ? entryNet(entry) : payslipValue(entry, field.key)
                  const isTotal = 'total' in field && field.total
                  const valueClass = isTotal ? '' : field.sign < 0 ? 'is-negative' : 'is-positive'
                  return (
                    <div className={`income-payslip-row__line${isTotal ? ' is-total' : ''}`} key={field.key}>
                      <span title={`Polish: ${field.polish}`}>{field.label}</span>
                      <strong className={valueClass}>{field.sign < 0 ? '−' : ''}{fmtMoney(Math.abs(value), currency)}</strong>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

export function PayslipList({ entries, currency, onEdit }: { entries: IncomeSourceEntry[]; currency: string; onEdit: (entry: IncomeSourceEntry) => void }) {
  const [openId, setOpenId] = useState<string | null>(null)
  if (!entries.length) {
    return <div className="income-ledger-empty">No payslips recorded yet.</div>
  }
  return (
    <div className="income-payslip-list">
      {entries.map((entry) => (
        <PayslipRow key={entry.id} entry={entry} currency={currency} open={openId === entry.id} onToggle={() => setOpenId(openId === entry.id ? null : entry.id)} onEdit={onEdit} />
      ))}
    </div>
  )
}

export function PayslipTable({ entries, currency }: { entries: IncomeSourceEntry[]; currency: string }) {
  const columns = [...entries].sort((left, right) => String(left.entry_date ?? '').localeCompare(String(right.entry_date ?? '')))
  const rows: Array<{ key: PayslipKey | PayslipTotalKey; label: string; polish: string; sign: 1 | -1; total?: boolean; accent?: boolean }> = [
    ...groupFields('earn'),
    { ...GROSS_FIELD, sign: 1, total: true },
    ...groupFields('contrib'),
    ...groupFields('adjust'),
    { ...NET_FIELD, sign: 1, total: true, accent: true },
  ]
  const shortMonth = (entry: IncomeSourceEntry) => {
    const date = new Date(`${entry.entry_date ?? ''}T00:00:00`)
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  }
  return (
    <div className="income-payslip-table-shell">
      <table className="income-payslip-table">
        <thead>
          <tr>
            <th>Component</th>
            {columns.map((entry) => <th key={entry.id}>{shortMonth(entry)}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((field) => (
            <tr key={field.key} className={`${field.total ? 'is-total' : ''}${field.accent ? ' is-accent' : ''}`}>
              <th title={`Polish: ${field.polish}`}>{field.label}</th>
              {columns.map((entry) => {
                const value = field.key === NET_FIELD.key ? entryNet(entry) : payslipValue(entry, field.key as PayslipKey | PayslipTotalKey)
                const cls = value === 0 ? 'is-zero' : field.accent ? 'is-accent' : field.sign < 0 ? 'is-negative' : ''
                return <td className={cls} key={`${entry.id}-${field.key}`}>{value === 0 ? '–' : `${field.sign < 0 ? '−' : ''}${fmtMoney(Math.abs(value), currency)}`}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function SimpleLedger({
  source,
  currency,
  saving,
  onCreateEntry,
}: {
  source: IncomeSource
  currency: string
  saving: boolean
  onCreateEntry: (sourceId: string, payload: IncomeSourceEntryPayload) => Promise<boolean>
}) {
  const id = useId()
  const [form, setForm] = useState({ entry_date: todayInputValue(), gross: '', net: '', note: '' })
  const entries = sortedEntries(source.entries ?? [])
  const total12 = entries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0)

  async function submit() {
    const gross = moneyNumber(form.gross)
    if (!gross || !form.entry_date) return
    const net = moneyNumber(form.net) || Math.round(gross * 0.72)
    const saved = await onCreateEntry(source.id, {
      description: form.note.trim() || `${source.name} ${periodLabel(form.entry_date)}`,
      amount: net,
      entry_date: form.entry_date,
      owner_scope: source.owner_scope,
      notes: form.note,
      extra_payload: { kind: 'income_payment', payslip: { grossPay: gross, netPayable: net } },
    })
    if (saved) setForm({ entry_date: todayInputValue(), gross: '', net: '', note: '' })
  }

  return (
    <div className="income-generic-ledger">
      <div className="income-paycheck-composer">
        <p className="income-payslip-group__title">Log a paycheck</p>
        <div className="income-paycheck-composer__grid">
          <OutlinedInput id={`${id}-date`} label="Date" type="date" value={form.entry_date} onChange={(event) => setForm({ ...form, entry_date: event.target.value })} />
          <OutlinedInput id={`${id}-gross`} label="Gross" type="number" step="0.01" inputMode="decimal" placeholder="0.00" value={form.gross} onChange={(event) => setForm({ ...form, gross: event.target.value })} />
          <OutlinedInput id={`${id}-net`} label="Net" hint="Leave net blank to estimate it from gross." type="number" step="0.01" inputMode="decimal" placeholder="auto" value={form.net} onChange={(event) => setForm({ ...form, net: event.target.value })} />
          <button className="button button--compact" disabled={saving} onClick={() => void submit()} type="button"><Plus className="h-4 w-4" /> {saving ? 'Saving...' : 'Log'}</button>
        </div>
      </div>
      {entries.length ? (
        <div className="income-payslip-list">
          {entries.map((entry) => {
            const gross = entryGross(entry) || Number(entry.amount || 0)
            const deduction = Math.max(0, gross - Number(entry.amount || 0))
            return (
              <div className="income-payslip-row" key={entry.id}>
                <div className="income-payslip-row__summary income-payslip-row__summary--static">
                  <span className={`income-payslip-row__icon income-payslip-row__icon--${source.source_type}`}><SourceTypeIcon type={source.source_type} className="h-4 w-4" /></span>
                  <span className="income-payslip-row__identity">
                    <strong>{fmtDate(entry.entry_date)}</strong>
                    <small>{entry.notes || entry.description || 'Paycheck'}</small>
                  </span>
                  <span className="income-payslip-row__grow" />
                  <span className="income-payslip-row__amount">
                    <strong>{fmtMoney(entry.amount, currency)}</strong>
                    <small>{fmtMoney(gross, currency)} gross · −{fmtMoney(deduction, currency)}</small>
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      ) : <div className="income-ledger-empty">No paychecks recorded yet.</div>}
      {entries.length ? (
        <div className="income-ledger-foot">
          <small>{entries.length} paychecks · last 12 months</small>
          <strong>{fmtMoney(total12, currency)}</strong>
        </div>
      ) : null}
    </div>
  )
}

