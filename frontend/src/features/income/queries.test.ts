import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import type { IncomeSource } from '../../types'
import { incomeKeys, replaceIncomeSource } from './queries'

const source = (id: string, name: string): IncomeSource => ({
  id,
  name,
  source_type: 'employment',
  owner_scope: 'joint',
  started_on: null,
  ended_on: null,
  notes: '',
  annual_total: 0,
  actual_total: 0,
  line_count: 0,
  lines: [],
  fields: [],
  milestones: [],
  entries: [],
  sort_order: 0,
})

describe('income query cache helpers', () => {
  it('replaces one source without changing order or other records', () => {
    const first = source('first', 'First')
    const second = source('second', 'Second')
    const updated = source('first', 'Updated')

    expect(replaceIncomeSource([first, second], updated)).toEqual([updated, second])
  })

  it('does not add an unexpected source to an existing collection', () => {
    const existing = source('existing', 'Existing')
    expect(replaceIncomeSource([existing], source('missing', 'Missing'))).toEqual([existing])
  })

  it('keeps different session tokens in independent caches', () => {
    const client = new QueryClient()
    client.setQueryData(incomeKeys.sources('wife-token'), [source('wife', 'Wife')])
    client.setQueryData(incomeKeys.sources('owner-token'), [source('owner', 'Owner')])
    client.setQueryData<IncomeSource[]>(incomeKeys.sources('owner-token'), (current) =>
      replaceIncomeSource(current, source('owner', 'Updated owner')),
    )

    expect(client.getQueryData(incomeKeys.sources('owner-token'))).toEqual([source('owner', 'Updated owner')])
    expect(client.getQueryData(incomeKeys.sources('wife-token'))).toEqual([source('wife', 'Wife')])
  })
})
