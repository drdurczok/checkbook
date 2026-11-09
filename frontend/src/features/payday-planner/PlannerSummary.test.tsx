import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PlannerSummary } from './PlannerSummary'
import { plannerAmount } from './model'

function renderSummary(income: string, planned: string, remaining: string, completed: string) {
  return render(<PlannerSummary income={income} planned={planned} remaining={remaining} completed={completed} currency="USD" money={plannerAmount} />)
}

describe('planner summary', () => {
  it('shows descriptor-free, currency-free values around one bar where the green completed fill overlaps the blue planned fill', () => {
    const { container } = renderSummary('100.00', '40.00', '60.00', '25.00')
    expect(screen.getByLabelText('Planned')).toHaveTextContent('40.00')
    expect(screen.getByLabelText('Net income')).toHaveTextContent('100.00')
    expect(screen.getByLabelText('Remaining')).toHaveTextContent('60.00')
    expect(screen.getByLabelText('Completed')).toHaveTextContent('25.00')
    expect(container.querySelector('.planner-summary__planned')).toBeInTheDocument()
    expect(container.querySelector('.planner-summary__completed')).toBeInTheDocument()
    const track = container.querySelector('.planner-summary__track')
    expect(container.querySelectorAll('.planner-summary__track')).toHaveLength(1)
    const bars = screen.getAllByRole('progressbar')
    expect(bars[0]).toHaveAccessibleName('Planned share of net income')
    expect(bars[0]).toHaveAttribute('aria-valuenow', '40')
    expect(bars[0]).toHaveClass('planner-summary__fill')
    expect(bars[0]).toHaveStyle({ width: '40.00%' })
    expect(bars[1]).toHaveAccessibleName('Completed share of net income')
    expect(bars[1]).toHaveAttribute('aria-valuenow', '25')
    expect(bars[1]).toHaveClass('planner-summary__fill', 'planner-summary__fill--completed')
    expect(bars[1]).toHaveStyle({ width: '25.00%' })
    expect(track).toContainElement(bars[0])
    expect(track).toContainElement(bars[1])
    expect(bars[1].previousElementSibling).toBe(bars[0])
    expect(container.querySelector('.planner-summary__remaining')).not.toHaveClass('planner-negative')
  })
  it('places the currency code in the bottom-right corner with the loan card indicator style', () => {
    const { container } = renderSummary('100.00', '40.00', '60.00', '25.00')
    const currency = screen.getByLabelText('Currency')
    expect(currency).toHaveTextContent('USD')
    expect(currency).toHaveClass('planner-summary__currency')
    expect(currency.parentElement).toHaveClass('planner-summary__footnote')
    expect(currency.parentElement?.lastElementChild).toBe(currency)
    expect(container.querySelector('.planner-summary__values')?.textContent).not.toContain('$')
  })
  it('clamps over-planned bars, flags negative remaining, and keeps completed on the income scale', () => {
    const { container } = renderSummary('100.00', '250.00', '-150.00', '10.00')
    expect(screen.getByLabelText('Planned')).toHaveTextContent('250.00')
    expect(screen.getByLabelText('Remaining')).toHaveClass('planner-negative')
    expect(screen.getByLabelText('Remaining')).toHaveTextContent('-150.00')
    expect(container.querySelector('.planner-summary__fill')).toHaveStyle({ width: '100.00%' })
    expect(screen.getAllByRole('progressbar')[0]).toHaveAttribute('aria-valuenow', '100')
    expect(container.querySelector('.planner-summary__fill--completed')).toHaveStyle({ width: '10.00%' })
  })
  it('renders empty bars instead of dividing by a non-positive income', () => {
    const { container } = renderSummary('0.00', '40.00', '-40.00', '25.00')
    expect(container.querySelector('.planner-summary__fill')).toHaveStyle({ width: '0.00%' })
    expect(container.querySelector('.planner-summary__fill--completed')).toHaveStyle({ width: '0.00%' })
    for (const bar of screen.getAllByRole('progressbar')) expect(bar).toHaveAttribute('aria-valuenow', '0')
  })
})
