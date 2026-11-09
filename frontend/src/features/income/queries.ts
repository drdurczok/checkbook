import { useQuery } from '@tanstack/react-query'
import { incomeApi } from '../../api/income'
import type { IncomeSource } from '../../types'

export const incomeKeys = {
  sources: (token: string) => ['income-sources', token] as const,
}

export function replaceIncomeSource(sources: IncomeSource[] | undefined, updated: IncomeSource) {
  return sources?.map((source) => (source.id === updated.id ? updated : source)) ?? []
}

export function useIncomeSourcesQuery(token: string) {
  return useQuery({
    queryKey: incomeKeys.sources(token),
    enabled: Boolean(token),
    queryFn: () => incomeApi.getIncomeSources(token),
  })
}
