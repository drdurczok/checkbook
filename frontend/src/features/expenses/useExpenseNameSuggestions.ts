import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'

export function useExpenseNameSuggestions(token: string, name: string, enabled: boolean) {
  const query = name.trim().replace(/\s+/g, ' ').toLowerCase()
  const [debouncedQuery, setDebouncedQuery] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 200)
    return () => window.clearTimeout(timer)
  }, [query])

  const queryLength = Array.from(query).length
  const canSearch = enabled && Boolean(token) && queryLength >= 2 && queryLength <= 120
  const result = useQuery({
    queryKey: ['expense-name-suggestions', token, debouncedQuery],
    queryFn: () => api.getExpenseNameSuggestions(token, debouncedQuery),
    enabled: canSearch && query === debouncedQuery,
    staleTime: 0,
    retry: false,
  })
  // Never apply results for an earlier draft, including during the debounce window.
  const isCurrent = canSearch && query === debouncedQuery
  return {
    suggestions: isCurrent ? result.data ?? [] : [],
    searching: canSearch && (!isCurrent || result.isFetching),
    failed: isCurrent && result.isError,
  }
}
