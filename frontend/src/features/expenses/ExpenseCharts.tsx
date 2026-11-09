import { useRef, useState, type ReactNode } from 'react'

/* The two charts sit side by side on wide screens and become a horizontal
   snap-scroll strip on mobile. The footer row below the strip carries the
   selected-category pill (when a filter is active) and the pager dots that
   show (and control) which chart is currently in view. */
export function ExpenseCharts({
  mix,
  trend,
  filter,
}: { mix: ReactNode; trend?: ReactNode; filter?: { label: string; color?: string } | null }) {
  const trackRef = useRef<HTMLDivElement>(null)
  const mixRef = useRef<HTMLDivElement>(null)
  const trendRef = useRef<HTMLDivElement>(null)
  const [activeSlide, setActiveSlide] = useState(0)

  const slides = [{ label: 'Expense mix', ref: mixRef }, ...(trend ? [{ label: 'Spending trend', ref: trendRef }] : [])]

  const showSlide = (index: number) => {
    slides[index].ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' })
  }

  const handleScroll = () => {
    const track = trackRef.current
    if (!track || track.clientWidth === 0) return
    const next = Math.round(track.scrollLeft / track.clientWidth)
    setActiveSlide((current) => (next === current ? current : next))
  }

  return (
    <div className="expense-charts">
      <div
        ref={trackRef}
        onScroll={handleScroll}
        className={`expense-chart-track${trend ? ' expense-chart-track--pair' : ''}`}
      >
        <div ref={mixRef} className="expense-chart-slide">{mix}</div>
        {trend ? <div ref={trendRef} className="expense-chart-slide">{trend}</div> : null}
      </div>
      {trend || filter ? (
        <div className="expense-chart-footer">
          {filter ? (
            <span className="expense-chart-filter-pill">
              {filter.color ? <i aria-hidden="true" style={{ background: filter.color }} /> : null}
              {filter.label}
            </span>
          ) : null}
          {trend ? (
            <div className="expense-chart-pager" role="group" aria-label="Expense charts">
              {slides.map((slide, index) => (
                <button
                  key={slide.label}
                  type="button"
                  aria-current={activeSlide === index ? 'true' : 'false'}
                  aria-label={`Show ${slide.label.toLowerCase()}`}
                  onClick={() => showSlide(index)}
                >
                  <span className="expense-chart-pager-dot" />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
