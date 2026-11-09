import { useState } from 'react'
import { Plus, Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import { PAYDAY_PLANNER_ANALYZE_PATH } from '../app/routes'
import { Modal } from '../components/Modal'
import { SectionPanel } from '../components/panel'
import { AsyncState } from '../components/ui/AsyncState'
import { AllocationCard } from '../features/payday-planner/AllocationCard'
import type { AllocationInput, PlannerAllocation, PlannerSection } from '../contracts/payday-planner'
import { AllocationEditor } from '../features/payday-planner/AllocationEditor'
import { PlannerSummary } from '../features/payday-planner/PlannerSummary'
import { plannerAmount } from '../features/payday-planner/model'
import { usePaydayPlanner, usePlannerMutation } from '../features/payday-planner/queries'
import { api } from '../lib/api'
import { useSession } from '../lib/session'
import { usePlannerMonth, usePlannerMonthHeader } from '../features/payday-planner/usePlannerMonth'
import '../styles/features/payday-planner.css'

const SECTIONS: { key: PlannerSection; title: string }[] = [
  { key: 'mandatory', title: 'Mandatory Payments' },
  { key: 'monthly', title: 'Additional Payments' },
  { key: 'flexible', title: 'Flexible Allocations' },
]
const emptyAllocation = (section: PlannerSection): AllocationInput => ({ title: '', section, kind: section === 'flexible' ? 'other' : 'expense', category_id: null, subcategory_id: null, amount: '0.00', notes: '' })
type Editor = { type: 'allocation'; initial: AllocationInput; id?: string; completed?: boolean; templateId?: string | null }

export function PaydayPlannerPage() {
  const { token, setError } = useSession()
  const { month, setMonth } = usePlannerMonth()
  const query = usePaydayPlanner(token, month)
  const mutation = usePlannerMutation(token)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [deleting, setDeleting] = useState<{ id: string; title: string; template: boolean } | null>(null)
  const data = query.data
  const selectedMonth = month ?? data?.month ?? ''
  const run = async (operation: () => Promise<unknown>) => { await mutation.mutateAsync(operation) }
  const report = (operation: () => Promise<unknown>) => { void run(operation).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not save planner change.')) }
  const editAllocation = (item: PlannerAllocation) => setEditor({ type: 'allocation', initial: item, id: item.id, completed: item.completed, templateId: item.template_id })
  const saveEditor = async (value: AllocationInput) => {
    if (!editor || !token) return
    await run(() => editor.id ? api.updatePaydayAllocation(token, editor.id, { ...value, month: selectedMonth, completed: editor.completed ?? false }) : api.createPaydayAllocation(token, { ...value, month: selectedMonth }))
    if (!editor.id) setEditor(null)
  }
  usePlannerMonthHeader(selectedMonth, setMonth, mutation.isPending)
  return <div className="payday-planner">
    <AsyncState loading={query.isPending} error={query.error?.message} empty={!data} loadingLabel="Loading monthly plan..." emptyTitle="No plan available" emptyBody="Choose a month to get started.">
      {data ? <>
        <PlannerSummary income={data.income} planned={data.total_allocated} remaining={data.remaining} completed={data.completed_total} currency={data.currency} money={plannerAmount} />
        {SECTIONS.map((section) => {
          const items = data.allocations.filter((item) => item.section === section.key).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
          const nextPosition = Math.min(2147483647, items.reduce((highest, item) => Math.max(highest, item.position ?? 0), 0) + 1)
          return <SectionPanel key={section.key} className="card planner-section" title={section.title} actions={<button className="planner-section__add" type="button" aria-label="Add" title={`Add to ${section.title}`} disabled={mutation.isPending} onClick={() => setEditor({ type: 'allocation', initial: { ...emptyAllocation(section.key), position: nextPosition } })}><Plus size={16} aria-hidden="true" /></button>}>
            {!items.length ? null : <ul className="planner-items">{items.map((item) => <AllocationCard key={item.id} item={item} amount={plannerAmount(item.amount)} subtitle={item.expense_group_name ?? undefined} pending={mutation.isPending} onComplete={() => report(() => api.updatePaydayAllocation(token, item.id, { ...item, month: selectedMonth, completed: !item.completed }))} onEdit={() => editAllocation(item)} />)}</ul>}
          </SectionPanel>
        })}
        <div className="planner-toolbar"><Link className="planner-analyze" to={`${PAYDAY_PLANNER_ANALYZE_PATH}?month=${selectedMonth}`}><Sparkles size={18} aria-hidden="true" />Analyze</Link></div>

      </> : null}
    </AsyncState>
    {editor && token ? <AllocationEditor key={`${editor.type}-${editor.id ?? 'new'}`} token={token} title={`${editor.id ? 'Edit' : 'Add'} Allocation`} allocationSelection initialRecurring={Boolean(editor.templateId)} initial={editor.initial} existing={Boolean(editor.id)} allowOrphanSnapshot pending={mutation.isPending} month={selectedMonth} currency={data?.currency} onSave={saveEditor} onDelete={editor.id ? () => { if (!editor.id) return; setDeleting({ id: editor.id, title: editor.initial.title, template: false }); setEditor(null) } : undefined} onClose={() => setEditor(null)} /> : null}
    {deleting ? <Modal className="planner-confirm" title={`Delete ${deleting.title}?`} onClose={() => { if (!mutation.isPending) setDeleting(null) }}><div className="planner-form"><p>{deleting.template ? 'Existing monthly snapshots will remain unchanged.' : 'Only this monthly allocation will be removed. Recorded expenses are not changed.'}</p><button className="button" disabled={mutation.isPending} onClick={() => report(async () => { await (deleting.template ? api.deletePaydayTemplate(token ?? '', deleting.id) : api.deletePaydayAllocation(token ?? '', deleting.id)); setDeleting(null) })}>Confirm delete</button></div></Modal> : null}
  </div>
}
