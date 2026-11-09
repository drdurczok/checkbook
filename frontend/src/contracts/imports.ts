export interface ImportRun {
  id: string
  source_type: string
  status: string
  counts: Record<string, unknown>
  warnings: Array<Record<string, unknown>>
  started_at: string
  finished_at: string | null
}

export interface RawDataColumn {
  key: string
  label: string
}

export interface RawDataTable {
  key: string
  label: string
  count: number
  columns: RawDataColumn[]
  rows: Array<Record<string, unknown>>
}

export interface RawDataResponse {
  tables: RawDataTable[]
}
