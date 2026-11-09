import { numericAmount } from './format'
import type { AssetDetailItem, AssetDetailRoom, AssetDetailSection, AssetSummary, ProjectStatus } from '../types'

export const projectItemTotal = (item: AssetDetailItem) => {
  const hasNumeric = (value: unknown) => value !== null && value !== undefined && value !== '' && Number.isFinite(numericAmount(value))
  return hasNumeric(item.unit_price) && hasNumeric(item.quantity)
    ? numericAmount(item.unit_price) * numericAmount(item.quantity)
    : numericAmount(item.total_cost)
}

export const projectRooms = (project: Pick<AssetSummary, 'details'> | null): AssetDetailRoom[] => {
  const rooms = project?.details?.rooms
  if (!Array.isArray(rooms)) {
    return []
  }
  return rooms.filter((room): room is AssetDetailRoom => {
    if (!room || typeof room !== 'object') {
      return false
    }
    const candidate = room as Partial<AssetDetailRoom>
    return typeof candidate.name === 'string' && Array.isArray(candidate.sections)
  })
}

export const isProjectItemCompleted = (item: AssetDetailItem, storedStatus: ProjectStatus | undefined) =>
  item.completed === undefined || item.completed === null
    ? storedStatus === 'completed'
    : Boolean(item.completed)

export type ProjectCompletionSummary = {
  itemCount: number
  completedItemCount: number
  itemsTotal: number
  completedCost: number
  derivedStatus: ProjectStatus
  completionPercent: number
}

export const projectRoomsCompletion = (rooms: AssetDetailRoom[], storedStatus: ProjectStatus): ProjectCompletionSummary => {
  let itemCount = 0
  let completedItemCount = 0
  let itemsTotal = 0
  let completedCost = 0
  for (const room of rooms) {
    for (const section of room.sections) {
      for (const item of section.items) {
        const total = projectItemTotal(item)
        itemCount += 1
        itemsTotal += total
        if (isProjectItemCompleted(item, storedStatus)) {
          completedItemCount += 1
          completedCost += total
        }
      }
    }
  }
  const derivedStatus: ProjectStatus = itemCount === 0
    ? storedStatus
    : completedItemCount === itemCount
      ? 'completed'
      : completedItemCount > 0
        ? 'active'
        : 'planned'
  const completionPercent = itemsTotal > 0.01
    ? Math.min(100, Math.max(0, (completedCost / itemsTotal) * 100))
    : itemCount > 0
      ? (completedItemCount / itemCount) * 100
      : derivedStatus === 'completed'
        ? 100
        : 0
  return { itemCount, completedItemCount, itemsTotal, completedCost, derivedStatus, completionPercent }
}

export const projectCompletion = (project: AssetSummary): ProjectCompletionSummary =>
  projectRoomsCompletion(projectRooms(project), project.status ?? 'completed')

export const projectPlanningTotal = (project: AssetSummary, completion?: ProjectCompletionSummary) => {
  const summary = completion ?? projectCompletion(project)
  return summary.itemsTotal > 0.01 ? summary.itemsTotal : numericAmount(project.total_cost)
}

export const projectItemsStatus = (items: AssetDetailItem[], storedStatus: ProjectStatus | undefined): ProjectStatus => {
  if (!items.length) {
    return 'planned'
  }
  const done = items.filter((item) => isProjectItemCompleted(item, storedStatus)).length
  return done === items.length ? 'completed' : done > 0 ? 'active' : 'planned'
}

/** Like `projectItemsStatus`, but also accounts for a section's linked
 * (sub-)projects — a section is only "completed" once its own items AND
 * every linked project are done. */
export const sectionStatusWithProjects = (
  section: AssetDetailSection,
  storedStatus: ProjectStatus | undefined,
  linked: AssetSummary[],
): ProjectStatus => {
  const flags = [
    ...section.items.map((item) => isProjectItemCompleted(item, storedStatus)),
    ...linked.map((project) => (project.derived_status ?? project.status) === 'completed'),
  ]
  if (!flags.length) {
    return 'planned'
  }
  const done = flags.filter(Boolean).length
  return done === flags.length ? 'completed' : done > 0 ? 'active' : 'planned'
}

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  planned: 'Not started',
  active: 'In progress',
  completed: 'Completed',
}

/** Optional accent colors a user can assign to a project (key -> hex). The
 * empty key falls back to status-based coloring. */
export const PROJECT_COLORS: Array<{ value: string; label: string; color: string }> = [
  { value: '', label: 'By status', color: '' },
  { value: 'blue', label: 'Blue', color: '#3b82f6' },
  { value: 'teal', label: 'Teal', color: '#14b8a6' },
  { value: 'green', label: 'Green', color: '#22c55e' },
  { value: 'amber', label: 'Amber', color: '#f59e0b' },
  { value: 'red', label: 'Red', color: '#ef4444' },
  { value: 'purple', label: 'Purple', color: '#8b5cf6' },
  { value: 'pink', label: 'Pink', color: '#ec4899' },
  { value: 'slate', label: 'Slate', color: '#64748b' },
]

export const projectColorKey = (project: Pick<AssetSummary, 'details'>): string => {
  const key = project.details?.color
  return typeof key === 'string' && PROJECT_COLORS.some((option) => option.value === key && key) ? key : ''
}

export const projectColorValue = (key: string): string =>
  PROJECT_COLORS.find((option) => option.value === key)?.color ?? ''
