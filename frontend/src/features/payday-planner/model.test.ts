import { describe, expect, it } from 'vitest'
import { plannerAmount, plannerDifferenceTone, plannerMoney, shiftPlannerMonth, validPlannerAmount } from './model'

describe('planner decimal inputs', () => {
  it.each(['0', '0.00', '12.3', '9999999999999999.99'])('accepts non-negative decimal %s', (value) => expect(validPlannerAmount(value)).toBe(true))
  it.each(['', '-1', '1e2', 'NaN', 'Infinity', '1.001', '1,000', '.2'])('rejects invalid amount %s', (value) => expect(validPlannerAmount(value)).toBe(false))
  it('formats decimal strings without losing financial precision', () => {
    expect(plannerMoney('9999999999999999.99', 'USD')).toBe('$9999999999999999.99')
    expect(plannerMoney('-0.01', 'USD')).toBe('-$0.01')
  })
  it('formats currency-free amounts for cards that show the code separately', () => {
    expect(plannerAmount('9999999999999999.99')).toBe('9999999999999999.99')
    expect(plannerAmount('-0.01')).toBe('-0.01')
    expect(plannerAmount('40.00')).toBe('40.00')
  })
  it.each([
    [null, null, ''], ['0.00', '0', ''],
    ['1', '10', 'planner-difference--over planner-difference--small'],
    ['1', '10.01', 'planner-difference--over planner-difference--large'],
    ['-1', '-5', 'planner-difference--under planner-difference--small'],
    ['-1', '-50', 'planner-difference--under planner-difference--large'],
    ['1', null, 'planner-difference--over planner-difference--small'],
  ])('styles difference %s at %s percent', (difference, percentage, expected) => {
    expect(plannerDifferenceTone(difference, percentage)).toBe(expected)
  })
  it('navigates year boundaries', () => {
    expect(shiftPlannerMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftPlannerMonth('2026-01', -1)).toBe('2025-12')
  })
})
