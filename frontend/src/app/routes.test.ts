import { describe, expect, it } from 'vitest'
import { PAYDAY_PLANNER_ANALYZE_PATH, isPaydayPlannerAnalysisPath, isLegacyAssetsPath, PAYDAY_PLANNER_PATH, TAB_PATHS, tabFromPath, isPaydayPlannerPath } from './routes'

describe('tabFromPath', () => {
  it.each(Object.entries(TAB_PATHS))('maps %s to its route', (tab, path) => {
    expect(tabFromPath(path)).toBe(tab)
  })

  it('recognizes the dedicated planner without creating a separate sidebar tab', () => {
    expect(isPaydayPlannerPath(PAYDAY_PLANNER_PATH)).toBe(true)
    expect(isPaydayPlannerPath(`${PAYDAY_PLANNER_PATH}/`)).toBe(true)
    expect(isPaydayPlannerPath('/income')).toBe(false)
    expect(isPaydayPlannerPath(`${PAYDAY_PLANNER_PATH}/other`)).toBe(false)
    expect(PAYDAY_PLANNER_PATH).toBe('/planning')
    expect(tabFromPath(PAYDAY_PLANNER_PATH)).toBe('planning')
    expect(tabFromPath(`${PAYDAY_PLANNER_PATH}/`)).toBe('planning')
    expect(isPaydayPlannerPath('/income/payday-planner')).toBe(true)
    expect(tabFromPath('/income/payday-planner')).toBe('planning')
  })

  it('recognizes the analysis route within Planning', () => {
    expect(PAYDAY_PLANNER_ANALYZE_PATH).toBe('/planning/analyze')
    expect(isPaydayPlannerAnalysisPath(`${PAYDAY_PLANNER_ANALYZE_PATH}/`)).toBe(true)
    expect(isPaydayPlannerAnalysisPath(PAYDAY_PLANNER_PATH)).toBe(false)
    expect(isPaydayPlannerAnalysisPath(`${PAYDAY_PLANNER_ANALYZE_PATH}/other`)).toBe(false)
    expect(tabFromPath(PAYDAY_PLANNER_ANALYZE_PATH)).toBe('planning')
    expect(tabFromPath(`${PAYDAY_PLANNER_ANALYZE_PATH}/`)).toBe('planning')
  })

  it.each(['/planning/payday-planner', '/income/payday-planner'])('retains legacy deep link %s', (path) => {
    expect(isPaydayPlannerPath(path)).toBe(true)
    expect(tabFromPath(path)).toBe('planning')
    expect(isPaydayPlannerAnalysisPath(`${path}/analyze/`)).toBe(true)
    expect(tabFromPath(`${path}/analyze`)).toBe('planning')
  })

  it('normalizes trailing slashes and unknown paths', () => {
    expect(tabFromPath('/assets/')).toBe('assets')
    // Retired routes fall back to the overview instead of 404ing.
    expect(tabFromPath('/projects/')).toBe('overview')
    expect(tabFromPath('/utilities')).toBe('overview')
    expect(tabFromPath('/not-a-route')).toBe('overview')
  })

  it.each(['/properties', '/properties/'])('resolves the retired assets route %s while the shell redirects it', (path) => {
    expect(isLegacyAssetsPath(path)).toBe(true)
    expect(tabFromPath(path)).toBe('assets')
    expect(isLegacyAssetsPath('/assets')).toBe(false)
    expect(isLegacyAssetsPath('/properties/extra')).toBe(false)
  })
})
