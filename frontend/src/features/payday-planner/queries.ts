import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'

export const plannerKeys = {
  all: (token: string | null) => ['payday-planner', token] as const,
  month: (token: string | null, month?: string) => [...plannerKeys.all(token), month ?? 'current'] as const,
}
export function usePaydayPlanner(token: string | null, month?: string) {
  return useQuery({ queryKey: plannerKeys.month(token, month), queryFn: () => api.getPaydayPlanner(token ?? '', month), enabled: Boolean(token) })
}
export function usePlannerMutation(token: string | null) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (operation: () => Promise<unknown>) => operation(),
    onSuccess: () => client.invalidateQueries({ queryKey: plannerKeys.all(token) }),
  })
}
