import { describe, expect, it } from 'vitest'
import type { AssetDetailItem, AssetDetailRoom, AssetSummary, ProjectStatus } from '../types'
import { projectCompletion, projectPlanningTotal, projectRoomsCompletion } from './projects'

const roomsWith = (...items: AssetDetailItem[]): AssetDetailRoom[] => [
  { name: 'Room', total: 999, sections: [{ name: 'Section', total: 999, items }] },
]
const projectWith = (rooms: AssetDetailRoom[], status?: ProjectStatus): AssetSummary => ({
  id: 'project-1', name: 'Project', total_cost: 123, valuation_date: '2026-01-01',
  details: { rooms }, status,
})

describe('projectRoomsCompletion', () => {
  it.each(['planned', 'active', 'completed'] as const)('retains %s status without items', (status) => {
    expect(projectRoomsCompletion([], status)).toEqual({
      itemCount: 0, completedItemCount: 0, itemsTotal: 0, completedCost: 0,
      derivedStatus: status, completionPercent: status === 'completed' ? 100 : 0,
    })
  })

  it('weights progress by item cost across rooms and sections, without using stored totals', () => {
    const rooms = [
      ...roomsWith({ name: 'Done', unit_price: '2.5', quantity: '4', total_cost: 999, completed: true }),
      { name: 'Other room', total: 999, sections: [
        { name: 'First', total: 999, items: [{ name: 'Pending', total_cost: 20, completed: false }] },
        { name: 'Second', total: 999, items: [{ name: 'Pending', total_cost: 10, completed: false }] },
      ] },
    ]
    expect(projectRoomsCompletion(rooms, 'planned')).toEqual({
      itemCount: 3, completedItemCount: 1, itemsTotal: 40, completedCost: 10,
      derivedStatus: 'active', completionPercent: 25,
    })
  })

  it.each(['planned', 'active', 'completed'] as const)('uses stored %s status for legacy missing completion flags', (status) => {
    const result = projectRoomsCompletion(roomsWith({ name: 'Legacy', total_cost: 5 }), status)
    expect(result.completedItemCount).toBe(status === 'completed' ? 1 : 0)
    expect(result.derivedStatus).toBe(status === 'completed' ? 'completed' : 'planned')
  })

  it('lets explicit completion flags override stored status', () => {
    expect(projectRoomsCompletion(roomsWith({ name: 'Pending', total_cost: 5, completed: false }), 'completed').derivedStatus).toBe('planned')
    expect(projectRoomsCompletion(roomsWith({ name: 'Done', total_cost: 5, completed: true }), 'planned').derivedStatus).toBe('completed')
  })

  it.each([0, 0.01, 0.02])('preserves the strict monetary progress threshold at %s', (total) => {
    const result = projectRoomsCompletion(roomsWith(
      { name: 'Free completed item', total_cost: 0, completed: true },
      { name: 'Pending', total_cost: total, completed: false },
    ), 'planned')
    expect(result.completionPercent).toBe(total > 0.01 ? 0 : 50)
  })

  it.each([
    { completedCost: -1, pendingCost: 2, percent: 0 },
    { completedCost: 2, pendingCost: -1, percent: 100 },
  ])('clamps weighted progress to $percent', ({ completedCost, pendingCost, percent }) => {
    expect(projectRoomsCompletion(roomsWith(
      { name: 'Done', total_cost: completedCost, completed: true },
      { name: 'Pending', total_cost: pendingCost, completed: false },
    ), 'active').completionPercent).toBe(percent)
  })
})

describe('project completion wrappers', () => {
  it('defaults missing project status to completed', () => {
    const rooms = roomsWith({ name: 'Legacy', total_cost: 5 })
    expect(projectCompletion(projectWith(rooms))).toEqual(projectRoomsCompletion(rooms, 'completed'))
    expect(projectCompletion(projectWith([])).completionPercent).toBe(100)
  })

  it.each([0, 0.01, 0.02])('keeps planning total fallback independent of item count at %s', (total) => {
    const project = projectWith(roomsWith({ name: 'Item', total_cost: total }), 'planned')
    const completion = projectCompletion(project)
    expect(completion.itemCount).toBe(1)
    expect(completion.itemsTotal).toBe(total)
    expect(projectPlanningTotal(project)).toBe(total > 0.01 ? total : 123)
    expect(projectPlanningTotal(project, completion)).toBe(total > 0.01 ? total : 123)
  })
})
