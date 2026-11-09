import { FileInput } from './ui/NativeControls'
import { OutlinedInput } from './ui/OutlinedField'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileDown,
  FolderSync,
  HardDriveDownload,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Upload,
} from 'lucide-react'
import { Modal } from './Modal'
import { api } from '../lib/api'
import { useSession } from '../lib/session'
import type { BackupConfig, BackupEntry, BackupTestResult } from '../types'

type ConfirmState =
  | { kind: 'restore'; name: string }
  | { kind: 'import'; file: File }
  | null

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`
}

function formatDate(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleString()
}

/**
 * Full-backup control panel surfaced from the user menu: point the household at
 * a NAS folder, snapshot/restore JSON backups stored there, and import/export
 * data. Restore and import are destructive (they replace every record) so both
 * route through an inline "are you sure" confirmation before running, after
 * which the page reloads to pick up the swapped-in data.
 */
export function BackupsModal({ onClose }: { onClose: () => void }) {
  const { token, setError, setMessage } = useSession()
  const [busy, setBusy] = useState<string | null>(null)
  const [config, setConfig] = useState<BackupConfig>({ path: '', retention: 0 })
  const [backups, setBackups] = useState<BackupEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [testResult, setTestResult] = useState<BackupTestResult | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const confirmCancelRef = useRef<HTMLButtonElement | null>(null)
  const restoring = busy === 'backup-import' || busy === 'backup-restore'
  // The inline destructive confirmation is an alert inside this dialog: focus
  // the safe action when it appears so keyboard users land on Cancel first.
  useEffect(() => {
    if (confirm) {
      confirmCancelRef.current?.focus()
    }
  }, [confirm])

  const refreshBackups = useCallback(async () => {
    try {
      setBackups(await api.listBackups(token))
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not list backups.')
    }
  }, [token, setError])

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const [loadedConfig, entries] = await Promise.all([
          api.getBackupConfig(token),
          api.listBackups(token),
        ])
        if (!cancelled) {
          setConfig(loadedConfig)
          setBackups(entries)
        }
      } catch (nextError) {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : 'Could not load backups.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [token, setError])

  async function saveConfig() {
    setBusy('backup-config')
    setError(null)
    try {
      const saved = await api.updateBackupConfig(token, { path: config.path.trim(), retention: config.retention })
      setConfig(saved)
      setMessage('Backup location saved.')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not save backup location.')
    } finally {
      setBusy(null)
    }
  }

  async function testConnection() {
    setBusy('backup-test')
    setError(null)
    setTestResult(null)
    try {
      setTestResult(await api.testBackupLocation(token, { path: config.path.trim(), retention: config.retention }))
    } catch (nextError) {
      setTestResult({ ok: false, message: nextError instanceof Error ? nextError.message : 'Connection test failed.' })
    } finally {
      setBusy(null)
    }
  }

  async function createBackup() {
    setBusy('backup-create')
    setError(null)
    try {
      await api.createBackup(token)
      await refreshBackups()
      setMessage('Backup created.')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Backup failed.')
    } finally {
      setBusy(null)
    }
  }

  async function downloadBlob(blob: Blob, filename: string) {
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.URL.revokeObjectURL(url)
  }

  async function exportCsv() {
    setBusy('backup-export')
    setError(null)
    try {
      await downloadBlob(await api.exportCsv(token), 'checkbook-export.zip')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Export failed.')
    } finally {
      setBusy(null)
    }
  }

  async function downloadBackup(name: string) {
    setBusy(`backup-download-${name}`)
    setError(null)
    try {
      await downloadBlob(await api.downloadBackup(token, name), name)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Download failed.')
    } finally {
      setBusy(null)
    }
  }

  async function deleteBackup(name: string) {
    setBusy(`backup-delete-${name}`)
    setError(null)
    try {
      await api.deleteBackup(token, name)
      await refreshBackups()
      setMessage('Backup deleted.')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not delete backup.')
    } finally {
      setBusy(null)
    }
  }

  function onPickImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) setConfirm({ kind: 'import', file })
  }

  async function runConfirm() {
    if (!confirm) return
    setBusy(confirm.kind === 'import' ? 'backup-import' : 'backup-restore')
    setError(null)
    try {
      if (confirm.kind === 'import') {
        await api.importBackup(token, confirm.file)
      } else {
        await api.restoreBackup(token, confirm.name)
      }
      setConfirm(null)
      window.location.reload()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not replace data.')
      setBusy(null)
    }
  }

  let backupsBody
  if (loading) {
    backupsBody = (
      <p className="backups-empty"><Loader2 className="h-4 w-4 animate-spin" /> Loading backups…</p>
    )
  } else if (backups.length === 0) {
    backupsBody = <p className="backups-empty">No backups yet. Create one to get started.</p>
  } else {
    backupsBody = (
      <ul className="backups-list">
        {backups.map((entry) => (
          <li className="backups-row" key={entry.name}>
            <div className="backups-row__meta">
              <strong>{formatDate(entry.created_at)}</strong>
              <span>{formatBytes(entry.size)}</span>
            </div>
            <div className="backups-row__actions">
              <button
                className="button button--ghost button--compact"
                disabled={busy !== null}
                onClick={() => setConfirm({ kind: 'restore', name: entry.name })}
                type="button"
              >
                <RotateCcw className="h-4 w-4" />
                <span>Restore</span>
              </button>
              <button
                aria-label="Download backup"
                className="button button--ghost button--compact"
                disabled={busy !== null}
                onClick={() => void downloadBackup(entry.name)}
                type="button"
              >
                <Download className="h-4 w-4" />
              </button>
              <button
                aria-label="Delete backup"
                className="button button--ghost button--compact backups-row__delete"
                disabled={busy !== null}
                onClick={() => void deleteBackup(entry.name)}
                type="button"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </li>
        ))}
      </ul>
    )
  }

  return (
    <Modal
      className="quick-add-modal backups-modal"
      eyebrow="Data & backups"
      title="Backups"
      titleId="backups-title"
      onClose={onClose}
    >
      <div className="backups-body">
        {confirm ? (
          <div className="backups-confirm" role="alert" aria-label="Confirm destructive action">
            <span className="backups-confirm__icon"><AlertTriangle className="h-5 w-5" /></span>
            <div className="backups-confirm__text">
              <strong>This erases all current data</strong>
              <p>
                {confirm.kind === 'import'
                  ? `Importing "${confirm.file.name}" replaces every record in this household. This cannot be undone.`
                  : `Restoring this backup replaces every record in this household. This cannot be undone.`}
              </p>
            </div>
            <div className="backups-confirm__actions">
              <button ref={confirmCancelRef} className="button button--ghost" disabled={restoring} onClick={() => setConfirm(null)} type="button">
                Cancel
              </button>
              <button className="button button--danger" disabled={restoring} onClick={() => void runConfirm()} type="button">
                {restoring ? 'Replacing…' : 'Yes, replace everything'}
              </button>
            </div>
          </div>
        ) : null}

        <section className="backups-section">
          <header className="backups-section__head">
            <FolderSync className="h-4 w-4" />
            <div>
              <h3>NAS folder</h3>
              <p>Path to a mounted folder on your NAS (e.g. an NFS share). Backups are written here.</p>
            </div>
          </header>
          <div className="backups-field-row">
            <OutlinedInput id="backup-path" label="Backup folder path" className="backups-path"
                onChange={(event) => {
                  const path = event.target.value
                  setConfig((current) => ({ ...current, path }))
                  setTestResult(null)
                }}
                placeholder="/mnt/nas/checkbook"
                type="text"
                value={config.path}
              />
            <OutlinedInput id="backup-retention" label="Keep last" className="backups-retention"
                max={365}
                min={0}
                onChange={(event) => {
                  const retention = Number(event.target.value)
                  setConfig((current) => ({ ...current, retention: Number.isFinite(retention) ? retention : 0 }))
                }}
                type="number"
                value={config.retention}
              />
          </div>
          <p className="backups-hint">Keep last 0 stores every backup; any other number prunes older backups beyond that count.</p>
          <p className="backups-hint">
            Automatic backups: while the app is open over Wi-Fi, a new backup is written when the newest one is over 24 hours old, keeping the 30 newest.
            {backups[0] ? ` Last backup ${formatDate(backups[0].created_at)}.` : ''}
          </p>
          {testResult ? (
            <p className={`backups-test ${testResult.ok ? 'is-ok' : 'is-bad'}`}>
              {testResult.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
              {testResult.message}
            </p>
          ) : null}
          <div className="backups-section__actions">
            <button className="button button--ghost" disabled={busy === 'backup-test'} onClick={() => void testConnection()} type="button">
              {busy === 'backup-test' ? 'Testing…' : 'Test connection'}
            </button>
            <button className="button" disabled={busy === 'backup-config'} onClick={() => void saveConfig()} type="button">
              <Save className="h-4 w-4" />
              {busy === 'backup-config' ? 'Saving…' : 'Save location'}
            </button>
          </div>
        </section>

        <section className="backups-section">
          <header className="backups-section__head">
            <HardDriveDownload className="h-4 w-4" />
            <div>
              <h3>Available backups</h3>
              <p>Full JSON snapshots stored in your NAS folder.</p>
            </div>
          </header>
          {backupsBody}
          <div className="backups-section__actions">
            <button className="button" disabled={busy === 'backup-create'} onClick={() => void createBackup()} type="button">
              <Plus className="h-4 w-4" />
              {busy === 'backup-create' ? 'Creating…' : 'Create backup'}
            </button>
          </div>
        </section>

        <section className="backups-section">
          <header className="backups-section__head">
            <FileDown className="h-4 w-4" />
            <div>
              <h3>Import &amp; export</h3>
              <p>Download a CSV bundle to your computer, or import a snapshot/CSV to replace all data.</p>
            </div>
          </header>
          <div className="backups-section__actions backups-section__actions--split">
            <button className="button button--ghost" disabled={busy === 'backup-export'} onClick={() => void exportCsv()} type="button">
              <Download className="h-4 w-4" />
              {busy === 'backup-export' ? 'Exporting…' : 'Export CSV'}
            </button>
            <button className="button button--ghost" disabled={busy !== null} onClick={() => fileInputRef.current?.click()} type="button">
              <Upload className="h-4 w-4" />
              Import backup or CSV
            </button>
            <FileInput
              accept=".json,.zip,.csv"
              className="sr-only"
              onChange={onPickImport}
              ref={fileInputRef}

            />
          </div>
        </section>
      </div>
    </Modal>
  )
}
