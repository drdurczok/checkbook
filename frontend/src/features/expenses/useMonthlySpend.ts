import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'

export function useMonthlySpend(token: string) {
  const today = new Date()
  const start = new Date(today.getFullYear(), today.getMonth() - 3, 1).toLocaleDateString('sv-SE')
  const end = today.toLocaleDateString('sv-SE')
  return useQuery({
    queryKey: ['expenses', token, 'monthly-spend', start, end],
    enabled: Boolean(token),
    queryFn: () => api.getExpensesBoard(token, { start_date: start, end_date: end }),
  })
}
