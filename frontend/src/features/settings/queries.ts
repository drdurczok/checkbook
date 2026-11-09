import { useQuery } from '@tanstack/react-query'
import { householdApi } from '../../api/household'

export function useSettingsQuery(token: string) {
  return useQuery({
    queryKey: ['settings', token],
    enabled: Boolean(token),
    queryFn: async () => {
      const [settings, invitations] = await Promise.all([
        householdApi.getSettings(token),
        householdApi.getInvitations(token),
      ])
      return { settings, invitations }
    },
  })
}
