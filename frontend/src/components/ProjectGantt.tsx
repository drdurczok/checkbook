import { useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { FolderKanban } from 'lucide-react'
import { fmtMoney } from '../lib/format'
import { PROJECT_STATUS_LABELS, projectColorKey, projectColorValue } from '../lib/projects'
import type { AssetSummary, ProjectStatus } from '../types'

const MS_PER_DAY = 86_400_000
/** Logical window widths (in months) the slider snaps between. */
const ZOOM_LEVELS = [1, 2, 3, 6, 12, 24, 36]

const parseDate = (value: string): Date => {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, (month || 1) - 1, day || 1)
}
const startOfMonth = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1)
const addMonths = (date: Date, count: number) => new Date(date.getFullYear(), date.getMonth() + count, 1)
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const tickLabel = (date: Date) => date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })

type Scheduled = {
  project: AssetSummary
  start: Date
  end: Date
  status: ProjectStatus
}

/**
 * Timeline view of projects. Each dated project is a bar on a month axis. A date
 * ruler carries a glass "magnifier" window: drag it to pan (in half-window steps,
 * so views overlap) and drag its handles to snap the width to logical zoom levels.
 * Zoom is tracked in months; the window position is tracked in days so a
 * month-wide window can slide roughly fortnightly.
 *
 * Returns the ruler (`slider`) and the chart (`content`) separately so the host
 * can place the slider in a section header while the chart stays in the body —
 * both share one window state because the hook is called once.
 */
export function useProjectGantt({ projects, currency, onOpenProject }: {
  projects: AssetSummary[]
  currency: string
  onOpenProject: (project: AssetSummary) => void
}): { slider: ReactNode; content: ReactNode; sliderState: string } {
  const { scheduled, undated, fullStart, totalMonths } = useMemo(() => {
    const scheduled: Scheduled[] = []
    const undated: AssetSummary[] = []
    for (const project of projects) {
      const rawStart = project.started_on || project.ended_on
      const rawEnd = project.ended_on || project.started_on
      if (!rawStart || !rawEnd) {
        undated.push(project)
        continue
      }
      let start = parseDate(rawStart)
      let end = parseDate(rawEnd)
      if (end < start) {
        ;[start, end] = [end, start]
      }
      scheduled.push({ project, start, end, status: project.derived_status ?? project.status ?? 'planned' })
    }
    scheduled.sort((a, b) => a.start.getTime() - b.start.getTime())
    if (!scheduled.length) {
      return { scheduled, undated, fullStart: null as Date | null, totalMonths: 0 }
    }
    let minDate = scheduled[0].start
    let maxDate = scheduled[0].end
    for (const item of scheduled) {
      if (item.start < minDate) minDate = item.start
      if (item.end > maxDate) maxDate = item.end
    }
    const fullStart = startOfMonth(minDate)
    const fullEnd = addMonths(startOfMonth(maxDate), 1)
    const totalMonths = (fullEnd.getFullYear() - fullStart.getFullYear()) * 12 + (fullEnd.getMonth() - fullStart.getMonth())
    return { scheduled, undated, fullStart, totalMonths }
  }, [projects])

  const levels = useMemo(() => {
    const list = ZOOM_LEVELS.filter((level) => level < totalMonths)
    if (totalMonths > 0 && (!list.length || list[list.length - 1] !== totalMonths)) {
      list.push(totalMonths)
    }
    return list
  }, [totalMonths])

  // Zoom is held in months (snapped to levels); the position is held in days so
  // the window can slide finer than a whole month. 0 length = "show everything".
  const [winLenMonths, setWinLenMonths] = useState(0)
  const [winStartDays, setWinStartDays] = useState(0)
  const trackRef = useRef<HTMLDivElement | null>(null)

  const snapLen = (len: number) =>
    levels.reduce((best, level) => (Math.abs(level - len) <= Math.abs(best - len) ? level : best), levels[0] ?? len)

  const fullStartMs = fullStart?.getTime() ?? 0
  const fullEnd = fullStart ? addMonths(fullStart, totalMonths) : new Date()
  const fullSpanDays = fullStart ? (fullEnd.getTime() - fullStartMs) / MS_PER_DAY : 1
  const pctFull = (date: Date) => ((date.getTime() - fullStartMs) / (fullSpanDays * MS_PER_DAY)) * 100

  const effLenMonths = clamp(winLenMonths || totalMonths, levels[0] ?? 1, totalMonths || 1)
  const winLenDays = totalMonths > 0 ? (effLenMonths / totalMonths) * fullSpanDays : fullSpanDays
  const effStartDays = clamp(winStartDays, 0, Math.max(0, fullSpanDays - winLenDays))

  // Signal the host can pass as a header-slot dependency so the topbar re-renders
  // the slider as the window pans/zooms.
  const sliderState = `${totalMonths}|${Math.round(effStartDays)}|${effLenMonths}`
  const windowStart = new Date(fullStartMs + effStartDays * MS_PER_DAY)
  const windowEnd = new Date(fullStartMs + (effStartDays + winLenDays) * MS_PER_DAY)
  const windowMs = winLenDays * MS_PER_DAY || 1
  const pct = (date: Date) => ((date.getTime() - windowStart.getTime()) / windowMs) * 100

  const winLeftPct = pctFull(windowStart)
  const winRightPct = pctFull(windowEnd)

  // Month-start ticks that fall inside the visible window.
  const winMonths: Date[] = []
  if (fullStart) {
    let cursor = startOfMonth(windowStart)
    if (cursor < windowStart) cursor = addMonths(cursor, 1)
    for (; cursor < windowEnd; cursor = addMonths(cursor, 1)) {
      winMonths.push(cursor)
    }
  }
  const tickStep = winMonths.length > 36 ? 6 : winMonths.length > 18 ? 3 : winMonths.length > 9 ? 2 : 1
  const ticks = winMonths.filter((_, index) => index % tickStep === 0)

  // Date ruler for the overview minimap (full span).
  const fullMonths: Date[] = []
  if (fullStart) {
    for (let index = 0; index < totalMonths; index += 1) {
      fullMonths.push(addMonths(fullStart, index))
    }
  }
  const rulerStep = fullMonths.length > 36 ? 6 : fullMonths.length > 18 ? 3 : fullMonths.length > 9 ? 2 : 1
  const rulerTicks = fullMonths.filter((_, index) => index % rulerStep === 0)

  const today = new Date()
  const todayPct = fullStart && today >= windowStart && today < windowEnd ? pct(today) : null
  const todayFullPct = fullStart && today >= fullStart && today < fullEnd ? pctFull(today) : null

  function startDrag(kind: 'pan' | 'left' | 'right', event: ReactPointerEvent<HTMLElement>) {
    event.preventDefault()
    event.stopPropagation()
    const trackWidth = trackRef.current?.getBoundingClientRect().width ?? 1
    const startX = event.clientX
    const baseStartDays = effStartDays
    const baseLenMonths = effLenMonths
    const baseLenDays = winLenDays
    const move = (moveEvent: PointerEvent) => {
      const deltaPx = moveEvent.clientX - startX
      const deltaDays = (deltaPx / trackWidth) * fullSpanDays
      const deltaMonths = (deltaPx / trackWidth) * totalMonths
      if (kind === 'pan') {
        // Step by half the window so consecutive views overlap (~fortnightly for a month view).
        const panStep = Math.max(1, baseLenDays / 2)
        const stepped = Math.round((baseStartDays + deltaDays) / panStep) * panStep
        setWinLenMonths(baseLenMonths)
        setWinStartDays(clamp(stepped, 0, Math.max(0, fullSpanDays - baseLenDays)))
      } else if (kind === 'right') {
        const maxLen = totalMonths * ((fullSpanDays - baseStartDays) / fullSpanDays)
        const len = clamp(snapLen(baseLenMonths + deltaMonths), levels[0] ?? 1, maxLen)
        setWinStartDays(baseStartDays)
        setWinLenMonths(len)
      } else {
        const rightEdgeDays = baseStartDays + baseLenDays
        const maxLen = totalMonths * (rightEdgeDays / fullSpanDays)
        const len = clamp(snapLen(baseLenMonths - deltaMonths), levels[0] ?? 1, maxLen)
        const newLenDays = (len / totalMonths) * fullSpanDays
        setWinLenMonths(len)
        setWinStartDays(clamp(rightEdgeDays - newLenDays, 0, Math.max(0, fullSpanDays - newLenDays)))
      }
    }
    const up = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }

  const showOverview = totalMonths > 1

  const slider: ReactNode = fullStart && showOverview ? (
    <div className="gantt-overview">
      <div className="gantt-overview__track" ref={trackRef}>
                {rulerTicks.map((month) => (
                  <span className="gantt-overview__tick" key={month.toISOString()} style={{ left: `${pctFull(month)}%` }}>
                    {tickLabel(month)}
                  </span>
                ))}
                {todayFullPct !== null ? <span className="gantt-overview__today" style={{ left: `${todayFullPct}%` }} aria-hidden="true" /> : null}
                <div
                  className="gantt-overview__window"
                  onPointerDown={(event) => startDrag('pan', event)}
                  style={{ left: `${winLeftPct}%`, width: `${winRightPct - winLeftPct}%` }}
                >
                  <span
                    aria-label="Zoom start"
                    className="gantt-overview__handle gantt-overview__handle--start"
                    onPointerDown={(event) => startDrag('left', event)}
                    role="slider"
                    tabIndex={0}
                  />
                  <span
                    aria-label="Zoom end"
                    className="gantt-overview__handle gantt-overview__handle--end"
                    onPointerDown={(event) => startDrag('right', event)}
                    role="slider"
                    tabIndex={0}
                  />
                </div>
              </div>
            </div>
  ) : null

  const content: ReactNode = (
    <div className="gantt">
      {fullStart ? (
        <div className="gantt__chart">
          <div className="gantt__head">
              {ticks.map((month) => (
                <span className="gantt__month" key={month.toISOString()} style={{ left: `${pct(month)}%` }}>
                  {tickLabel(month)}
                </span>
              ))}
              {todayPct !== null ? <span className="gantt__today-flag" style={{ left: `${todayPct}%` }}>Today</span> : null}
            </div>
            <div className="gantt__body">
              {ticks.map((month) => (
                <span className="gantt__gridline" key={month.toISOString()} style={{ left: `${pct(month)}%` }} aria-hidden="true" />
              ))}
              {todayPct !== null ? <span className="gantt__today" style={{ left: `${todayPct}%` }} aria-hidden="true" /> : null}
              {scheduled.map(({ project, start, end, status }) => {
                const rawLeft = pct(start)
                const rawRight = pct(new Date(end.getTime() + MS_PER_DAY))
                if (rawRight <= 0 || rawLeft >= 100) {
                  return null
                }
                const left = clamp(rawLeft, 0, 100)
                const width = Math.max(1.5, clamp(rawRight, 0, 100) - left)
                const percent = Math.min(100, Math.max(0, project.completion_percent ?? 0))
                const colorHex = projectColorValue(projectColorKey(project))
                const barStyle: CSSProperties = { left: `${left}%`, width: `${width}%` }
                const fillStyle: CSSProperties = { width: `${percent}%` }
                if (colorHex) {
                  barStyle.background = `${colorHex}1a`
                  barStyle.borderColor = `${colorHex}66`
                  fillStyle.background = `${colorHex}55`
                }
                return (
                  <div className="gantt__lane" key={project.id}>
                    <button
                      className={`gantt__bar${colorHex ? '' : ` is-${status}`}`}
                      onClick={() => onOpenProject(project)}
                      style={barStyle}
                      title={`${project.name} · ${PROJECT_STATUS_LABELS[status]} · ${fmtMoney(project.total_cost, currency)}`}
                      type="button"
                    >
                      <span aria-hidden="true" className="gantt__bar-fill" style={fillStyle} />
                      <span className="gantt__bar-label">{project.name}</span>
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
      ) : null}

      {undated.length ? (
        <div className="gantt__undated">
          <div className="gantt__undated-cards">
            {undated.map((project) => {
              const status = project.derived_status ?? project.status ?? 'planned'
              const colorHex = projectColorValue(projectColorKey(project))
              return (
                <button
                  className={`gantt__card${colorHex ? '' : ` is-${status}`}`}
                  key={project.id}
                  onClick={() => onOpenProject(project)}
                  style={colorHex ? { borderColor: `${colorHex}80` } : undefined}
                  type="button"
                >
                  <div className="gantt__card-head">
                    {colorHex
                      ? <span aria-hidden="true" className="gantt__card-dot" style={{ background: colorHex }} />
                      : <FolderKanban className="h-3.5 w-3.5" />}
                    <span>{project.name}</span>
                  </div>
                  <small>{fmtMoney(project.total_cost, currency)}</small>
                </button>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )

  return { slider, content, sliderState }
}
