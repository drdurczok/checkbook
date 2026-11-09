import type { PropertySavePayload } from './types'
import { numericAmount } from '../../lib/format'
import { projectItemTotal, projectRooms } from '../../lib/projects'
import type {
  AssetDetailItem,
  AssetDetailRoom,
  AssetDetailSection,
  AssetSummary,
  PropertyValuation,
} from '../../contracts/assets'
import type { Category } from '../../contracts/expenses'
import type { TrackedField } from '../../contracts/utilities'

const CATEGORY_PALETTE = [
  '#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed',
  '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5',
]

export type FeatureKey = 'depreciation' | 'projects' | 'utilities' | 'expenses'

export type EditForm = {
  name: string
  value: string
  valuation_date: string
  started_on: string
  ended_on: string
  notes: string
  category: 'property' | 'vehicle' | 'other' | 'account'
  depreciationRatePercent: string
  depreciationEnabled: boolean
  utilitiesEnabled: boolean
  projectsEnabled: boolean
  expensesEnabled: boolean
  featureOrder: FeatureKey[]
  linkedCategoryIds: string[]
  rooms: AssetDetailRoom[]
}

export type PropertyDetailModalProps = {
  presentation?: 'inline' | 'modal'
  initialMode?: 'view' | 'edit'
  property: AssetSummary
  projects: AssetSummary[]
  categories?: Category[]
  currency: string
  saving: boolean
  deleting?: boolean
  utilityCount?: number
  onClose: () => void
  onSave: (payload: PropertySavePayload) => Promise<boolean>
  onDelete?: () => Promise<void> | void
  onOpenProject?: (project: AssetSummary) => void
  onCreateOwnCategory?: () => Promise<AssetSummary | null>
  onListValuations?: () => Promise<PropertyValuation[]>
  onAddValuation?: (value: number, date: string) => Promise<PropertyValuation | null>
  onDeleteValuation?: (valuationId: string) => Promise<boolean>
  onLinkProject?: (project: AssetSummary) => Promise<AssetSummary | null>
  onUnlinkProject?: (project: AssetSummary) => Promise<AssetSummary | null>
  onListUtilityFields?: () => Promise<{ catalog: TrackedField[]; tracked: TrackedField[] }>
  onTrackUtilityField?: (fieldKey: string) => Promise<TrackedField[] | null>
  onUntrackUtilityField?: (fieldKey: string) => Promise<TrackedField[] | null>
}

export const colorForIndex = (index: number) => CATEGORY_PALETTE[index % CATEGORY_PALETTE.length]
export const hasNumericValue = (value: unknown) =>
  value !== null && value !== undefined && value !== '' && Number.isFinite(numericAmount(value))

export const emptyItem = (): AssetDetailItem => ({ name: 'New item', unit_price: '', quantity: '', total_cost: 0, notes: '', completed: false })
export const emptySection = (): AssetDetailSection => ({ name: 'New section', total: 0, items: [emptyItem()] })
export const emptyRoom = (): AssetDetailRoom => ({ name: 'New category', total: 0, sections: [emptySection()] })

export const editFormFromProperty = (property: AssetSummary): EditForm => ({
  name: property.name,
  value: property.original_total_cost ? String(property.original_total_cost) : '',
  valuation_date: property.valuation_date ?? '',
  started_on: property.started_on ?? '',
  ended_on: property.ended_on ?? '',
  notes: property.notes ?? '',
  category: property.category ?? 'property',
  depreciationRatePercent: property.depreciation_rate ? String(property.depreciation_rate * 100) : '',
  depreciationEnabled: property.depreciation_enabled ?? Boolean(property.depreciation_rate),
  utilitiesEnabled: property.utilities_enabled ?? true,
  projectsEnabled: property.projects_enabled ?? true,
  expensesEnabled: property.expenses_enabled ?? true,
  featureOrder: (['depreciation', 'projects', 'utilities', 'expenses'] as FeatureKey[]).filter((key) =>
    key === 'depreciation'
      ? (property.depreciation_enabled ?? Boolean(property.depreciation_rate))
      : key === 'projects'
        ? (property.projects_enabled ?? true)
        : key === 'utilities'
          ? (property.utilities_enabled ?? true)
          : (property.expenses_enabled ?? true),
  ),
  linkedCategoryIds: property.linked_category_ids ?? [],
  rooms: projectRooms(property).map((room) => ({
    ...room,
    sections: room.sections.map((section) => ({
      ...section,
      items: section.items.map((item) => ({ ...item, notes: item.notes ?? '' })),
    })),
  })),
})

export const recalculateRooms = (rooms: AssetDetailRoom[]) => rooms.map((room) => {
  const sections = room.sections.map((section) => ({
    name: section.name,
    total: section.items.reduce((sum, item) => sum + projectItemTotal(item), 0),
    items: section.items.map((item) => ({
      ...item,
      name: item.name,
      unit_price: item.unit_price,
      quantity: item.quantity,
      total_cost: projectItemTotal(item),
      notes: item.notes ?? '',
    })),
  }))
  return { name: room.name, sections, total: sections.reduce((sum, section) => sum + numericAmount(section.total), 0) }
})
