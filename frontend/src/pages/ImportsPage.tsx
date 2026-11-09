import { useEffect, useState } from 'react'
import { EmptyState, SectionPanel } from '../components/panel'
import { Button } from '../components/ui/Button'
import { useImportsQuery } from '../features/imports/queries'
import { fmtDate, formatRawValue } from '../lib/format'
import { useSession } from '../lib/session'
import type { ImportRun } from '../contracts/imports'

const visibleImports = (runs: ImportRun[]) => runs.slice(0, 5)

const countOf = (counts: Record<string, unknown>, key: string) => {
  const value = counts[key]
  return typeof value === 'number' ? value : 0
}

const importSummary = (run: ImportRun) => {
  const inserted = countOf(run.counts, 'inserted')
  const updated = countOf(run.counts, 'updated')
  const failed = countOf(run.counts, 'failed')
  const skipped = countOf(run.counts, 'skipped')
  const parts = [`${inserted} new`, `${updated} updated`]

  if (skipped) {
    parts.push(`${skipped} skipped`)
  }
  if (failed) {
    parts.push(`${failed} failed`)
  }
  if (run.warnings.length) {
    parts.push(`${run.warnings.length} warnings`)
  }
  return parts.join(' - ')
}

const warningSummary = (run: ImportRun) => {
  const firstWarning = run.warnings[0]
  const message = firstWarning?.message
  return typeof message === 'string' ? message : ''
}

export function ImportsPage() {
  const { token, currency, setError } = useSession()
  const [rawTab, setRawTab] = useState('asset_projects')
  const importsQuery = useImportsQuery(token)
  const imports = importsQuery.data?.history ?? []
  const rawData = importsQuery.data?.rawData ?? null

  useEffect(() => {
    if (importsQuery.error) {
      setError(importsQuery.error instanceof Error ? importsQuery.error.message : 'Failed to refresh workspace.')
    }
  }, [importsQuery.error, setError])

  const resolvedRawTab = rawData?.tables.some((table) => table.key === rawTab)
    ? rawTab
    : rawData?.tables[0]?.key ?? 'asset_projects'
  const activeRawTable = rawData?.tables.find((table) => table.key === resolvedRawTab)

  return (
    <div className="page-stack">
      <SectionPanel
        title="Import history"
        eyebrow="Bulk data loads"
        actions={
          <Button
            variant="secondary"
            onClick={() => void importsQuery.refetch()}
            type="button"
          >
            {importsQuery.isFetching ? 'Refreshing...' : 'Refresh'}
          </Button>
        }
      >
        {imports.length ? (
          <div className="list">
            {visibleImports(imports).map((run) => (
              <div className="list-row" key={run.id}>
                <div>
                  <strong>Bulk import</strong>
                  <span>
                    {run.status} - {fmtDate(run.finished_at ?? run.started_at)}
                  </span>
                  {warningSummary(run) ? <span>{warningSummary(run)}</span> : null}
                </div>
                <strong>{importSummary(run)}</strong>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No imports yet"
            body="Data is loaded through the bulk import API; integrations will appear here once connected."
          />
        )}
      </SectionPanel>

      <SectionPanel
        title="Database state"
        eyebrow="Raw imported data"
        actions={
          <Button
            variant="secondary"
            onClick={() => void importsQuery.refetch()}
            type="button"
          >
            {importsQuery.isFetching ? 'Refreshing...' : 'Refresh'}
          </Button>
        }
      >
        {rawData?.tables.length && activeRawTable ? (
          <div className="raw-data-view">
            <div className="raw-tabs" role="tablist" aria-label="Database tables">
              {rawData.tables.map((table) => (
                <button
                  aria-selected={table.key === activeRawTable.key}
                  className={table.key === activeRawTable.key ? 'active' : ''}
                  key={table.key}
                  onClick={() => setRawTab(table.key)}
                  role="tab"
                  type="button"
                >
                  <span>{table.label}</span>
                  <strong>{table.count}</strong>
                </button>
              ))}
            </div>

            {activeRawTable.rows.length ? (
              <div className="raw-table-shell">
                <table className="raw-table">
                  <thead>
                    <tr>
                      {activeRawTable.columns.map((column) => (
                        <th key={column.key}>{column.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {activeRawTable.rows.map((row, rowIndex) => (
                      <tr key={`${activeRawTable.key}-${rowIndex}`}>
                        {activeRawTable.columns.map((column) => (
                          <td
                            className={column.key.includes('payload') ? 'raw-table__payload' : undefined}
                            key={column.key}
                          >
                            {formatRawValue(column.key, row[column.key], currency)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                title={`No ${activeRawTable.label.toLowerCase()}`}
                body="This table has no rows yet."
              />
            )}
          </div>
        ) : (
          <EmptyState
            title="No raw data"
            body="Loaded data will appear here once an import runs."
          />
        )}
      </SectionPanel>
    </div>
  )
}
