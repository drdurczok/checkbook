import { useState } from 'react'
import { DetailModal } from './DetailModal'
import { DetailActionsMenu } from './DetailActionsMenu'
import { MonthTableShell, YearDividerRow, groupRowsByYear, monthNumberLabel } from './MonthTable'
import { fmtNumber } from '../lib/format'
import type { UtilitySeriesPoint } from '../contracts/dashboard'
import { nextAvailableMonth } from '../lib/months'

type DetailsMetric = 'money' | 'meters'

export function UtilitiesDetailsModal({ points, categories, categoryLabels = {}, categoryColors = {}, currency, timeZone, onClose, onEditMonth, onConfiguration }: {
  points: UtilitySeriesPoint[]
  categories: string[]
  categoryLabels?: Record<string, string>
  categoryColors?: Record<string, string>
  currency: string
  timeZone?: string
  onConfiguration?: () => void
  onClose: () => void
  onEditMonth?: (month: string) => void
}) {
  const [metric, setMetric] = useState<DetailsMetric>('money')
  const showMoney = metric === 'money'

  return (
    <DetailModal
      className="net-worth-modal utilities-modal"
      title="Utilities"
      currency={currency}
      titleId="utilities-detail-title"
      onClose={onClose}
      options={(
        <DetailActionsMenu
          label="Table options"
          placement="start"
          actions={[...(onEditMonth ? [{
            label: 'Add month',
            onClick: () => onEditMonth?.(nextAvailableMonth(points.map((point) => point.period), new Date(), timeZone)),
          }] : []), ...(onConfiguration ? [{ label: 'Configuration', onClick: onConfiguration }] : [])]}
        />
      )}
    >
      <div aria-label="Table metric" className="view-toggle utility-details-metric" role="group">
        <button
          aria-pressed={showMoney}
          className={showMoney ? 'is-active' : ''}
          onClick={() => setMetric('money')}
          type="button"
        >
          Money
        </button>
        <button
          aria-pressed={!showMoney}
          className={!showMoney ? 'is-active' : ''}
          onClick={() => setMetric('meters')}
          type="button"
        >
          Meters
        </button>
      </div>
      <div className="overview-details">
        <MonthTableShell className="net-worth-table-shell utility-table-shell">
          <table className="net-worth-table utility-detail-table">
            <thead>
              <tr>
                <th>M</th>
                {showMoney ? <th>Total</th> : null}
                {categories.map((category) => <th key={category}>{categoryColors[category] ? <i aria-hidden="true" className="utility-color-dot" style={{ background: categoryColors[category] }} /> : null}{categoryLabels[category] ?? category}</th>)}
              </tr>
            </thead>
            {groupRowsByYear([...points].reverse(), (point) => point.period).map((group) => (
              <tbody key={group.year}>
                <YearDividerRow columns={(showMoney ? 2 : 1) + categories.length} year={group.year} />
                {group.rows.map((point) => (
                  <tr
                    key={point.period}
                    className="net-worth-table__summary-row"
                    aria-label={`${onEditMonth ? 'Edit' : 'View'} utilities ${point.period}`}
                    tabIndex={onEditMonth ? 0 : undefined}
                    onClick={() => onEditMonth?.(point.period)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onEditMonth?.(point.period)
                      }
                    }}
                  >
                    <th>{monthNumberLabel(point.period)}</th>
                    {showMoney ? <td>{fmtNumber(point.total)}</td> : null}
                    {categories.map((category) => {
                      if (showMoney) {
                        return (
                          <td key={category}>
                            <strong>{point.values[category] == null ? '—' : fmtNumber(point.values[category])}</strong>
                          </td>
                        )
                      }
                      const unit = point.units[category]
                      if (!unit || point.usage[category] == null) {
                        return <td key={category}>—</td>
                      }
                      return (
                        <td key={category}>
                          <strong>{fmtNumber(point.usage[category], 1)}</strong>{' '}
                          <small>{unit}</small>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </MonthTableShell>
      </div>
    </DetailModal>
  )
}
