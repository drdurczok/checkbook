import Decimal from 'decimal.js'
import { ExpenseHistoryRow } from '../features/expenses/ExpenseHistoryRow'
import { monthlyExpenseCategories } from '../features/expenses/monthlySpend'
import { useMonthlySpend } from '../features/expenses/useMonthlySpend'
import { RecurringExpenses } from '../features/expenses/RecurringExpenses'
import { ExpenseQuickFilters } from '../features/expenses/ExpenseQuickFilters'
import { ExpenseCharts } from '../features/expenses/ExpenseCharts'
import { DetailActionsMenu } from '../components/DetailActionsMenu'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Archive, ArchiveRestore, Calendar, Coins, Folder, Link2, Pencil, Plus, Save, StickyNote, Trash2, Users, X } from 'lucide-react'
import { OutlinedInput, OutlinedNativeSelect, OutlinedTextarea } from '../components/ui/OutlinedField'
import { Modal } from '../components/Modal'
import { FormSheet } from '../components/ui/FormSheet'
import { QuickAddRecordModal } from '../components/QuickAddRecordModal'
import { LineChart, StackedBarChart, ValueTrendChart } from '../components/charts'
import { SectionPanel } from '../components/panel'
import { AsyncState } from '../components/ui/AsyncState'
import { api } from '../lib/api'
import { expenseBoardMix, UNGROUPED_EXPENSE_LABEL } from '../lib/expenses'
import { fmtMoney, resolveDateRange, currencySymbol, formatAmountDraft, parseAmountDraft, dateRangeOptionLabel } from '../lib/format'
import type { DateRangeKey } from '../lib/format'
import type { RecurringExpense } from '../contracts/expenses'
import { useSession } from '../lib/session'
import type {
  ExpenseCategoryDetail,
  ExpenseCategorySummary,
  ExpenseEntry,
  ExpenseGroup,
  ExpensesBoard,
  OwnershipScope,
} from '../types'

/* Categorical palette for group dots (space-separated RGB channels, app
   token convention shared with the income timeline). */
const GROUP_PALETTE = [
  '16 148 111',
  '30 111 214',
  '217 119 6',
  '139 92 246',
  '220 68 89',
  '15 118 110',
  '190 120 30',
  '96 108 128',
]

const UNGROUPED_KEY = 'ungrouped'
const UNGROUPED_COLOR = 'var(--mist)'

const monthYear = (value?: string | null) => {
  if (!value) return '—'
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

const todayKey = () => new Date().toLocaleDateString('sv-SE')

type GroupForm = { name: string; color: string; notes: string }
type EntryForm = { description: string; amount: string; entry_date: string; owner_scope: OwnershipScope; notes: string }

const emptyEntryForm = (): EntryForm => ({
  description: '',
  amount: '',
  entry_date: todayKey(),
  owner_scope: 'joint',
  notes: '',
})

export function ExpensesPage({ dateRange = 'all', showForecast = false, showRetired = false }: { dateRange?: DateRangeKey; showForecast?: boolean; showRetired?: boolean }) {
  const fieldId = useId()
  const { token, currency, setError, setMessage } = useSession()
  const [busy, setBusy] = useState<string | null>(null)
  const [detail, setDetail] = useState<ExpenseCategoryDetail | null>(null)
  const [groupModal, setGroupModal] = useState<{ group: ExpenseGroup | null } | null>(null)
  const [addGroupModal, setAddGroupModal] = useState<{ group: ExpenseGroup; name: string } | null>(null)
  const [groupForm, setGroupForm] = useState<GroupForm>({ name: '', color: GROUP_PALETTE[0], notes: '' })
  const [isQuickAddOpen, setIsQuickAddOpen] = useState(false)
  const [isGroupNotesOpen, setIsGroupNotesOpen] = useState(false)
  const editingGroup = groupModal?.group ?? null

  const range = useMemo(() => resolveDateRange(dateRange, showForecast), [dateRange, showForecast])
  const expensesQuery = useQuery({
    queryKey: ['expenses', token, range.start_date ?? null, range.end_date ?? null],
    enabled: Boolean(token),
    queryFn: async () => {
      const [board, categories, assets] = await Promise.all([
        api.getExpensesBoard(token, range),
        api.getCategories(token),
        api.getAssets(token),
      ])
      return { board, categories, assets }
    },
  })
  const monthlySpendQuery = useMonthlySpend(token)
  const board: ExpensesBoard | null = expensesQuery.data?.board ?? null
  const monthlyCategories = useMemo(() => monthlyExpenseCategories(
    board?.categories ?? [], monthlySpendQuery.data?.monthly_totals ?? [], dateRange === 'month', new Date(),
  ), [board, monthlySpendQuery.data, dateRange])
  const householdCategories = expensesQuery.data?.categories ?? []
  const properties = (expensesQuery.data?.assets ?? []).filter((asset) => (asset.kind ?? 'asset') === 'asset')
  const load = useCallback(async () => {
    await Promise.all([expensesQuery.refetch(), monthlySpendQuery.refetch()])
  }, [expensesQuery, monthlySpendQuery])

  useEffect(() => {
    const error = expensesQuery.error ?? monthlySpendQuery.error
    if (error) {
      setError(error instanceof Error ? error.message : 'Expenses refresh failed.')
    }
  }, [expensesQuery.error, monthlySpendQuery.error, setError])

  const rootCategories = useMemo(
    () => (board?.categories ?? []).filter((category) => !category.parent_id),
    [board],
  )
  const sections = useMemo(() => {
    const groups = (board?.groups ?? []).filter((group) => showRetired || !group.is_retired)
    const byGroup = new Map<string, ExpenseCategorySummary[]>()
    for (const category of monthlyCategories.filter((category) => !category.parent_id)) {
      if (!showRetired && category.is_retired) continue
      const key = category.expense_group_id ?? UNGROUPED_KEY
      byGroup.set(key, [...(byGroup.get(key) ?? []), category])
    }
    const spend = (categories: ExpenseCategorySummary[]) => categories.reduce((sum, category) => sum.plus(category.monthly_average), new Decimal(0))
    const result = groups.map((group) => ({ group, categories: byGroup.get(group.id) ?? [] }))
      .sort((left, right) => spend(right.categories).comparedTo(spend(left.categories)) || left.group.name.localeCompare(right.group.name))
    const ungrouped = byGroup.get(UNGROUPED_KEY) ?? []
    return { grouped: result, ungrouped }
  }, [board, monthlyCategories, showRetired])

  const totals = useMemo(() => {
    const monthly = rootCategories.reduce((sum, category) => sum + category.monthly_average, 0)
    const lifetime = rootCategories.reduce((sum, category) => sum + category.total_amount, 0)
    return { monthly, lifetime }
  }, [rootCategories])

  const expenseMix = useMemo(() => board ? expenseBoardMix(board, showRetired) : null, [board, showRetired])

  const [selectedExpenseMixGroup, setSelectedExpenseMixGroup] = useState<string | null>(null)

  const expenseMixColors = useMemo<Record<string, string>>(() => ({
    ...Object.fromEntries(
      (board?.groups ?? []).filter((group) => group.color.trim()).map((group) => [group.name, `rgb(${group.color})`]),
    ),
    [UNGROUPED_EXPENSE_LABEL]: `rgb(${UNGROUPED_COLOR})`,
  }), [board])

  /* The quick-filter selection also drives the recurring section: each
     schedule inherits its category's group, and unclassified schedules fall
     into the ungrouped bucket just like the mix chart's bars. */
  const recurringMatchesFilter = useMemo(() => {
    const groupByCategory = new Map(
      (board?.categories ?? []).map((category) => [
        category.id,
        (board?.groups ?? []).find((group) => group.id === category.expense_group_id)?.name ?? UNGROUPED_EXPENSE_LABEL,
      ]),
    )
    return (schedule: RecurringExpense) => {
      if (selectedExpenseMixGroup === null) return true
      const group = schedule.category_id ? groupByCategory.get(schedule.category_id) : undefined
      return (group ?? UNGROUPED_EXPENSE_LABEL) === selectedExpenseMixGroup
    }
  }, [board, selectedExpenseMixGroup])

  const hasSpendingTrend = useMemo(() => {
    const months = new Set((expenseMix?.trend ?? [])
      .filter((point) => !selectedExpenseMixGroup || Object.hasOwn(point.values, selectedExpenseMixGroup))
      .map((point) => point.period.slice(0, 7)))
    return months.size >= 6
  }, [expenseMix, selectedExpenseMixGroup])

  /* Trailing 12-month rolling average of monthly spend — total, or just the
     group picked in the mix chart's legend, so the two top charts stay in
     sync. Answers "is spending trending up or down?", which the noisy
     month-to-month bars can't. */
  const spendTrend = useMemo(() => {
    if (!expenseMix) return []
    const monthly = expenseMix.trend.map((point) => ({
      period: point.period,
      value: selectedExpenseMixGroup
        ? point.values[selectedExpenseMixGroup] ?? 0
        : Object.values(point.values).reduce((sum, value) => sum + value, 0),
    }))
    return monthly.map((_, index) => {
      const window = monthly.slice(Math.max(0, index - 11), index + 1)
      return {
        period: monthly[index].period,
        value: window.reduce((sum, point) => sum + point.value, 0) / window.length,
      }
    })
  }, [expenseMix, selectedExpenseMixGroup])

  /* Category filter chips live below the summary stats (All first,
     Uncategorized last) and drive both charts and the group tables below
     them. */
  const mixFilter = useMemo(() => {
    const labels = expenseMix?.breakdown.map((point) => point.label) ?? []
    return {
      groups: sections.grouped.map(({ group }) => group).filter((group) => labels.includes(group.name) || showRetired),
      includeUngrouped: labels.includes(UNGROUPED_EXPENSE_LABEL),
    }
  }, [sections, expenseMix, showRetired])
  const visibleSections = useMemo(() => {
    if (!selectedExpenseMixGroup) return sections
    if (selectedExpenseMixGroup === UNGROUPED_EXPENSE_LABEL) {
      return { grouped: [], ungrouped: sections.ungrouped }
    }
    return {
      grouped: sections.grouped.filter((section) => section.group.name === selectedExpenseMixGroup),
      ungrouped: [],
    }
  }, [sections, selectedExpenseMixGroup])

  async function openDetail(categoryId: string) {
    if (!token) return
    setBusy('expense-detail')
    try {
      setDetail(await api.getExpenseCategoryDetail(token, categoryId))
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Group detail load failed.')
    } finally {
      setBusy(null)
    }
  }

  async function refreshDetail(categoryId: string) {
    if (!token) return
    try {
      setDetail(await api.getExpenseCategoryDetail(token, categoryId))
    } catch {
      setDetail(null)
    }
    await load()
  }

  function openGroupModal(group: ExpenseGroup | null) {
    setGroupForm(
      group
        ? { name: group.name, color: group.color || GROUP_PALETTE[0], notes: group.notes }
        : { name: '', color: GROUP_PALETTE[(board?.groups.length ?? 0) % GROUP_PALETTE.length], notes: '' },
    )
    setIsGroupNotesOpen(Boolean(group?.notes))
    setGroupModal({ group })
  }

  async function saveGroup() {
    if (!token || !groupModal || !groupForm.name.trim()) return
    setBusy('expense-group-save')
    try {
      const payload = {
        name: groupForm.name,
        color: groupForm.color,
        notes: groupForm.notes,
        sort_order: groupModal.group?.sort_order ?? board?.groups.length ?? 0,
      }
      if (groupModal.group) {
        await api.updateExpenseGroup(token, groupModal.group.id, payload)
      } else {
        await api.createExpenseGroup(token, payload)
      }
      setGroupModal(null)
      await load()
      setMessage('Expense category saved.')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Expense category save failed.')
    } finally {
      setBusy(null)
    }
  }

  async function setGroupRetired(group: ExpenseGroup) {
    if (!token) return
    setBusy('expense-group-retire')
    try {
      await api.updateExpenseGroup(token, group.id, {
        name: group.name,
        color: group.color,
        notes: group.notes,
        sort_order: group.sort_order,
        is_retired: !group.is_retired,
      })
      setGroupModal(null)
      setSelectedExpenseMixGroup(null)
      await load()
      setMessage(group.is_retired ? 'Category unretired.' : 'Category retired.')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Category retirement failed.')
    } finally {
      setBusy(null)
    }
  }

  async function deleteGroup(group: ExpenseGroup) {
    if (!token || !group.can_delete) return
    if (!window.confirm(`Delete group "${group.name}"? Its expenses stay and become ungrouped.`)) return
    setBusy('expense-group-delete')
    try {
      await api.deleteExpenseGroup(token, group.id)
      setGroupModal(null)
      await load()
      setMessage('Expense category deleted.')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Expense category delete failed.')
    } finally {
      setBusy(null)
    }
  }

  /* "Add group" from a category's kebab menu: a new group (root category)
     filed directly under that category. */
  async function saveNewGroup() {
    if (!token || !addGroupModal || !addGroupModal.name.trim()) return
    setBusy('expense-add-group-save')
    try {
      await api.createExpenseCategory(token, {
        name: addGroupModal.name.trim(),
        expense_group_id: addGroupModal.group.id,
        sort_order: (board?.categories ?? []).filter(
          (category) => category.expense_group_id === addGroupModal.group.id,
        ).length,
      })
      setAddGroupModal(null)
      await load()
      setMessage(`Group added to ${addGroupModal.group.name}.`)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Group save failed.')
    } finally {
      setBusy(null)
    }
  }

  if (expensesQuery.isPending || expensesQuery.error || monthlySpendQuery.isPending || monthlySpendQuery.error) {
    const error = expensesQuery.error ?? monthlySpendQuery.error
    return (
      <AsyncState
        loading={expensesQuery.isPending || monthlySpendQuery.isPending}
        error={error instanceof Error ? error.message : null}
        empty={false}
        emptyTitle="No expenses"
        emptyBody="Add an expense to start tracking spending."
      >
        {null}
      </AsyncState>
    )
  }

  return (
    <>
      <div className="page-stack expenses-page">
        <div className="chart-stat-grid expense-summary-grid" aria-label="Expenses summary">
          <div>
            <span>Monthly average</span>
            <strong>{fmtMoney(totals.monthly, currency)}</strong>
          </div>
          <div>
            <span>{dateRangeOptionLabel(dateRange)}</span>
            <strong>{fmtMoney(totals.lifetime, currency)}</strong>
          </div>
        </div>

        {expenseMix?.breakdown.length ? (
          <ExpenseQuickFilters>
            <button
              aria-pressed={selectedExpenseMixGroup === null}
              className={`expense-filter-all${selectedExpenseMixGroup === null ? ' is-active' : ''}`}
              onClick={() => setSelectedExpenseMixGroup(null)}
              type="button"
            >
              All
            </button>
            {mixFilter.groups.map((group) => (
              <button
                aria-pressed={selectedExpenseMixGroup === group.name}
                className={selectedExpenseMixGroup === group.name ? 'is-active' : ''}
                key={group.id}
                onClick={() => setSelectedExpenseMixGroup((current) => (current === group.name ? null : group.name))}
                type="button"
              >
                <i aria-hidden="true" style={{ background: `rgb(${group.color})` }} />
                <span className="expense-filter-label">{group.name}</span>
              </button>
            ))}
            {mixFilter.includeUngrouped ? (
              <button
                aria-pressed={selectedExpenseMixGroup === UNGROUPED_EXPENSE_LABEL}
                className={selectedExpenseMixGroup === UNGROUPED_EXPENSE_LABEL ? ' is-active' : ''}
                onClick={() => setSelectedExpenseMixGroup((current) => (current === UNGROUPED_EXPENSE_LABEL ? null : UNGROUPED_EXPENSE_LABEL))}
                type="button"
              >
                <i aria-hidden="true" style={{ background: `rgb(${UNGROUPED_COLOR})` }} />
                <span className="expense-filter-label">{UNGROUPED_EXPENSE_LABEL}</span>
              </button>
            ) : null}
          </ExpenseQuickFilters>
        ) : null}

        {expenseMix?.breakdown.length ? (
          <ExpenseCharts mix={
            <SectionPanel title="Expense mix">
              <StackedBarChart
                points={expenseMix.trend}
                categories={expenseMix.breakdown}
                currency={currency}
                selectedCategory={selectedExpenseMixGroup}
                categoryColors={expenseMixColors}
                showLegend={false}
              />
            </SectionPanel>
          } trend={hasSpendingTrend ? (
              <SectionPanel title="Spending trend">
                <LineChart
                  points={spendTrend}
                  currency={currency}
                  showStats={false}
                  lineColor={selectedExpenseMixGroup ? expenseMixColors[selectedExpenseMixGroup] : undefined}
                />
              </SectionPanel>
            ) : undefined}
            filter={selectedExpenseMixGroup ? { label: selectedExpenseMixGroup, color: expenseMixColors[selectedExpenseMixGroup] } : null} />
        ) : null}

        <RecurringExpenses categories={board?.categories ?? []} showRetired={showRetired} matchesFilter={recurringMatchesFilter} />

        <div className="grid grid--two">
          {[
            ...visibleSections.grouped,
            ...(visibleSections.ungrouped.length || !visibleSections.grouped.length
              ? [{ group: null, categories: visibleSections.ungrouped }] : []),
          ].sort((left, right) => {
            const spend = (categories: ExpenseCategorySummary[]) => categories.reduce((sum, category) => sum.plus(category.monthly_average), new Decimal(0))
            return spend(right.categories).comparedTo(spend(left.categories))
          }).map(({ group, categories }) => group ? (
            <ExpenseGroupSection
              key={group.id}
              title={group.name}
              color={group.color}
              retired={group.is_retired}
              inherited={group.is_source_linked}
              categories={categories}
              currency={currency}
              actions={
                <DetailActionsMenu
                  label={`Category options for ${group.name}`}
                  actions={[
                    { label: 'Edit category', onClick: () => openGroupModal(group) },
                    ...(group.is_retired ? [] : [{ label: 'Add group', onClick: () => setAddGroupModal({ group, name: '' }) }]),
                    { label: group.is_retired ? 'Unretire category' : 'Retire category', onClick: () => void setGroupRetired(group), disabled: busy !== null },
                  ]}
                />
              }
              onSelect={(id) => void openDetail(id)}
            />
          ) : (
            <ExpenseGroupSection
              key={UNGROUPED_KEY}
              title="Uncategorized"
              color={UNGROUPED_COLOR}
              categories={categories}
              currency={currency}
              onSelect={(id) => void openDetail(id)}
            />
          ))}
        </div>
      </div>

      <button
        className="quick-add-fab"
        onClick={() => setIsQuickAddOpen(true)}
        type="button"
        aria-label="Add expense"
      >
        <Plus className="h-6 w-6" />
      </button>

      {isQuickAddOpen ? (
        <QuickAddRecordModal
          categories={householdCategories}
          expenseGroups={(board?.groups ?? []).filter((group) => !group.is_retired)}
          expenseRows={(board?.categories ?? []).filter((category) => !category.is_retired && !(board?.groups ?? []).some((group) => group.id === category.expense_group_id && group.is_retired))}
          properties={properties}
          onClose={() => setIsQuickAddOpen(false)}
          onAdded={load}
          onAddCategory={() => {
            setIsQuickAddOpen(false)
            openGroupModal(null)
          }}
        />
      ) : null}

      {groupModal ? (
        <FormSheet
          className="quick-add-modal expense-group-modal"
          eyebrow="Expenses"
          title={editingGroup ? 'Edit category' : 'New category'}
          titleId="expense-group-title"
          onClose={() => setGroupModal(null)}
        >
          <form className="record-add-form" onSubmit={(event) => { event.preventDefault(); void saveGroup() }}>
            <OutlinedInput id={`${fieldId}-expensespage-1`} label="Name" leadingIcon={<Pencil aria-hidden="true" className="h-4 w-4" />} placeholder="Name" value={groupForm.name} onChange={(event) => setGroupForm({ ...groupForm, name: event.target.value })} />
            <div className="inline-field">
              <span>Color</span>
              <div className="flex flex-wrap gap-2 pt-1" role="radiogroup" aria-label="Category color">
                {GROUP_PALETTE.map((channels) => (
                  <button
                    aria-checked={groupForm.color === channels}
                    aria-label={`Color rgb(${channels})`}
                    className="h-7 w-7 rounded-full border-2 transition"
                    key={channels}
                    onClick={() => setGroupForm({ ...groupForm, color: channels })}
                    role="radio"
                    style={{
                      background: `rgb(${channels})`,
                      borderColor: groupForm.color === channels ? 'rgb(255 255 255 / 0.85)' : 'transparent',
                    }}
                    type="button"
                  />
                ))}
              </div>
            </div>
            {isGroupNotesOpen ? (
              <OutlinedTextarea id={`${fieldId}-expensespage-2`} label="Notes" leadingIcon={<StickyNote aria-hidden="true" className="h-4 w-4" />} placeholder="Notes" value={groupForm.notes} onChange={(event) => setGroupForm({ ...groupForm, notes: event.target.value })} />
            ) : (
              <div className="record-add-notes-toggle-row">
                <button className="record-add-notes-toggle" aria-controls={`${fieldId}-expensespage-2`} aria-expanded={false} onClick={() => setIsGroupNotesOpen(true)} type="button">
                  <Plus aria-hidden="true" className="h-4 w-4" />
                  Add Notes
                </button>
              </div>
            )}
            <div className="quick-add-actions">
              {editingGroup ? (
                <button className="button button--compact button--ghost" disabled={busy !== null} onClick={() => void setGroupRetired(editingGroup)} type="button">
                  {editingGroup.is_retired ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                  <span>{editingGroup.is_retired ? 'Unretire' : 'Retire'}</span>
                </button>
              ) : null}
              {editingGroup?.can_delete ? (
                <button
                  aria-label={`Delete category ${editingGroup.name}`}
                  className="button button--compact button--danger-ghost"
                  disabled={busy === 'expense-group-delete'}
                  onClick={() => void deleteGroup(editingGroup)}
                  type="button"
                >
                  <Trash2 className="h-4 w-4" />
                  <span>{busy === 'expense-group-delete' ? 'Deleting...' : 'Delete'}</span>
                </button>
              ) : null}
              <button className="button" disabled={busy === 'expense-group-save'} type="submit">
                <Save className="h-4 w-4" />
                <span>{busy === 'expense-group-save' ? 'Saving...' : 'Save category'}</span>
              </button>
            </div>
          </form>
        </FormSheet>
      ) : null}

      {addGroupModal ? (
        <FormSheet
          className="quick-add-modal expense-group-modal"
          eyebrow={`In ${addGroupModal.group.name}`}
          title="Add group"
          titleId="expense-add-group-title"
          onClose={() => setAddGroupModal(null)}
        >
          <form className="record-add-form" onSubmit={(event) => { event.preventDefault(); void saveNewGroup() }}>
            <OutlinedInput id={`${fieldId}-expensespage-3`} label="Name" leadingIcon={<Pencil aria-hidden="true" className="h-4 w-4" />} placeholder="Name" value={addGroupModal.name} onChange={(event) => setAddGroupModal({ ...addGroupModal, name: event.target.value })} />
            <div className="quick-add-actions">
              <button className="button" disabled={busy === 'expense-add-group-save'} type="submit">
                <Plus className="h-4 w-4" />
                <span>{busy === 'expense-add-group-save' ? 'Adding...' : 'Add group'}</span>
              </button>
            </div>
          </form>
        </FormSheet>
      ) : null}

      {detail ? (
        <ExpenseDetailModal
          key={detail.id}
          detail={detail}
          isUtilityGroup={Boolean(board?.categories.find((category) => category.id === detail.id)?.utility_property_id)}
          showForecast={showForecast}
          groups={board?.groups ?? []}
          currency={currency}
          onClose={() => setDetail(null)}
          onChanged={() => void refreshDetail(detail.id)}
          onDeleted={() => { setDetail(null); void load() }}
        />
      ) : null}
    </>
  )
}

function InheritedExpenseIcon() {
  return <Link2 aria-label="Inherited from a source" role="img" className="expense-inherited-icon"><title>Inherited from a source</title></Link2>
}

function ExpenseGroupSection({
  title,
  color,
  categories,
  currency,
  actions,
  onSelect,
  retired = false,
  inherited = false,
}: {
  title: string
  color: string
  categories: ExpenseCategorySummary[]
  currency: string
  actions?: React.ReactNode
  retired?: boolean
  inherited?: boolean
  onSelect: (categoryId: string) => void
}) {
  const monthly = categories.reduce((sum, category) => sum.plus(category.monthly_average), new Decimal(0)).toNumber()
  return (
    <SectionPanel
      className={`expense-group-panel${retired ? ' expense-group-panel--retired' : ''}`}
      title={
        <span className="expense-group-title">
          {color ? <i aria-hidden="true" className="inline-block h-3 w-3 rounded-full" style={{ background: `rgb(${color})` }} /> : null}
          <span className="expense-group-name">{title}</span>
          {inherited ? <InheritedExpenseIcon /> : null}
          {retired ? <small className="expense-retired-label">Retired</small> : null}
        </span>
      }
      actions={actions}
    >
      <small className="expense-group-monthly">{fmtMoney(monthly, currency)} / mo</small>
      {categories.length ? (
        <div className="detail-table">
          {categories.map((category) => (
            <button className={`detail-row detail-row--button${category.is_retired ? ' expense-row--retired' : ''}`} key={category.id} onClick={() => onSelect(category.id)} type="button">
              <span className="expense-category-label"><span>{category.name}</span>{category.is_source_linked ? <InheritedExpenseIcon /> : null}{category.is_retired ? <small className="expense-retired-label"> Retired</small> : null}</span>
              <strong>{fmtMoney(category.monthly_average, currency)} / mo</strong>
              <small>
                {category.entry_count} expenses · last {monthYear(category.last_entry_date)}
              </small>
            </button>
          ))}
        </div>
      ) : (
        <div className="chart-empty">No groups in this category yet</div>
      )}
    </SectionPanel>
  )
}

function ExpenseDetailModal({
  detail,
  isUtilityGroup,
  showForecast,
  groups,
  currency,
  onClose,
  onChanged,
  onDeleted,
}: {
  detail: ExpenseCategoryDetail
  isUtilityGroup: boolean
  showForecast: boolean
  groups: ExpenseGroup[]
  currency: string
  onClose: () => void
  onChanged: () => void
  onDeleted: () => void
}) {
  const fieldId = useId()
  const { token, setError, setMessage } = useSession()
  const [busy, setBusy] = useState<string | null>(null)
  const [isEditMode, setIsEditMode] = useState(false)
  const [name, setName] = useState(detail.name)
  const [groupId, setGroupId] = useState(detail.expense_group_id ?? '')
  const [entryForm, setEntryForm] = useState<EntryForm>(() => emptyEntryForm())
  const [isAddingEntry, setIsAddingEntry] = useState(false)
  const [editingEntry, setEditingEntry] = useState<ExpenseEntry | null>(null)
  const [actionEntry, setActionEntry] = useState<ExpenseEntry | null>(null)
  const [entryError, setEntryError] = useState('')
  // null = normal browsing; a Set (possibly empty) = selection mode is active.
  const [selectedIds, setSelectedIds] = useState<Set<string> | null>(null)
  const selectionMode = selectedIds !== null
  const today = todayKey()
  const visibleEntries = useMemo(
    () => detail.entries.filter((entry) => showForecast || !entry.entry_date || entry.entry_date <= today),
    [detail.entries, showForecast, today],
  )
  const editableEntries = visibleEntries.filter((entry) => entry.data_source !== 'loan_schedule' && entry.data_source !== 'utility_bill')

  const trendPoints = useMemo(
    () => detail.monthly_totals.map((point) => ({ period: point.period, value: point.value, projected: false })),
    [detail.monthly_totals],
  )
  const total = detail.monthly_totals.reduce((sum, point) => sum + point.value, 0)
  // Amortize over the full first-to-last calendar span, not just months that
  // had entries — mirrors the board's monthly_average semantics.
  const monthlyAverage = useMemo(() => {
    if (!detail.monthly_totals.length) return 0
    const first = detail.monthly_totals[0].period.slice(0, 7)
    const last = detail.monthly_totals[detail.monthly_totals.length - 1].period.slice(0, 7)
    const [firstYear, firstMonth] = first.split('-').map(Number)
    const [lastYear, lastMonth] = last.split('-').map(Number)
    const span = Math.max(1, (lastYear - firstYear) * 12 + (lastMonth - firstMonth) + 1)
    return total / span
  }, [detail.monthly_totals, total])
  const currentMonthKey = todayKey().slice(0, 7)
  const thisMonth = detail.monthly_totals.find((point) => point.period.slice(0, 7) === currentMonthKey)?.value ?? 0
  const highestMonth = detail.monthly_totals.reduce(
    (best, point) => (point.value > best.value ? point : best),
    { period: '', value: 0 },
  )
  const vsAverage = monthlyAverage > 0 ? (thisMonth - monthlyAverage) / monthlyAverage : null
  const settingsChanged = name.trim() !== detail.name || groupId !== (detail.expense_group_id ?? '')

  const monthGroups = useMemo(() => {
    const byMonth = new Map<string, ExpenseEntry[]>()
    for (const entry of visibleEntries) {
      const key = entry.entry_date ? entry.entry_date.slice(0, 7) : 'undated'
      byMonth.set(key, [...(byMonth.get(key) ?? []), entry])
    }
    return [...byMonth.entries()]
      .sort(([left], [right]) => (left === 'undated' ? 1 : right === 'undated' ? -1 : right.localeCompare(left)))
      .map(([key, entries]) => ({
        key,
        label: key === 'undated'
          ? 'No date'
          : new Date(`${key}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
        total: entries.reduce((sum, entry) => sum + entry.amount, 0),
        entries: [...entries].sort(
          (left, right) => (right.entry_date ?? '').localeCompare(left.entry_date ?? '') || right.amount - left.amount,
        ),
      }))
  }, [visibleEntries])

  /* Imported entries carry auto-generated descriptions ("Food — 2026-06",
     "Food — Kebab — 2021-06"). The group and month are already visible
     from context, so reduce the description to just the informative middle
     ("Kebab"). The transaction row falls back to the group name when no
     informative description remains. */
  function entryLabel(entry: ExpenseEntry): string | null {
    let label = entry.description.trim()
    const prefix = `${detail.name} — `.toLowerCase()
    if (label.toLowerCase().startsWith(prefix)) label = label.slice(prefix.length).trim()
    label = label.replace(/\s*—\s*\d{4}-\d{2}(-\d{2})?$/, '').trim()
    if (!label || /^\d{4}-\d{2}(-\d{2})?$/.test(label) || label.toLowerCase() === detail.name.toLowerCase()) return null
    return label
  }

  function cancelEdit() {
    setName(detail.name)
    setGroupId(detail.expense_group_id ?? '')
    setIsEditMode(false)
  }

  async function saveSettings() {
    if (!token || !name.trim()) return
    setBusy('expense-category-save')
    try {
      await api.updateExpenseCategory(token, detail.id, {
        name,
        expense_group_id: groupId || null,
        sort_order: detail.sort_order,
      })
      setMessage('Group updated.')
      setIsEditMode(false)
      onChanged()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Group update failed.')
    } finally {
      setBusy(null)
    }
  }

  async function setCategoryRetired() {
    if (!token) return
    setBusy('expense-category-retire')
    try {
      await api.updateExpenseCategory(token, detail.id, {
        name: detail.name,
        expense_group_id: detail.expense_group_id ?? null,
        sort_order: detail.sort_order,
        is_retired: !detail.is_retired,
      })
      setMessage(detail.is_retired ? 'Group unretired.' : 'Group retired.')
      onDeleted()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Group retirement failed.')
    } finally {
      setBusy(null)
    }
  }

  async function deleteCategory() {
    if (!token || !detail.can_delete) return
    if (!window.confirm(`Delete group "${detail.name}"? Recorded expenses keep their history but become ungrouped.`)) return
    setBusy('expense-category-delete')
    try {
      await api.deleteExpenseCategory(token, detail.id)
      setMessage('Group deleted.')
      onDeleted()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Group delete failed.')
    } finally {
      setBusy(null)
    }
  }

  async function addEntry() {
    if (!token) return
    const amount = Number(entryForm.amount)
    if (!Number.isFinite(amount) || amount <= 0 || !entryForm.entry_date) {
      setError('A positive amount and a date are required.')
      return
    }
    setBusy('expense-entry-save')
    try {
      await api.createExpense(token, {
        // The API requires a description, but entries here usually just carry
        // a value into the category, so fall back to the category name.
        description: entryForm.description.trim() || detail.name,
        amount,
        entry_date: entryForm.entry_date,
        owner_scope: entryForm.owner_scope,
        category_name: detail.name,
        notes: entryForm.notes,
      })
      setIsAddingEntry(false)
      setEntryForm(emptyEntryForm())
      setMessage('Expense saved.')
      onChanged()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Expense create failed.')
    } finally {
      setBusy(null)
    }
  }

  async function saveEntry() {
    if (!token || !editingEntry) return
    const amount = Number(entryForm.amount)
    if (!Number.isFinite(amount) || amount <= 0 || !entryForm.entry_date) {
      setEntryError('A positive amount and a date are required.')
      return
    }
    setEntryError('')
    setBusy('expense-entry-save')
    try {
      await api.updateExpenseEntry(token, editingEntry.id, {
        description: entryForm.description.trim() || detail.name,
        amount,
        entry_date: entryForm.entry_date,
        owner_scope: entryForm.owner_scope,
        notes: entryForm.notes,
        category_id: editingEntry.category_id,
        subcategory_id: editingEntry.subcategory_id,
      })
      setEditingEntry(null)
      setActionEntry(null)
      setMessage('Expense updated.')
      onChanged()
    } catch (nextError) {
      setEntryError(nextError instanceof Error ? nextError.message : 'Expense update failed.')
    } finally {
      setBusy(null)
    }
  }

  async function deleteEntry(entry: ExpenseEntry) {
    if (!token) return
    const label = entryLabel(entry)
    if (!window.confirm(`Delete this ${label ? `"${label}" ` : ''}expense of ${fmtMoney(entry.amount, currency)}?`)) return
    setEntryError('')
    setBusy('expense-entry-delete')
    try {
      await api.deleteExpenseEntry(token, entry.id)
      setActionEntry(null)
      setMessage('Expense deleted.')
      onChanged()
    } catch (nextError) {
      setEntryError(nextError instanceof Error ? nextError.message : 'Expense delete failed.')
    } finally {
      setBusy(null)
    }
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) => {
      if (!current) return current
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function deleteSelected() {
    if (!token || !selectedIds?.size) return
    const count = selectedIds.size
    if (!window.confirm(`Delete ${count} ${count === 1 ? 'expense' : 'expenses'}?`)) return
    setBusy('expense-entry-delete')
    try {
      const ids = [...selectedIds]
      for (let index = 0; index < ids.length; index += 8) {
        await Promise.all(ids.slice(index, index + 8).map((id) => api.deleteExpenseEntry(token, id)))
      }
      setSelectedIds(null)
      setMessage(`${count} ${count === 1 ? 'expense' : 'expenses'} deleted.`)
      onChanged()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Bulk delete failed.')
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  function startEditEntry(entry: ExpenseEntry) {
    setIsAddingEntry(false)
    setEditingEntry(entry)
    setEntryForm({
      description: entry.description,
      amount: String(entry.amount),
      entry_date: entry.entry_date ?? todayKey(),
      owner_scope: entry.owner_scope,
      notes: entry.notes,
    })
  }

  const entryEditor = (onSubmit: () => void, onCancel: () => void, submitLabel: string) => (
    <form
      className="record-add-form"
      onSubmit={(event) => { event.preventDefault(); onSubmit() }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <OutlinedInput id={`${fieldId}-expensespage-3`} label="Amount" leadingIcon={<Coins aria-hidden="true" className="h-4 w-4" />} trailing={currencySymbol(currency)} autoFocus
              autoComplete="off"
              inputMode="decimal"
              placeholder="Amount"
              value={formatAmountDraft(entryForm.amount)}
              onChange={(event) => setEntryForm({ ...entryForm, amount: parseAmountDraft(event.target.value) })} />
        <OutlinedInput id={`${fieldId}-expensespage-4`} label="Date" leadingIcon={<Calendar aria-hidden="true" className="h-4 w-4" />} type="date" value={entryForm.entry_date} onChange={(event) => setEntryForm({ ...entryForm, entry_date: event.target.value })} />
        <OutlinedInput id={`${fieldId}-expensespage-5`} label="Description (optional)" leadingIcon={<Pencil aria-hidden="true" className="h-4 w-4" />} hint="Only for unusual expenses" value={entryForm.description} onChange={(event) => setEntryForm({ ...entryForm, description: event.target.value })} />
        <OutlinedNativeSelect id={`${fieldId}-expensespage-6`} label="Owner" leadingIcon={<Users aria-hidden="true" className="h-4 w-4" />} value={entryForm.owner_scope} onChange={(event) => setEntryForm({ ...entryForm, owner_scope: event.target.value as OwnershipScope })}>
          <option value="joint">Joint</option>
          <option value="self">Self</option>
          <option value="spouse">Spouse</option>
        </OutlinedNativeSelect>
      </div>
      <OutlinedInput id={`${fieldId}-expensespage-7`} label="Notes" leadingIcon={<StickyNote aria-hidden="true" className="h-4 w-4" />} placeholder="Notes" value={entryForm.notes} onChange={(event) => setEntryForm({ ...entryForm, notes: event.target.value })} />
      <div className="quick-add-actions">
        <button className="button button--ghost" onClick={onCancel} type="button">Cancel</button>
        <button className="button" disabled={busy === 'expense-entry-save'} type="submit">
          <Save className="h-4 w-4" />
          <span>{busy === 'expense-entry-save' ? 'Saving...' : submitLabel}</span>
        </button>
      </div>
    </form>
  )

  return (
    <Modal
      className="record-detail-modal"
      title={
        <span className="expense-detail-title">
          <span className="expense-detail-name">{detail.name}</span>
          {detail.is_source_linked ? <InheritedExpenseIcon /> : null}
        </span>
      }
      titleId="expense-detail-title"
      onClose={onClose}
      actions={
        <div className="asset-detail-actions expense-detail-actions">
          {!isEditMode && !isUtilityGroup ? (
            <DetailActionsMenu label="Group actions" actions={[
              { label: 'Edit group', onClick: () => setIsEditMode(true) },
              { label: detail.is_retired ? 'Unretire group' : 'Retire group', onClick: () => void setCategoryRetired(), disabled: busy !== null },
            ]} />
          ) : null}
          <button aria-label="Close group details" className="record-add-close" onClick={onClose} title="Close" type="button">
            <X className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <div className="page-stack">
        {isEditMode ? (
          <div className="expense-settings-editor">
            <div className="grid gap-3 sm:grid-cols-2">
              <OutlinedInput id={`${fieldId}-expensespage-8`} label="Name" leadingIcon={<Pencil aria-hidden="true" className="h-4 w-4" />} placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} />
              <OutlinedNativeSelect id={`${fieldId}-expensespage-9`} label="Category" leadingIcon={<Folder aria-hidden="true" className="h-4 w-4" />} value={groupId} onChange={(event) => setGroupId(event.target.value)}>
                <option value="">Uncategorized</option>
                {groups.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
              </OutlinedNativeSelect>
            </div>
            <div className="expense-settings-actions">
              <button className="button button--compact button--ghost" disabled={busy !== null} onClick={() => void setCategoryRetired()} type="button">
                {detail.is_retired ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                <span>{detail.is_retired ? 'Unretire' : 'Retire'}</span>
              </button>
              {detail.can_delete ? (
                <button className="button button--compact button--danger-ghost" disabled={busy === 'expense-category-delete'} onClick={() => void deleteCategory()} type="button">
                  <Trash2 className="h-4 w-4" />
                  <span>{busy === 'expense-category-delete' ? 'Deleting...' : 'Delete'}</span>
                </button>
              ) : null}
              <button className="button button--compact button--ghost" onClick={cancelEdit} type="button">
                Cancel
              </button>
              <button className="button button--compact" disabled={!settingsChanged || busy === 'expense-category-save'} onClick={() => void saveSettings()} type="button">
                <Save className="h-4 w-4" />
                <span>{busy === 'expense-category-save' ? 'Saving...' : 'Save'}</span>
              </button>
            </div>
          </div>
        ) : null}

        {/* Cell order matters: on narrow viewports this grid collapses to a
            2x2 layout whose first row pairs the headline totals (average +
            lifetime) and the second row the month-scoped figures. */}
        <div className="chart-stat-grid chart-stat-grid--compact expense-detail-stats" aria-label="Group summary">
          <div>
            <span>Monthly average</span>
            <strong>{fmtMoney(monthlyAverage, currency)}</strong>
          </div>
          <div>
            <span>Total expenses</span>
            <strong>{fmtMoney(total, currency)}</strong>
          </div>
          <div>
            <span>This month</span>
            <strong>
              {fmtMoney(thisMonth, currency)}
              {vsAverage !== null ? (
                <small className={vsAverage <= 0 ? 'is-positive' : 'is-negative'}>
                  {vsAverage > 0 ? '+' : ''}{Math.round(vsAverage * 100)}% <span className="vs-avg-label">vs avg</span>
                </small>
              ) : null}
            </strong>
          </div>
          <div>
            <span>Highest month</span>
            <strong>
              {fmtMoney(highestMonth.value, currency)}
              {highestMonth.period ? <small>{monthYear(`${highestMonth.period.slice(0, 7)}-01`)}</small> : null}
            </strong>
          </div>
        </div>

        {detail.subcategories.length ? (
          <div className="flex flex-wrap items-center gap-2 text-sm text-ledger-mist">
            <span>Subgroups:</span>
            {detail.subcategories.map((subcategory) => (
              <span className="rounded-full bg-ledger-surface-low px-3 py-1" key={subcategory.id}>{subcategory.name}</span>
            ))}
          </div>
        ) : null}

        {trendPoints.length ? (
          <div className="expense-value-trend">
            <ValueTrendChart points={trendPoints} currency={currency} />
          </div>
        ) : null}

        <SectionPanel
          title="Expenses"
          eyebrow={`${visibleEntries.length} ${visibleEntries.length === 1 ? 'expense' : 'expenses'}`}
          actions={
            selectionMode ? (
              <div className="entry-selection-actions">
                <span className="entry-selection-count">{selectedIds.size} selected</span>
                <button
                  className="button button--compact button--ghost"
                  onClick={() =>
                    setSelectedIds(
                      selectedIds.size === editableEntries.length
                        ? new Set()
                        : new Set(editableEntries.map((entry) => entry.id)),
                    )
                  }
                  type="button"
                >
                  {selectedIds.size === editableEntries.length ? 'Clear all' : 'Select all'}
                </button>
                <button
                  className="button button--compact button--danger-ghost"
                  disabled={!selectedIds.size || busy === 'expense-entry-delete'}
                  onClick={() => void deleteSelected()}
                  type="button"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>
                    {busy === 'expense-entry-delete'
                      ? 'Deleting...'
                      : `Delete${selectedIds.size ? ` (${selectedIds.size})` : ''}`}
                  </span>
                </button>
                <button
                  aria-label="Exit selection"
                  className="button button--compact button--ghost"
                  onClick={() => setSelectedIds(null)}
                  type="button"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : isUtilityGroup ? null : (
              <button
                className="button button--compact"
                onClick={() => { setEditingEntry(null); setEntryForm(emptyEntryForm()); setIsAddingEntry((value) => !value) }}
                type="button"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add expense</span>
              </button>
            )
          }
        >
          {isAddingEntry ? entryEditor(() => void addEntry(), () => setIsAddingEntry(false), 'Save expense') : null}
          {monthGroups.length ? (
            <div className="entry-ledger" role="region" aria-label="Expenses transaction history">
              {monthGroups.map((monthGroup) => (
                <div className="entry-month" key={monthGroup.key}>
                  <div className="entry-month-header">
                    <h3 className="entry-month-label">{monthGroup.label}</h3>
                    <small>{monthGroup.entries.length} {monthGroup.entries.length === 1 ? 'expense' : 'expenses'}</small>
                    {monthGroup.entries.length > 1 ? <strong>{fmtMoney(monthGroup.total, currency)}</strong> : null}
                  </div>
                  {monthGroup.entries.map((entry) => (
                    <ExpenseHistoryRow
                      key={entry.id}
                      entry={entry}
                      title={entry.data_source === 'loan_schedule' ? 'Scheduled loan payment' : entryLabel(entry) || detail.name}
                      currency={currency}
                      selected={selectedIds?.has(entry.id) ?? false}
                      selectionMode={selectionMode}
                      onOpen={() => { setEntryError(''); setEditingEntry(null); setActionEntry(entry) }}
                      onSelect={() => {
                        if (selectionMode) toggleSelected(entry.id)
                        else { setIsAddingEntry(false); setSelectedIds(new Set([entry.id])) }
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <div className="chart-empty">No entries recorded yet</div>
          )}
        </SectionPanel>
      </div>
      {actionEntry ? (
        <Modal
          title={editingEntry ? 'Edit expense' : 'Expense actions'}
          className="expense-entry-sheet"
          backdropClassName="expense-entry-backdrop"
          onClose={() => { setActionEntry(null); setEditingEntry(null) }}
        >
          {entryError ? <p className="notice notice--error" role="alert">{entryError}</p> : null}
          {editingEntry ? entryEditor(() => void saveEntry(), () => setEditingEntry(null), 'Update expense') : (
            <div className="expense-entry-sheet-body">
              <strong>{entryLabel(actionEntry) || detail.name}</strong>
              <p>{fmtMoney(actionEntry.amount, currency)}{actionEntry.notes ? ' · ' + actionEntry.notes : ''}</p>
              {actionEntry.data_source === 'loan_schedule' ? <p>Scheduled loan payments are read-only.</p> : actionEntry.data_source === 'utility_bill' ? <p>Utility bills are read-only here. Amounts and meter readings are maintained in the property's utility values.</p> : (
                <div className="expense-entry-sheet-actions">
                  <button className="button button--ghost" type="button" onClick={() => startEditEntry(actionEntry)}><Pencil className="h-4 w-4" />Edit expense</button>
                  <button className="button button--danger-ghost" type="button" disabled={busy === 'expense-entry-delete'} onClick={() => void deleteEntry(actionEntry)}><Trash2 className="h-4 w-4" />{busy === 'expense-entry-delete' ? 'Deleting...' : 'Delete expense'}</button>
                  <button className="button button--ghost" type="button" onClick={() => { setSelectedIds(new Set([actionEntry.id])); setActionEntry(null) }}>Select expenses</button>
                </div>
              )}
            </div>
          )}
        </Modal>
      ) : null}
    </Modal>
  )
}
