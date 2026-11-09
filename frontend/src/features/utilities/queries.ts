import { useQuery } from '@tanstack/react-query'
import { assetsApi } from '../../api/assets'
import { householdApi } from '../../api/household'
import { utilitiesApi } from '../../api/utilities'

export type UtilitySubjectRef = { type: 'property' | 'contract'; id: string }

const boardParams = (ref: UtilitySubjectRef) => ({
  propertyId: ref.type === 'property' ? ref.id : undefined,
  groupId: ref.type === 'contract' ? ref.id : undefined,
})

export function useUtilitySubjectsQuery(token: string, includeHistoric: boolean) {
  return useQuery({
    queryKey: ['utility-subjects', token, includeHistoric],
    enabled: Boolean(token),
    queryFn: async () => {
      const [assets, contracts, catalog] = await Promise.all([
        assetsApi.getAssets(token),
        householdApi.getGroups(token, { kind: 'contract', include_historic: includeHistoric }),
        utilitiesApi.getUtilityFieldCatalog(token),
      ])
      const properties = assets.filter(
        (asset) => (asset.kind ?? 'asset') === 'asset' && asset.utilities_enabled !== false,
      )
      return { properties, contracts, catalog }
    },
  })
}

export function useUtilityBoardQuery(token: string, ref: UtilitySubjectRef | null, includeHistoric: boolean) {
  return useQuery({
    queryKey: ['utility-board', token, ref?.type ?? null, ref?.id ?? null, includeHistoric],
    enabled: Boolean(token && ref),
    queryFn: () => utilitiesApi.getUtilityBoard(token, {
      ...boardParams(ref!),
      months: includeHistoric ? 0 : 12,
    }),
  })
}
