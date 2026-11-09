import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Dispatch, SetStateAction } from 'react'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import type { AssetSummary, Category } from '../../types'
import type { PropertySavePayload } from './types'

type Options = {
  selectedProperty: AssetSummary | null
  setSelectedProperty: Dispatch<SetStateAction<AssetSummary | null>>
  updateRecord: (updated: AssetSummary) => void
  setCategories?: Dispatch<SetStateAction<Category[]>>
  onDeleted?: () => void | Promise<void>
}

const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

export function usePropertyMutations({
  selectedProperty,
  setSelectedProperty,
  updateRecord,
  setCategories,
  onDeleted,
}: Options) {
  const { token, setError, setMessage } = useSession()
  const queryClient = useQueryClient()

  const updateMutation = useMutation({
    mutationFn: async (payload: PropertySavePayload) => {
      if (!token || !selectedProperty) throw new Error('No property selected.')
      return api.updateAsset(token, selectedProperty.id, payload)
    },
    onSuccess: (updated) => {
      updateRecord(updated)
      setSelectedProperty(updated)
      setMessage('Property updated.')
      void queryClient.invalidateQueries({ queryKey: ['properties'] })
      void queryClient.invalidateQueries({ queryKey: ['overview'] })
    },
    onError: (error) => setError(errorMessage(error, 'Property update failed.')),
  })

  const categoryMutation = useMutation({
    mutationFn: async () => {
      if (!token || !selectedProperty) throw new Error('No property selected.')
      const updated = await api.createOwnPropertyCategory(token, selectedProperty.id)
      const categories = setCategories ? await api.getCategories(token) : null
      return { updated, categories }
    },
    onSuccess: ({ updated, categories }) => {
      updateRecord(updated)
      setSelectedProperty(updated)
      if (categories && setCategories) setCategories(categories)
      setMessage('Own expense category created.')
      void queryClient.invalidateQueries({ queryKey: ['properties'] })
    },
    onError: (error) => setError(errorMessage(error, 'Could not create category.')),
  })

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (!token || !selectedProperty) throw new Error('No property selected.')
      await api.deleteAsset(token, selectedProperty.id)
    },
    onSuccess: async () => {
      setSelectedProperty(null)
      await onDeleted?.()
      setMessage('Property deleted.')
      void queryClient.invalidateQueries({ queryKey: ['properties'] })
      void queryClient.invalidateQueries({ queryKey: ['overview'] })
    },
    onError: (error) => setError(errorMessage(error, 'Property delete failed.')),
  })

  return {
    saving: updateMutation.isPending,
    deleting: deleteMutation.isPending,
    async save(payload: PropertySavePayload) {
      try {
        await updateMutation.mutateAsync(payload)
        return true
      } catch {
        return false
      }
    },
    async createOwnCategory() {
      try {
        const result = await categoryMutation.mutateAsync()
        return result.updated
      } catch {
        return null
      }
    },
    async deleteProperty() {
      try {
        await deleteMutation.mutateAsync()
      } catch {
        // The mutation reports the user-facing error.
      }
    },
  }
}
