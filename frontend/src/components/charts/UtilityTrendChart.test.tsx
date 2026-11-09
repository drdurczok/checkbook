import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UtilityTrendChart } from './UtilityTrendChart'

const points = [{ period: '2026-01', values: { Electricity: 20, Custom: 10 }, usage: { Electricity: 4, Custom: 2 }, units: { Electricity: 'kWh', Custom: 'm3' }, total: 30 }]
const props = { points, categories: ['Electricity', 'Custom'], selectedCategory: 'all', metric: 'money' as const, currency: 'PLN', onCategorySelect: vi.fn() }

describe('UtilityTrendChart colors', () => {
  it.each(['money', 'usage', 'rate'] as const)('uses configured colors for lines and legends in %s mode', (metric) => {
    const { container } = render(<UtilityTrendChart {...props} metric={metric} categoryColors={{ Electricity: '#abcdef', Custom: '#123456' }} />)
    const lines = container.querySelectorAll('.utility-trend-chart__line')
    expect(lines[0]).toHaveStyle({ stroke: '#abcdef' })
    expect(lines[1]).toHaveStyle({ stroke: '#123456' })
    expect(screen.getByRole('button', { name: 'Electricity' }).querySelector('i')).toHaveStyle({ background: '#abcdef' })
    expect(screen.getByRole('button', { name: 'Custom' }).querySelector('i')).toHaveStyle({ background: '#123456' })
  })

  it('exposes individually colored water utilities alongside the grouped filter', () => {
    const { container } = render(<UtilityTrendChart {...props} categories={['Cold water', 'Hot water']} points={[{ ...points[0], values: { 'Cold water': 10, 'Hot water': 20 } }]} categoryColors={{ 'Cold water': '#123456', 'Hot water': '#abcdef' }} />)
    expect(screen.getByRole('button', { name: 'Water' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cold water' }).querySelector('i')).toHaveStyle({ background: '#123456' })
    expect(screen.getByRole('button', { name: 'Hot water' }).querySelector('i')).toHaveStyle({ background: '#abcdef' })
    expect(container.querySelectorAll('.utility-trend-chart__line')[1]).toHaveStyle({ stroke: '#abcdef' })
  })

  it('keeps same-named contract series independently colored by key', () => {
    const { container } = render(<UtilityTrendChart {...props} categories={['first', 'second']} points={[{ ...points[0], values: { first: 10, second: 20 } }]} categoryLabels={{ first: 'Power', second: 'Power' }} categoryColors={{ first: '#123456', second: '#abcdef' }} />)
    const headers = screen.getAllByRole('button', { name: 'Power' })
    expect(headers).toHaveLength(2)
    expect(headers[0].querySelector('i')).toHaveStyle({ background: '#123456' })
    expect(headers[1].querySelector('i')).toHaveStyle({ background: '#abcdef' })
    expect(container.querySelectorAll('.utility-trend-chart__line')[1]).toHaveStyle({ stroke: '#abcdef' })
  })

  it('keeps fallback colors stable when selecting a single utility', () => {
    const { container, rerender } = render(<UtilityTrendChart {...props} />)
    const color = container.querySelectorAll<SVGElement>('.utility-trend-chart__line')[1].style.stroke
    expect(screen.getByRole('button', { name: 'Custom' }).querySelector('i')).toHaveStyle({ background: color })
    rerender(<UtilityTrendChart {...props} selectedCategory="Custom" />)
    expect(container.querySelector('.utility-trend-chart__line')).toHaveStyle({ stroke: color })
  })
})
