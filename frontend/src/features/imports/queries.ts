import { useQuery } from '@tanstack/react-query'
import { importsApi } from '../../api/imports'

export function useImportsQuery(token: string) {
  return useQuery({
    queryKey: ['imports', token],
    enabled: Boolean(token),
    queryFn: async () => {
      const [history, rawData] = await Promise.all([
        importsApi.getImportHistory(token),
        importsApi.getImportRawData(token),
      ])
      return { history, rawData }
    },
  })
}
