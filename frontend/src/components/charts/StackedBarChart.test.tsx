import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { MonthlyBreakdownPoint } from '../../contracts/dashboard'
import { StackedBarChart } from './StackedBarChart'

function monthlySeries(length: number): MonthlyBreakdownPoint[] {
  return Array.from({ length }, (_, index) => ({
    period: `${2020 + Math.floor(index / 12)}-${String(index % 12 + 1).padStart(2, '0')}`,
    values: { Mortgage: 2000, Living: index % 2 === 0 ? 500 : 0 },
  }))
}

const categories = [
  { label: 'Mortgage', value: 2000, share: 0.8 },
  { label: 'Living', value: 500, share: 0.2 },
]

function expectSegmentsInsidePlot(svg: HTMLElement, count: number) {
  const segments = [...svg.querySelectorAll('.stacked-chart__segment')]
  expect(segments).toHaveLength(count)
  for (const segment of segments) {
    const x = Number(segment.getAttribute('x'))
    const width = Number(segment.getAttribute('width'))
    const y = Number(segment.getAttribute('y'))
    const height = Number(segment.getAttribute('height'))
    expect(width).toBeGreaterThan(0)
    expect(x).toBeGreaterThanOrEqual(62)
    expect(x + width).toBeLessThanOrEqual(746 + 1e-8)
    expect(y).toBeGreaterThanOrEqual(18 - 1e-8)
    expect(y + height).toBeLessThanOrEqual(252 + 1e-8)
  }
  const last = segments.at(-1)
  expect(Number(last?.getAttribute('x')) + Number(last?.getAttribute('width'))).toBeCloseTo(746)
}

describe('StackedBarChart', () => {
  it.each([1, 6, 68, 69, 120, 360, 600])('fits every segment of a %i-month series inside the plot', (length) => {
    render(<StackedBarChart points={monthlySeries(length)} categories={categories} currency="PLN" />)
    const svg = screen.getByRole('img', { name: 'Monthly expenses by category' })
    expectSegmentsInsidePlot(svg, length + Math.ceil(length / 2))
    const labels = [...svg.querySelectorAll('.chart-x-label')]
    expect(labels).toHaveLength(Math.min(length, 6))
    expect(labels[0]).toHaveTextContent('2020-01')
    expect(labels.at(-1)).toHaveTextContent(monthlySeries(length).at(-1)?.period ?? '')
  })

  it('keeps filtered months, values, colors, and forecast markers in the same fitted coordinate system', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'))
    try {
      const points = monthlySeries(360)
      const { rerender } = render(
        <StackedBarChart points={points} categories={categories} currency="PLN" showTodayMarker />,
      )
      const svg = screen.getByRole('img', { name: 'Monthly expenses by category' })
      const mortgage = [...svg.querySelectorAll('.stacked-chart__segment')]
        .find((segment) => segment.querySelector('title')?.textContent?.startsWith('2026-10 Mortgage:'))
      const marker = svg.querySelector('.chart__today-line')
      const tint = svg.querySelector('.chart__future-tint')
      const x = Number(marker?.getAttribute('x1'))
      const barX = Number(mortgage?.getAttribute('x'))
      const barWidth = Number(mortgage?.getAttribute('width'))
      expect(mortgage?.querySelector('title')?.textContent).toContain('2026-10 Mortgage')
      expect(x).toBeGreaterThan(barX)
      expect(x).toBeLessThan(barX + barWidth)
      expect(Number(tint?.getAttribute('x'))).toBeCloseTo(x)
      expect(Number(tint?.getAttribute('width')) + x).toBeCloseTo(746)
      expect(barWidth).toBeGreaterThan(0)

      rerender(
        <StackedBarChart
          points={points}
          categories={categories}
          currency="PLN"
          selectedCategory="Living"
          categoryColors={{ Living: 'rgb(217 119 6)' }}
          showTodayMarker
        />,
      )
      expectSegmentsInsidePlot(svg, 180)
      for (const segment of svg.querySelectorAll('.stacked-chart__segment')) {
        expect(segment).toHaveAttribute('fill', 'rgb(217 119 6)')
        expect(segment.querySelector('title')?.textContent).toContain('Living')
      }
      expect(screen.getByRole('button', { name: 'Living' })).toHaveAttribute('aria-pressed', 'true')
    } finally {
      vi.useRealTimers()
    }
  })
})
