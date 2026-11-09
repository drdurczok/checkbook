import { describe, expect, it } from 'vitest'
import { valueTrendSeries } from './valueTrend'

describe('valueTrendSeries', () => {
  it('interpolates known values and projects from the latest anchor', () => {
    const result = valueTrendSeries(
      [
        { value: 100, date: '2026-01-01' },
        { value: 121, date: '2026-03-01' },
      ],
      0.01,
      new Date(2026, 2, 15),
    )

    expect(result.find((point) => point.period === '2026-02')).toMatchObject({ value: 110, projected: false })
    expect(result.find((point) => point.period === '2026-04')).toMatchObject({ value: 122.21, projected: true })
  })

  it('ignores invalid dates', () => {
    expect(valueTrendSeries([{ value: 100, date: '' }], 0.01)).toEqual([])
  })
})
