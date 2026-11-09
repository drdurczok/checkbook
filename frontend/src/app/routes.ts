export type TabKey = 'overview' | 'planning' | 'income' | 'expenses' | 'assets' | 'imports' | 'settings'

export const TAB_PATHS: Record<TabKey, string> = {
  overview: '/',
  planning: '/planning',
  income: '/income',
  expenses: '/expenses',
  assets: '/assets',
  imports: '/imports',
  settings: '/settings',
}

export const PAYDAY_PLANNER_PATH = TAB_PATHS.planning

export const PAYDAY_PLANNER_ANALYZE_PATH = `${PAYDAY_PLANNER_PATH}/analyze`

/** Retired paths for the renamed Assets page. They still resolve to the
 * assets tab while the shell redirects the URL to /assets. */
export const LEGACY_ASSETS_ALIASES = ['/properties']

export function isLegacyAssetsPath(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, '')
  return LEGACY_ASSETS_ALIASES.includes(normalized)
}

export function isPaydayPlannerAnalysisPath(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, '')
  return [PAYDAY_PLANNER_ANALYZE_PATH, '/planning/payday-planner/analyze', '/income/payday-planner/analyze'].includes(normalized)
}

export function isPaydayPlannerPath(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, '')
  return [PAYDAY_PLANNER_PATH, '/planning/payday-planner', '/income/payday-planner'].includes(normalized)
}

export function tabFromPath(pathname: string): TabKey {
  const normalized = pathname !== '/' ? pathname.replace(/\/+$/, '') : pathname
  if (isPaydayPlannerPath(normalized) || isPaydayPlannerAnalysisPath(normalized)) return 'planning'
  if (isLegacyAssetsPath(normalized)) return 'assets'
  return (Object.entries(TAB_PATHS).find(([, path]) => path === normalized)?.[0] as TabKey | undefined) ?? 'overview'
}
