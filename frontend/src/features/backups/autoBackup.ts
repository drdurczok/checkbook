import { useEffect } from 'react'
import { api } from '../../lib/api'
import type { BackupEntry } from '../../contracts/backups'

/** How long the newest backup may age before another one is attempted. */
export const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000
/** How many backups the automatic policy keeps. */
export const AUTO_BACKUP_RETENTION = 30
/** How often an open app re-checks the backup conditions. */
const CHECK_INTERVAL_MS = 15 * 60 * 1000
/** Cross-tab throttle: at most one condition check every 10 minutes. */
const CHECK_THROTTLE_MS = 10 * 60 * 1000
const CHECK_AT_KEY = 'checkbook.autoBackup.checkedAt'

/** The slice of the (Chromium) Network Information API the policy needs. */
export type NetworkSnapshot = {
  online: boolean
  type?: string
  effectiveType?: string
  saveData?: boolean
}

type NetworkInformationLike = {
  type?: string
  effectiveType?: string
  saveData?: boolean
}

/** Metered connection types reported by `navigator.connection.type`. */
const METERED_TYPES = new Set(['cellular', 'wimax'])
/** Effective types that only occur on slow (typically cellular) links. */
const SLOW_EFFECTIVE_TYPES = new Set(['2g', '3g'])

export function readNetworkSnapshot(): NetworkSnapshot {
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection
  return {
    online: typeof navigator.onLine === 'boolean' ? navigator.onLine : true,
    type: connection?.type,
    effectiveType: connection?.effectiveType,
    saveData: connection?.saveData,
  }
}

/**
 * Automatic backups run only on unmetered, non-cellular links: the archive is
 * written by the server to the NAS folder, and the browser only issues the
 * trigger request, so the gate exists to keep it off mobile data. Wi-Fi,
 * Ethernet, and unknown (the API is Chromium-only) are all allowed.
 */
export function connectionAllowsBackup(network: NetworkSnapshot): boolean {
  if (!network.online) return false
  if (network.saveData) return false
  if (network.type !== undefined && METERED_TYPES.has(network.type)) return false
  if (network.effectiveType !== undefined && SLOW_EFFECTIVE_TYPES.has(network.effectiveType)) return false
  return true
}

/** A backup is due when there is none yet, or the newest is older than a day. */
export function isBackupDue(lastBackupAt: string | null | undefined, now: Date, intervalMs = AUTO_BACKUP_INTERVAL_MS): boolean {
  if (!lastBackupAt) return true
  const lastBackup = Date.parse(lastBackupAt)
  if (Number.isNaN(lastBackup)) return true
  return now.getTime() - lastBackup >= intervalMs
}

/** Names of everything beyond the newest `keep` backups (newest-first list). */
export function pruneNames(entries: BackupEntry[], keep = AUTO_BACKUP_RETENTION): string[] {
  if (entries.length <= keep) return []
  const ordered = [...entries].sort((left, right) => {
    const byDate = Date.parse(right.created_at) - Date.parse(left.created_at)
    return byDate !== 0 ? byDate : right.name.localeCompare(left.name)
  })
  return ordered.slice(keep).map((entry) => entry.name)
}

let attemptInFlight = false

/**
 * Runs one automatic-backup attempt: no-op unless a NAS folder is configured,
 * the newest backup is over a day old, and the connection is unmetered. The
 * server enforces the configured retention on write; the automatic policy
 * additionally prunes to its own 30-backup cap. Failures are silent — this is
 * a background best-effort task and the next check retries.
 */
export async function attemptAutoBackup(token: string): Promise<void> {
  if (attemptInFlight) return
  const lastCheckAt = Number(window.localStorage.getItem(CHECK_AT_KEY) ?? 0)
  if (Number.isFinite(lastCheckAt) && Date.now() - lastCheckAt < CHECK_THROTTLE_MS) return
  window.localStorage.setItem(CHECK_AT_KEY, String(Date.now()))
  attemptInFlight = true
  try {
    const config = await api.getBackupConfig(token)
    if (!config || !String(config.path ?? '').trim()) return
    if (!connectionAllowsBackup(readNetworkSnapshot())) return
    const backups = await api.listBackups(token)
    if (!isBackupDue(backups[0]?.created_at, new Date())) return
    await api.createBackup(token)
    const latest = await api.listBackups(token)
    for (const name of pruneNames(latest)) {
      await api.deleteBackup(token, name)
    }
  } catch (error) {
    console.debug('Automatic backup attempt skipped:', error)
  } finally {
    attemptInFlight = false
  }
}

/** Mounted once in the authenticated shell: keeps checking while the app is
 * open, and re-checks when the tab becomes visible or connectivity returns. */
export function useAutoBackups(token: string | null): void {
  useEffect(() => {
    if (!token) return
    const check = () => {
      void attemptAutoBackup(token)
    }
    check()
    const interval = window.setInterval(check, CHECK_INTERVAL_MS)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') check()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', check)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', check)
    }
  }, [token])
}
