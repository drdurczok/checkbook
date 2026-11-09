/* eslint-disable react-refresh/only-export-components */
/**
 * Shared pieces for the month-per-row detail tables (Net worth details, Cash
 * flow details). Months render as bare numbers in the left column; each year
 * gets its own tbody opening with a divider row — a slightly darker rule with
 * the year label breaking the line on the left. MonthTableShell keeps the
 * current year pinned under the sticky header while its rows scroll, handing
 * over when the next year's divider arrives.
 */

import { useEffect, useRef, type ReactNode } from "react";

export type YearGroup<Row> = { year: string; rows: Row[] }

/** Split display-ordered rows into consecutive groups keyed by period year. */
export function groupRowsByYear<Row>(
  rows: Row[],
  periodOf: (row: Row) => string,
): YearGroup<Row>[] {
  const groups: YearGroup<Row>[] = []
  for (const row of rows) {
    const year = periodOf(row).slice(0, 4)
    const current = groups[groups.length - 1]
    if (current && current.year === year) {
      current.rows.push(row)
    } else {
      groups.push({ year, rows: [row] })
    }
  }
  return groups
}

/** "2026-09" -> "9": the year lives on the divider row, not in the column. */
export function monthNumberLabel(period: string): string {
  const month = Number(period.slice(5, 7))
  return Number.isFinite(month) && month >= 1 ? String(month) : period
}

export function YearDividerRow({
  year,
  columns,
}: {
  year: string
  columns: number
}) {
  return (
    <tr className="net-worth-table__year-row">
      <th colSpan={columns} scope="colgroup">
        <span className="net-worth-table__year-label">{year}</span>
      </th>
    </tr>
  )
}

/**
 * Scroll shell for the month tables that pins the current year under the
 * sticky header. CSS sticky alone cannot do this: sticky table cells and rows
 * are constrained by the whole table box, so every year divider would stack
 * at the same offset. Instead the dividers stay in flow and a floating
 * indicator takes over each label as it reaches the header line: the
 * indicator rides with the in-flow label — covering it pixel-for-pixel —
 * while it is still below the line, then clamps at the line so the year
 * freezes in place instead of sliding under the header and popping back in
 * once its whole row has passed.
 */
export function MonthTableShell({
  className = "net-worth-table-shell",
  children,
}: {
  className?: string
  children: ReactNode
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const shellRef = useRef<HTMLDivElement | null>(null)
  const indicatorRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    const shell = shellRef.current
    const indicator = indicatorRef.current
    if (!wrap || !shell || !indicator) return
    const label = indicator.querySelector<HTMLElement>(
      ".net-worth-table__year-label",
    )

    const update = () => {
      const header = shell.querySelector("thead th")
      if (!header || !label) {
        indicator.style.display = "none"
        return
      }
      // Classic scrollbars eat into the shell's box but not the wrap's, so an
      // indicator spanning the whole wrap would run over the scrollbar and
      // past the table edge. Inset its right edge by the scrollbar width.
      // Both edges sit on the shell's content box, inside its side borders,
      // so the pinned rule and label align pixel-for-pixel with the in-flow
      // divider rows and the table's own borders stay visible.
      indicator.style.left = `${shell.clientLeft}px`
      indicator.style.right = `${shell.offsetWidth - shell.clientWidth - shell.clientLeft}px`
      const wrapTop = wrap.getBoundingClientRect().top
      const pinned = header.getBoundingClientRect().bottom - wrapTop
      let current: HTMLElement | null = null
      for (const divider of shell.querySelectorAll<HTMLElement>(
        ".net-worth-table__year-row",
      )) {
        // Strictly above the header line: at rest the first divider's top
        // coincides with the line, and the in-flow label already sits there
        // — the indicator takes over only once the row starts crossing.
        if (divider.getBoundingClientRect().top - wrapTop < pinned - 0.5) {
          current = divider
        }
      }
      const yearLabel =
        current?.querySelector<HTMLElement>(".net-worth-table__year-label") ??
        null
      if (!current || !yearLabel) {
        indicator.style.display = "none"
        return
      }
      // The indicator's box matches the label's box (same class, same
      // metrics), so seating it exactly on the in-flow label hides that label
      // and paints an identical one on top. Riding keeps both aligned while
      // the row approaches; the clamp freezes the label under the header.
      const riding = yearLabel.getBoundingClientRect().top - wrapTop
      indicator.style.top = `${Math.max(riding, pinned)}px`
      label.textContent = current.textContent
      indicator.style.display = "block"
    }

    update()
    const observer = new ResizeObserver(update)
    observer.observe(shell.querySelector("table") ?? shell)
    observer.observe(shell)
    shell.addEventListener("scroll", update, { passive: true })
    return () => {
      observer.disconnect()
      shell.removeEventListener("scroll", update)
    }
  }, [])

  return (
    <div className="net-worth-table-shell-wrap" ref={wrapRef}>
      <div ref={shellRef} className={className}>
        {children}
      </div>
      <div
        aria-hidden="true"
        className="net-worth-table__year-sticky"
        ref={indicatorRef}
      >
        <span className="net-worth-table__year-label" />
      </div>
    </div>
  )
}
