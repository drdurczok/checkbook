import { useState } from 'react'
import { X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { PAYDAY_PLANNER_PATH } from '../app/routes'
import { EmptyState, SectionPanel } from '../components/panel'
import { AsyncState } from '../components/ui/AsyncState'
import { plannerAmount, plannerDifferenceTone, plannerMoney } from '../features/payday-planner/model'
import { usePaydayPlanner } from '../features/payday-planner/queries'
import { usePlannerMonth, usePlannerMonthHeader } from '../features/payday-planner/usePlannerMonth'
import { useSession } from '../lib/session'
import '../styles/features/payday-planner.css'

const VIEWS = [{ key: 'comparison', title: 'Planned vs Actual' }, { key: 'unplanned', title: 'Unplanned Actual' }] as const

export function PaydayPlannerAnalysisPage() {
  const { token } = useSession()
  const { month, setMonth } = usePlannerMonth()
  const query = usePaydayPlanner(token, month)
  const [view, setView] = useState<'comparison' | 'unplanned'>('comparison')
  const data = query.data
  const selectedMonth = month ?? data?.month ?? ''
  usePlannerMonthHeader(selectedMonth, setMonth)
  return <div className="payday-planner planner-analysis page-stack">
    <div className="planner-analysis__toolbar">
        <div className="view-toggle planner-analysis__tabs" aria-label="Plan analysis view" role="tablist">
          {VIEWS.map((item) => <button key={item.key} id={`planner-${item.key}-tab`} aria-controls={`planner-${item.key}-panel`} aria-selected={view === item.key} className={view === item.key ? 'is-active' : ''} role="tab" tabIndex={view === item.key ? 0 : -1} type="button" onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next = event.key === 'Home' ? 'comparison' : event.key === 'End' ? 'unplanned' : view === 'comparison' ? 'unplanned' : 'comparison'
            setView(next)
            document.getElementById(`planner-${next}-tab`)?.focus()
          }} onClick={() => setView(item.key)}>{item.title}</button>)}
        </div>
      <Link className="planner-analysis__close" aria-label="Close analysis" title="Close analysis" to={`${PAYDAY_PLANNER_PATH}${selectedMonth ? `?month=${selectedMonth}` : ''}`}><X size={18} aria-hidden="true" /></Link>
    </div>
    <AsyncState loading={query.isPending} error={query.error?.message} empty={!data} loadingLabel="Loading plan analysis..." emptyTitle="No analysis available" emptyBody="Choose a month to get started.">
      {data ? <>
        <div id={`planner-${view}-panel`} role="tabpanel" aria-labelledby={`planner-${view}-tab`}>
          <SectionPanel className="planner-analysis__panel" title={VIEWS.find((item) => item.key === view)?.title}>
            {view === 'comparison' ? data.allocations.length ? <div className="planner-table-wrap"><table className="planner-comparison"><thead><tr><th>Allocation</th><th>Planned</th><th>Actual</th><th>Difference</th></tr></thead><tbody>{data.allocations.map((item) => <tr key={item.id}><th scope="row">{item.title}</th><td>{plannerAmount(item.amount)}</td><td>{item.actual_amount === null ? 'Not matched' : plannerAmount(item.actual_amount)}</td><td>{item.difference === null ? '-' : plannerAmount(item.difference)}{item.percentage === null ? null : <span className={`planner-difference ${plannerDifferenceTone(item.difference, item.percentage)}`}> ({item.percentage}%)</span>}</td></tr>)}</tbody></table></div> : <EmptyState title="Nothing planned yet" body="Add allocations in the planner to compare them with recorded expenses." /> : <>
              <p className="muted">Actual expenses without a matching planned allocation: {plannerMoney(data.unplanned_actual_total, data.currency)}</p>
              {data.unplanned_actuals.length ? <ul className="planner-unplanned">{data.unplanned_actuals.map((item, index) => <li key={`${item.category_id}-${item.subcategory_id}-${index}`}><span>{[item.category_name, item.subcategory_name].filter(Boolean).join(' / ') || 'Uncategorized'}</span><strong>{plannerMoney(item.amount, data.currency)}</strong></li>)}</ul> : <p className="muted">No unmatched actual expenses.</p>}
            </>}
          </SectionPanel>
        </div>
      </> : null}
    </AsyncState>
  </div>
}
