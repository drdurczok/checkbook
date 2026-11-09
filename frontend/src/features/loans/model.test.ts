import { describe, expect, it } from 'vitest'
import type { LoanSummary } from '../../contracts/dashboard'
import {
  finiteLoanNumber,
  calculateLoanEndDate,
  loanMinimumPayment,
  loanPaymentChange,
  loanPaymentSchedule,
  loanPaymentCompleted,
  loanPaymentSourceRows,
  loanProgress,
  loanTotalInterest,
} from './model'

const loan = (overrides: Partial<LoanSummary> = {}): LoanSummary => ({
  id: 'loan-1',
  name: 'Home mortgage',
  current_balance: 600_000,
  monthly_payment: 3_400,
  interest_rate: 0.0345,
  original_balance: 900_000,
  ...overrides,
})

describe('finiteLoanNumber', () => {
  it('rejects missing, empty, and non-numeric values instead of coercing them', () => {
    expect(finiteLoanNumber(null)).toBeNull()
    expect(finiteLoanNumber(undefined)).toBeNull()
    expect(finiteLoanNumber('')).toBeNull()
    expect(finiteLoanNumber('n/a')).toBeNull()
    expect(finiteLoanNumber(Number.NaN)).toBeNull()
    expect(finiteLoanNumber(true)).toBeNull()
  })

  it('accepts numbers, grouped, and decimal-comma strings', () => {
    expect(finiteLoanNumber(1_234.5)).toBe(1_234.5)
    expect(finiteLoanNumber('1200')).toBe(1_200)
    expect(finiteLoanNumber('3 400')).toBe(3_400)
    expect(finiteLoanNumber('1,5')).toBe(1.5)
  })
})

describe('loanMinimumPayment', () => {
  it('prefers a positive fixed formula payment', () => {
    expect(
      loanMinimumPayment(loan({ details: { fixed_monthly_payment: 3_200 } })),
    ).toBe(3_200)
  })

  it('falls back to the planned payment without a usable fixed value', () => {
    expect(loanMinimumPayment(loan())).toBe(3_400)
    expect(
      loanMinimumPayment(loan({ details: { fixed_monthly_payment: 0 } })),
    ).toBe(3_400)
    expect(
      loanMinimumPayment(loan({ details: { fixed_monthly_payment: -5 } })),
    ).toBe(3_400)
  })
})

describe('loanPaymentChange', () => {
  it('is null without an explicit fixed formula payment to compare against', () => {
    expect(loanPaymentChange(loan())).toBeNull()
    expect(loanPaymentChange(loan({ details: {} }))).toBeNull()
  })

  it('marks raised and lowered planned payments, ignoring sub-unit drift', () => {
    expect(
      loanPaymentChange(loan({ details: { fixed_monthly_payment: 3_200 } })),
    ).toBe(200)
    expect(
      loanPaymentChange(
        loan({
          monthly_payment: 3_000,
          details: { fixed_monthly_payment: 3_200 },
        }),
      ),
    ).toBe(-200)
    expect(
      loanPaymentChange(loan({ details: { fixed_monthly_payment: 3_400.5 } })),
    ).toBeNull()
  })
})

describe('loanProgress', () => {
  it('is null without an explicit positive original amount', () => {
    expect(loanProgress(loan({ original_balance: null }))).toBeNull()
    expect(loanProgress(loan({ original_balance: undefined }))).toBeNull()
    expect(loanProgress(loan({ original_balance: 0 }))).toBeNull()
  })

  it('reports the paid-down share, clamped to 0–100', () => {
    expect(loanProgress(loan())).toBeCloseTo(33.33, 2)
    expect(loanProgress(loan({ current_balance: 900_000 }))).toBe(0)
    expect(loanProgress(loan({ current_balance: 1_200_000 }))).toBe(0)
    expect(loanProgress(loan({ current_balance: 0 }))).toBe(100)
  })
})

describe('calculateLoanEndDate', () => {
  const from = new Date(2026, 0, 15)

  it('uses projected payoff months when available', () => {
    expect(
      calculateLoanEndDate(loan({ projected_payoff_months: 12 }), from),
    ).toBe('2027-01')
  })

  it('calculates a payoff month from finite balance, payment, and rate', () => {
    expect(calculateLoanEndDate(loan(), from)).toMatch(/^\d{4}-\d{2}$/)
  })

  it('returns null when the loan will not amortize or required data is absent', () => {
    expect(
      calculateLoanEndDate(loan({ monthly_payment: 1, interest_rate: 0.12 }), from),
    ).toBeNull()
    expect(
      calculateLoanEndDate(loan({ interest_rate: Number.NaN }), from),
    ).toBeNull()
    expect(
      calculateLoanEndDate(loan({ current_balance: 0 }), from),
    ).toBeNull()
  })
})

describe('loanPaymentSchedule', () => {
  it('returns an empty schedule for a missing loan or details', () => {
    expect(loanPaymentSchedule(null)).toEqual([])
    expect(loanPaymentSchedule(loan())).toEqual([])
    expect(
      loanPaymentSchedule(loan({ details: { payment_schedule: [] } })),
    ).toEqual([])
  })

  it('normalizes supported date formats to ISO and sorts ascending', () => {
    const schedule = loanPaymentSchedule(
      loan({
        details: {
          payment_schedule: [
            { date: '2026-01-15', payment: 3_400 },
            { date: '05.12.2025', payment: 3_400 },
            { date: '11/05/2025', payment: 3_400 },
            { date: '10.2024', payment: 3_400 },
          ],
        },
      }),
    )
    expect(schedule.map((payment) => payment.date)).toEqual([
      '2024-10-01',
      '2025-11-05',
      '2025-12-05',
      '2026-01-15',
    ])
  })

  it('drops rows with impossible dates or non-row entries', () => {
    const schedule = loanPaymentSchedule(
      loan({
        details: {
          payment_schedule: [
            { date: '2026-13-01' },
            { date: '2026-02-30' },
            { date: 'nope' },
            { date: 42 },
            'also-nope',
            null,
            { date: '2026-03-01', payment: 1 },
          ],
        },
      }),
    )
    expect(schedule).toHaveLength(1)
    expect(schedule[0]?.date).toBe('2026-03-01')
  })

  it('carries numeric fields, flags projected rows, and leaves gaps undefined', () => {
    const [actual, projected] = loanPaymentSchedule(
      loan({
        details: {
          payment_schedule: [
            {
              date: '2025-12-05',
              payment: '3 400',
              interest: 1_700,
              principal: 1_500,
              extra_principal: 200,
              outstanding_loan_balance: 605_000,
              interest_balance: 11_000,
            },
            {
              date: '2026-01-05',
              payment: 3_400,
              projected: true,
            },
          ],
        },
      }),
    )
    expect(actual).toMatchObject({
      payment: 3_400,
      interest: 1_700,
      principal: 1_500,
      extra_principal: 200,
      outstanding_loan_balance: 605_000,
      interest_balance: 11_000,
      projected: false,
    })
    expect(projected).toMatchObject({ payment: 3_400, projected: true })
    expect(projected?.interest).toBeUndefined()
  })
})

describe('loanTotalInterest', () => {
  it('sums interest across recorded and forecast rows exactly', () => {
    const record = loan({
      details: {
        payment_schedule: [
          { date: '2025-12-01', interest: 0.1 },
          { date: '2026-01-01', interest: '0.2' },
          { date: '2026-02-01', interest: 1700.7, projected: true },
        ],
      },
    })
    expect(loanTotalInterest(record)).toBe(1701)
  })

  it('is null without rows or when nothing sums above zero', () => {
    expect(loanTotalInterest(null)).toBeNull()
    expect(loanTotalInterest(loan())).toBeNull()
    expect(loanTotalInterest(loan({ details: { payment_schedule: [{ date: '2026-01-01' }] } }))).toBeNull()
    expect(loanTotalInterest(loan({ details: { payment_schedule: [
      { date: '2026-01-01', interest: 0 },
      { date: '2026-02-01', interest: -5, projected: true },
    ] } }))).toBeNull()
  })
})

describe('canonical payment status', () => {
  it.each([
    [{}, true], [{ projected: true }, false], [{ projected: false }, true],
    [{ completed: false, projected: false }, false], [{ completed: true, projected: true }, true],
  ])('prefers completion over legacy forecast flags: %j', (flags, expected) => {
    const payment = { date: '2026-01-01', ...flags }
    expect(loanPaymentCompleted(payment)).toBe(expected)
    expect(loanPaymentSchedule(loan({ details: { payment_schedule: [payment] } }))[0]?.projected).toBe(!expected)
  })

  it('preserves string ids and original transport decimals without normalizing editable source rows', () => {
    const original = { id: 'stable', date: '05.12.2025', payment: '1200.123456789123456789', completed: true }
    const record = loan({ details: { payment_schedule: [{ date: '2026-01-01' }, original] } })
    expect(loanPaymentSourceRows(record)[0]).toBe(original)
    expect(loanPaymentSourceRows(record)[0]?.payment).toBe('1200.123456789123456789')
    expect(loanPaymentSchedule(record)[0]).toMatchObject({ id: 'stable', date: '2025-12-05', completed: true, projected: false })
  })
})
