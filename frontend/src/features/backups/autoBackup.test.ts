import { describe, expect, it } from 'vitest'
import type { BackupEntry } from '../../contracts/backups'
import {
  AUTO_BACKUP_INTERVAL_MS,
  AUTO_BACKUP_RETENTION,
  connectionAllowsBackup,
  isBackupDue,
  pruneNames,
  type NetworkSnapshot,
} from './autoBackup'

const DAY = AUTO_BACKUP_INTERVAL_MS
const now = new Date('2026-07-01T12:00:00Z')
const wifi = (overrides: Partial<NetworkSnapshot> = {}): NetworkSnapshot => ({ online: true, ...overrides })

function entry(name: string, createdOffsetMs: number): BackupEntry {
  return { name, size: 10, created_at: new Date(now.getTime() - createdOffsetMs).toISOString() }
}

describe('connectionAllowsBackup', () => {
  it('allows wi-fi, ethernet, and unknown connections', () => {
    expect(connectionAllowsBackup(wifi({ type: 'wifi' }))).toBe(true)
    expect(connectionAllowsBackup(wifi({ type: 'ethernet' }))).toBe(true)
    expect(connectionAllowsBackup(wifi())).toBe(true)
  })

  it('blocks offline, data-saver, and cellular connections', () => {
    expect(connectionAllowsBackup(wifi({ online: false }))).toBe(false)
    expect(connectionAllowsBackup(wifi({ saveData: true }))).toBe(false)
    expect(connectionAllowsBackup(wifi({ type: 'cellular' }))).toBe(false)
    expect(connectionAllowsBackup(wifi({ type: 'wimax' }))).toBe(false)
  })

  it('blocks slow effective types that indicate a mobile link', () => {
    expect(connectionAllowsBackup(wifi({ effectiveType: '2g' }))).toBe(false)
    expect(connectionAllowsBackup(wifi({ effectiveType: '3g' }))).toBe(false)
    expect(connectionAllowsBackup(wifi({ effectiveType: '4g' }))).toBe(true)
  })
})

describe('isBackupDue', () => {
  it('is due when no backup exists yet or the timestamp is unusable', () => {
    expect(isBackupDue(null, now)).toBe(true)
    expect(isBackupDue(undefined, now)).toBe(true)
    expect(isBackupDue('not-a-date', now)).toBe(true)
  })

  it('is due only once the newest backup is older than 24 hours', () => {
    expect(isBackupDue(new Date(now.getTime() - DAY).toISOString(), now)).toBe(true)
    expect(isBackupDue(new Date(now.getTime() - DAY + 1).toISOString(), now)).toBe(false)
    expect(isBackupDue(new Date(now.getTime() - DAY / 2).toISOString(), now)).toBe(false)
  })
})

describe('pruneNames', () => {
  it('keeps the 30 newest and prunes the rest regardless of input order', () => {
    const entries = Array.from({ length: 35 }, (_, index) => entry(`checkbook-backup-${String(35 - index).padStart(2, '0')}.zip`, index * 60_000))
    const pruned = pruneNames(entries)
    expect(pruned).toHaveLength(35 - AUTO_BACKUP_RETENTION)
    // The oldest five go; the newest thirty stay.
    expect(pruned).toEqual(['checkbook-backup-05.zip', 'checkbook-backup-04.zip', 'checkbook-backup-03.zip', 'checkbook-backup-02.zip', 'checkbook-backup-01.zip'])
  })

  it('prunes nothing at or below the retention count', () => {
    expect(pruneNames([])).toEqual([])
    expect(pruneNames(Array.from({ length: 30 }, (_, index) => entry(`b-${index}`, index)))).toEqual([])
  })

  it('breaks timestamp ties by descending name, mirroring the server order', () => {
    const olderName = 'checkbook-backup-20260101-000000-aaa.zip'
    const newerName = 'checkbook-backup-20260101-000000-bbb.zip'
    expect(pruneNames([entry(olderName, 0), entry(newerName, 0)], 1)).toEqual([olderName])
  })
})
