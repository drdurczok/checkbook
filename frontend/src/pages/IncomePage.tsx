import { useEffect, useId, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Briefcase, Calendar, Pencil, Plus, Save, TrendingUp, Users } from 'lucide-react'
import { OutlinedInput, OutlinedNativeSelect, OutlinedTextarea } from '../components/ui/OutlinedField'
import { FormSheet } from '../components/ui/FormSheet'
import { IncomeSourceModal } from '../components/IncomeSourceModal'
import { DateRangeFilter } from '../components/DateRangeFilter'
import { SectionPanel } from '../components/panel'
import { api } from '../lib/api'
import { fmtMoney, resolveDateRange } from '../lib/format'
import type { DateRangeKey } from '../lib/format'
import { useHeaderActions } from '../lib/header-slot'
import { SOURCE_TYPE_OPTIONS, sourceOrg, sourceTypeLabel } from '../lib/income'
import { calculateIncomeSummary, incomeSourcesInDateRange, isActiveSource, monthsBetween, sortIncomeHistory, sourceAnnualValue } from '../features/income/model'
import { incomeKeys, replaceIncomeSource, useIncomeSourcesQuery } from '../features/income/queries'
import { useSession } from '../lib/session'
import type { IncomeSource, IncomeSourceEntryPayload, IncomeSourcePayload, OwnershipScope } from '../types'

type CreateForm = {
  name: string
  source_type: string
  owner_scope: OwnershipScope
  started_on: string
  ended_on: string
  notes: string
}

const emptyCreateForm = (): CreateForm => ({
  name: '',
  source_type: 'employment',
  owner_scope: 'joint',
  started_on: '',
  ended_on: '',
  notes: '',
})

const ownerLabel = (scope: OwnershipScope) => (scope === 'joint' ? 'Joint' : scope === 'spouse' ? 'Spouse' : 'Self')

/* Type → categorical colour (space-separated RGB channels, app token convention). */
const TYPE_COLOR: Record<string, string> = {
  employment: '30 111 214',
  rental: '18 148 111',
  business: '217 119 6',
  investment: '139 92 246',
  benefit: '15 118 110',
}
const typeChannels = (type: string) => TYPE_COLOR[type] ?? TYPE_COLOR.employment

const formatTenure = (months: number) => {
  if (months < 12) return `${months} mo`
  const years = months / 12
  return `${years.toFixed(years >= 10 ? 0 : 1)} yrs`
}

const monthYear = (value?: string | null) => {
  if (!value) return ''
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

const dateRangeLabel = (source: IncomeSource) => `${monthYear(source.started_on) || 'Unknown'} – ${source.ended_on ? monthYear(source.ended_on) : 'Present'}`

export function IncomePage() {
  const fieldId = useId()
  const { token, currency, setError, setMessage } = useSession()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [createForm, setCreateForm] = useState<CreateForm>(() => emptyCreateForm())
  const [dateRange, setDateRange] = useState<DateRangeKey>('all')
  const [showForecast, setShowForecast] = useState(false)
  const range = useMemo(() => resolveDateRange(dateRange, showForecast), [dateRange, showForecast])

  useHeaderActions(
    <DateRangeFilter value={dateRange} onChange={setDateRange} forecastFilter={{ checked: showForecast, onChange: setShowForecast }} />,
    [dateRange, showForecast],
  )

  const incomeQuery = useIncomeSourcesQuery(token)
  const sources = useMemo(() => incomeQuery.data ?? [], [incomeQuery.data])
  const selected = selectedId ? sources.find((source) => source.id === selectedId) ?? null : null

  useEffect(() => {
    if (incomeQuery.error) {
      setError(incomeQuery.error instanceof Error ? incomeQuery.error.message : 'Income refresh failed.')
    }
  }, [incomeQuery.error, setError])

  const load = async () => {
    await incomeQuery.refetch()
  }

  const updateCachedSource = (updated: IncomeSource) => {
    queryClient.setQueryData<IncomeSource[]>(
      incomeKeys.sources(token),
      (current) => replaceIncomeSource(current, updated),
    )
  }

  const now = useMemo(() => new Date(), [])
  const summary = useMemo(() => calculateIncomeSummary(incomeSourcesInDateRange(sources, range, now), now), [now, range, sources])
  const { activeAnnualTotal, activeNetTakeHome, tax, history: historyStats } = summary
  const historicalSources = useMemo(() => sortIncomeHistory(sources, now), [now, sources])

  function exportIncomeHistory() {
    const rows = [
      ['Name', 'Type', 'Owner', 'Started', 'Ended', 'Annual'],
      ...historicalSources.map((source) => [
        source.name,
        sourceTypeLabel(source.source_type),
        ownerLabel(source.owner_scope),
        source.started_on ?? '',
        source.ended_on ?? '',
        String(sourceAnnualValue(source, now)),
      ]),
    ]
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'income-history.csv'
    link.click()
    URL.revokeObjectURL(url)
  }

  async function createSource() {
    if (!token || !createForm.name.trim()) return
    setBusy('income-save')
    try {
      const payload: IncomeSourcePayload = {
        name: createForm.name,
        source_type: createForm.source_type,
        owner_scope: createForm.owner_scope,
        started_on: createForm.started_on || null,
        ended_on: createForm.ended_on || null,
        notes: createForm.notes,
        lines: [],
        fields: [],
        milestones: [],
        sort_order: sources.length,
      }
      await api.createIncomeSource(token, payload)
      setIsCreateOpen(false)
      setCreateForm(emptyCreateForm())
      await load()
      setMessage('Income source saved.')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Income source create failed.')
    } finally {
      setBusy(null)
    }
  }

  async function saveSource(payload: IncomeSourcePayload): Promise<boolean> {
    if (!token || !selected) return false
    setBusy('income-save')
    try {
      const updated = await api.updateIncomeSource(token, selected.id, payload)
      updateCachedSource(updated)
      setMessage('Income source updated.')
      return true
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Income source update failed.')
      return false
    } finally {
      setBusy(null)
    }
  }

  async function createEntry(sourceId: string, payload: IncomeSourceEntryPayload): Promise<boolean> {
    if (!token) return false
    setBusy('income-entry-save')
    try {
      const updated = await api.createIncomeSourceEntry(token, sourceId, payload)
      updateCachedSource(updated)
      setMessage('Income entry saved.')
      return true
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Income entry create failed.')
      return false
    } finally {
      setBusy(null)
    }
  }

  async function updateEntry(sourceId: string, entryId: string, payload: IncomeSourceEntryPayload): Promise<boolean> {
    if (!token) return false
    setBusy('income-entry-save')
    try {
      const updated = await api.updateIncomeSourceEntry(token, sourceId, entryId, payload)
      updateCachedSource(updated)
      setMessage('Payslip updated.')
      return true
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Payslip update failed.')
      return false
    } finally {
      setBusy(null)
    }
  }

  async function deleteSource() {
    if (!token || !selected) return
    setBusy('income-delete')
    try {
      await api.deleteIncomeSource(token, selected.id)
      setSelectedId(null)
      await load()
      setMessage('Income source deleted.')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Income source delete failed.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="page-stack income-page income-page--designed">
        <div className="income-metrics">
          <section className="income-metric income-metric--split">
            <span className="income-metric__slash" aria-hidden="true"><i>/</i></span>
            <div className="income-metric__gross">
              <span>Gross / year</span>
              <strong>{fmtMoney(activeAnnualTotal, currency)}</strong>
            </div>
            <div className="income-metric__net">
              <span>Net take-home</span>
              <strong>{fmtMoney(activeNetTakeHome, currency)}</strong>
            </div>
          </section>
          <section className={`income-metric income-metric--tax${tax.balance > 0 ? ' income-metric--tax-due' : ''}`}>
            <div className="income-metric__row">
              <span>Tax / est. balance at filing</span>
              {tax.balance > 0 ? <small className="income-tax-pill">To pay</small> : null}
            </div>
            <strong className="income-tax-balance">{fmtMoney(tax.balance, currency)}</strong>
            <div className="income-tax-bar" aria-hidden="true">
              <span style={{ width: `${tax.paidRatio}%` }} />
            </div>
            <div className="income-tax-bar__labels">
              <span>Withheld {fmtMoney(tax.withheld, currency)}</span>
              <span>Total due {fmtMoney(tax.due, currency)}</span>
            </div>
          </section>
        </div>

        <SectionPanel
          title="Income history"
          actions={<button className="button button--ghost income-export-button" onClick={exportIncomeHistory} type="button">Export</button>}
          className="income-history-panel"
        >
          <div className="income-history-stats">
            <div><span>Longest tenure</span><strong>{formatTenure(historyStats.longest)}</strong></div>
            <div><span>Lifetime earned</span><strong>{fmtMoney(historyStats.lifetime, currency)}</strong></div>
            <div><span>Avg annual raise</span><strong>{historyStats.avgRaise >= 0 ? '+' : ''}{Math.round(historyStats.avgRaise * 100)}%</strong></div>
          </div>
          <div className="income-timeline">
            <div className="income-timeline__rail-group">
              <span className="income-timeline__rail" aria-hidden="true" />
              {historicalSources.map((source) => {
                const active = isActiveSource(source, now)
                const channels = typeChannels(source.source_type)
                return (
                  <button
                    className={`income-timeline__entry${active ? ' is-active' : ''}`}
                    key={source.id}
                    onClick={() => setSelectedId(source.id)}
                    type="button"
                    style={{ ['--dot']: `rgb(${channels})`, ['--dot-halo']: `rgb(${channels} / 0.22)` } as React.CSSProperties}
                  >
                    <span className="income-timeline__rail-cell" aria-hidden="true">
                      <span className={`income-timeline__dot${active ? ' is-active' : ''}`} />
                    </span>
                    <span className="income-timeline__card">
                      <span className="income-timeline__card-head">
                        <span className="income-timeline__identity">
                          <span className="income-timeline__identity-row">
                            <strong>{sourceOrg(source)}</strong>
                            <span className={`income-source-chip income-source-chip--${source.source_type}`}>{sourceTypeLabel(source.source_type)}</span>
                          </span>
                          {sourceOrg(source) !== source.name ? (
                            <span className="income-timeline__identity-meta">
                              <small>{source.name}</small>
                            </span>
                          ) : null}
                        </span>
                        <span className="income-timeline__range">
                          <span>
                            {dateRangeLabel(source)}{' '}
                            <small className="income-timeline__tenure">({formatTenure(monthsBetween(source.started_on, source.ended_on, now))})</small>
                          </span>
                          <span className="income-timeline__annual cb-numeral">{fmtMoney(sourceAnnualValue(source, now), currency)}<small className="income-timeline__per"> /yr</small></span>
                        </span>
                      </span>
                      {source.milestones.length ? (
                        <span className="income-timeline__milestones">
                          {source.milestones.map((milestone, index) => (
                            <span className="income-timeline__milestone" key={index}>
                              <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
                              <span className="income-timeline__milestone-label">{milestone.label}</span>
                              <span className="income-timeline__grow" />
                              {milestone.date ? <small>{milestone.date}</small> : null}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </SectionPanel>
      </div>

      <button className="quick-add-fab income-fab" onClick={() => { setCreateForm(emptyCreateForm()); setIsCreateOpen(true) }} type="button" aria-label="Add income source">
        <Plus className="h-6 w-6" />
      </button>

      {isCreateOpen ? (
        <FormSheet
          className="quick-add-modal income-create-modal"
          title="New income source"
          titleId="income-create-title"
          onClose={() => setIsCreateOpen(false)}
        >
          <form className="income-create-form" onSubmit={(event) => { event.preventDefault(); void createSource() }}>
            <div className="income-create-grid">
              <OutlinedInput id={`${fieldId}-incomepage-1`} label="Name" className="income-create-name" leadingIcon={<Pencil aria-hidden="true" className="h-4 w-4" />} placeholder="Name" value={createForm.name} onChange={(event) => setCreateForm({ ...createForm, name: event.target.value })} />
              <OutlinedNativeSelect id={`${fieldId}-incomepage-2`} label="Type" className="income-create-type" leadingIcon={<Briefcase aria-hidden="true" className="h-4 w-4" />} value={createForm.source_type} onChange={(event) => setCreateForm({ ...createForm, source_type: event.target.value })}>
                {SOURCE_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </OutlinedNativeSelect>
              <OutlinedNativeSelect id={`${fieldId}-incomepage-3`} label="Owner" className="income-create-owner" leadingIcon={<Users aria-hidden="true" className="h-4 w-4" />} value={createForm.owner_scope} onChange={(event) => setCreateForm({ ...createForm, owner_scope: event.target.value as OwnershipScope })}>
                <option value="joint">Joint</option>
                <option value="self">Self</option>
                <option value="spouse">Spouse</option>
              </OutlinedNativeSelect>
              <div className="field-pair">
                <OutlinedInput id={`${fieldId}-incomepage-4`} label="From" className="income-create-from" leadingIcon={<Calendar aria-hidden="true" className="h-4 w-4" />} type="date" value={createForm.started_on} onChange={(event) => setCreateForm({ ...createForm, started_on: event.target.value })} />
                <OutlinedInput id={`${fieldId}-incomepage-5`} label="To" className="income-create-to" leadingIcon={<Calendar aria-hidden="true" className="h-4 w-4" />} type="date" value={createForm.ended_on} onChange={(event) => setCreateForm({ ...createForm, ended_on: event.target.value })} />
              </div>
              <OutlinedTextarea id={`${fieldId}-incomepage-6`} label="Notes" className="quick-add-notes income-create-notes" placeholder="Notes" value={createForm.notes} onChange={(event) => setCreateForm({ ...createForm, notes: event.target.value })} />
            </div>
            <div className="quick-add-actions income-create-actions">
              <button className="button" disabled={busy === 'income-save'} type="submit">
                <Save className="h-4 w-4" />
                <span>{busy === 'income-save' ? 'Saving...' : 'Save source'}</span>
              </button>
            </div>
          </form>
        </FormSheet>
      ) : null}

      {selected ? (
        <IncomeSourceModal
          key={selected.id}
          source={selected}
          dateRange={range}
          currency={currency}
          saving={busy === 'income-save'}
          entrySaving={busy === 'income-entry-save'}
          deleting={busy === 'income-delete'}
          onClose={() => setSelectedId(null)}
          onSave={saveSource}
          onCreateEntry={createEntry}
          onUpdateEntry={updateEntry}
          onDelete={deleteSource}
        />
      ) : null}
    </>
  )
}
