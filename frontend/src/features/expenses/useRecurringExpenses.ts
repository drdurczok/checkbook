import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import type { RecurringExpensePayload } from '../../contracts/expenses'

export function useRecurringExpenses(token: string) {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ['recurring-expenses', token],
    queryFn: () => api.getRecurringExpenses(token),
    enabled: Boolean(token),
  })
  const mutation = useMutation({
    mutationFn: (action: { id: string; kind: 'now' | 'retire' } | { id: string; kind: 'edit'; payload: RecurringExpensePayload }) => {
      if (action.kind === 'edit') return api.updateRecurringExpense(token, action.id, action.payload)
      return action.kind === 'now' ? api.expenseRecurringNow(token, action.id) : api.retireRecurringExpense(token, action.id)
    },
    onSuccess: async () => {
      await client.invalidateQueries({ predicate: (query) => ['recurring-expenses', 'expenses', 'overview', 'planning-board', 'expense-name-suggestions'].includes(String(query.queryKey[0])) })
    },
  })
  return { query, mutation }
}
