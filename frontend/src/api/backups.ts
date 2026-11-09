import type { BackupConfig, BackupEntry, BackupRestoreResult, BackupTestResult } from '../contracts/backups'
import { API_BASE, request, requestBlob } from './http'

export const backupsApi = {
  getBackupConfig: (token: string) => request<BackupConfig>('/backups/config', { token }),
  updateBackupConfig: (token: string, payload: BackupConfig) =>
    request<BackupConfig>('/backups/config', { method: 'PUT', token, body: payload }),
  testBackupLocation: (token: string, payload: BackupConfig) =>
    request<BackupTestResult>('/backups/test', { method: 'POST', token, body: payload }),
  listBackups: (token: string) => request<BackupEntry[]>('/backups', { token }),
  createBackup: (token: string) => request<BackupEntry>('/backups', { method: 'POST', token }),
  deleteBackup: (token: string, name: string) =>
    request<BackupRestoreResult>(`/backups/${encodeURIComponent(name)}`, { method: 'DELETE', token }),
  restoreBackup: (token: string, name: string) =>
    request<BackupRestoreResult>(`/backups/${encodeURIComponent(name)}/restore`, { method: 'POST', token }),
  downloadBackup: (token: string, name: string) =>
    requestBlob(`/backups/${encodeURIComponent(name)}/download`, token),
  exportCsv: (token: string) => requestBlob('/backups/export.csv', token),
  importBackup: async (token: string, file: File): Promise<BackupRestoreResult> => {
    const form = new FormData()
    form.append('file', file)
    const response = await fetch(`${API_BASE}/backups/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    })
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { detail?: string } | null
      throw new Error(payload?.detail ?? `Request failed with status ${response.status}`)
    }
    return (await response.json()) as BackupRestoreResult
  },
}
