export interface BackupConfig {
  path: string
  retention: number
}

export interface BackupEntry {
  name: string
  size: number
  created_at: string
}

export interface BackupTestResult {
  ok: boolean
  message: string
}

export interface BackupRestoreResult {
  ok: boolean
  restored: Record<string, number>
}
