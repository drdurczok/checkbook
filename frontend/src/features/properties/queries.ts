import { useQuery } from '@tanstack/react-query'
import { assetsApi } from '../../api/assets'
import { householdApi } from '../../api/household'
import { utilitiesApi } from '../../api/utilities'

export function usePropertiesQuery(token: string) {
  return useQuery({
    queryKey: ['properties', token],
    enabled: Boolean(token),
    queryFn: async () => {
      const [records, categories, loans] = await Promise.all([
        assetsApi.getAssets(token),
        householdApi.getCategories(token),
        assetsApi.getLoans(token),
      ])
      // Vehicles and accounts carry no utilities, so their subject ids are
      // never prefetched against the utility board.
      const properties = records.filter(
        (record) => (record.kind ?? 'asset') === 'asset'
          && record.category !== 'vehicle'
          && record.category !== 'account'
          && record.utilities_enabled !== false,
      )
      const boards = await Promise.all(
        properties.map((property) => utilitiesApi.getUtilityBoard(token, { propertyId: property.id, months: 1 }).catch(() => null)),
      )
      const utilityCounts = Object.fromEntries(
        properties.map((property, index) => [property.id, boards[index]?.subject?.tracked_fields?.length ?? 0]),
      )
      return { records, categories, loans, utilityCounts }
    },
  })
}
