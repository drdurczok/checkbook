import { useCallback } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { MonthInput } from '../../components/ui/NativeControls'
import { useHeaderSlot } from '../../lib/header-slot'
import { shiftPlannerMonth } from './model'

export function usePlannerMonth() {
  const [params, setParams] = useSearchParams()
  const value = params.get('month') ?? ''
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : undefined
  const setMonth = useCallback((next: string) => {
    setParams((previous) => { const updated = new URLSearchParams(previous); updated.set('month', next); return updated })
  }, [setParams])
  return { month, setMonth }
}

export function usePlannerMonthHeader(selectedMonth: string, setMonth: (month: string) => void, pending = false) {
  useHeaderSlot(
    <nav className="planner-month" aria-label="Plan month">
      <button className="planner-month__arrow" title="Previous month" aria-label="Previous month" disabled={!selectedMonth || pending} onClick={() => setMonth(shiftPlannerMonth(selectedMonth, -1))}><ChevronLeft size={18} /></button>
      <label className="planner-month__picker">
        <span>{selectedMonth ? new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${selectedMonth}-01T00:00:00Z`)) : 'Loading...'}</span><CalendarDays size={18} aria-hidden="true" />
        <MonthInput aria-label="Month and year" value={selectedMonth} onChange={(event) => { if (/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) setMonth(event.target.value) }} />
      </label>
      <button className="planner-month__arrow" title="Next month" aria-label="Next month" disabled={!selectedMonth || pending} onClick={() => setMonth(shiftPlannerMonth(selectedMonth, 1))}><ChevronRight size={18} /></button>
    </nav>, [selectedMonth, pending, setMonth],
  )
}
