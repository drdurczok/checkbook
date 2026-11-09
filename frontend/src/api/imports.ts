import type { ImportRun, RawDataResponse } from '../contracts/imports'
import { request } from './http'

export const importsApi = {
  getImportHistory: (token: string) => request<ImportRun[]>('/imports/history', { token }),
  getImportRawData: (token: string) => request<RawDataResponse>('/imports/raw-data', { token }),
  bulkImport: (token: string, payload: unknown) =>
    request<{ run_id: string; counts: unknown }>('/imports/bulk', { method: 'POST', token, body: payload }),
}
