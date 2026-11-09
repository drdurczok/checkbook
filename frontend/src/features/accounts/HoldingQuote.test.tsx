import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HoldingQuote } from './HoldingQuote'

const holding = { id: 'h', name: 'Fractional stock', value: 12, quantity: 0.1, ticker: 'TEST' }
const price = { ticker: 'TEST', currency: 'USD' as const, close: 1.2345, price_date: '2026-11-03', fetched_at: '2026-11-04T12:30:00Z', stale: false, error: null }

describe('HoldingQuote', () => {
  it('preserves subcent closing precision but rounds market value to cents', () => {
    render(<HoldingQuote holding={holding} price={price} failed={false} />)
    expect(screen.getByText('Close: USD 1.2345')).toBeInTheDocument()
    expect(screen.getByText('Market value: USD 0.12')).toBeInTheDocument()
    expect(screen.queryByText(/Stale/)).not.toBeInTheDocument()
    expect(screen.getByText(/Last successful fetch:/).querySelector('time')).toHaveAttribute('datetime', price.fetched_at)
  })
  it('marks cached prices stale after an HTTP refresh error', () => {
    render(<HoldingQuote holding={holding} price={price} failed />)
    expect(screen.getByText('Close: USD 1.2345')).toBeInTheDocument()
    expect(screen.getByText('Stale - last successful close retained')).toBeInTheDocument()
  })
  it('shows unavailable price and unknown market value without fabricating zero', () => {
    render(<HoldingQuote holding={holding} failed />)
    expect(screen.getByText('Close: Unavailable')).toBeInTheDocument()
    expect(screen.getByText('Market value: Unknown')).toBeInTheDocument()
  })
})
