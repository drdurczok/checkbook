import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { UtilityValuesModal } from './UtilityValuesModal'
import { UtilitiesDetailsModal } from '../../components/UtilitiesDetailsModal'
import { UtilityTrendChart } from '../../components/charts'
import { UtilityMetricSelect, type UtilityMetric } from '../../components/UtilityMetricSelect'
import { EmptyState, SectionPanel } from '../../components/panel'
import { useSession } from '../../lib/session'
import { useUtilityBoardQuery, type UtilitySubjectRef } from './queries'

export function SubjectUtilitiesPanel({ subject, onConfiguration, readOnly = false }: { subject: UtilitySubjectRef; onConfiguration?: () => void; readOnly?: boolean }) {
  const { token, currency, session } = useSession()
  const queryClient = useQueryClient()
  const [editingMonth, setEditingMonth] = useState<string | null>(null)
  const [metric, setMetric] = useState<UtilityMetric>('money')
  const [selectedCategory, setSelectedCategory] = useState('total')
  const [isDetailsOpen, setIsDetailsOpen] = useState(false)
  const boardQuery = useUtilityBoardQuery(token, subject, true)
  const board = boardQuery.data ?? null
  const trend = board?.trend ?? []
  const months = board?.months ?? []
  const visibleFields = board?.subject.tracked_fields.filter((field) => !field.hidden) ?? []
  const categoryColors = Object.fromEntries((board?.subject.tracked_fields ?? []).flatMap((field) => field.color ? [[field.key, field.color]] : []))
  const utilityCategories = [...new Set(trend.flatMap((point) => Object.keys(point.values)))].sort()

  return (
    <>
      <SectionPanel
        title="Utilities"
        className="subject-utilities-panel"
        actions={
          <div className="utility-board-actions">
            <UtilityMetricSelect value={metric} onChange={setMetric} />
            <button
              className="button button--compact button--ghost"
              disabled={!board}
              onClick={() => setIsDetailsOpen(true)}
              type="button"
            >
              Details
            </button>
          </div>
        }
      >
        {board ? (
          <UtilityTrendChart
            points={trend}
            categories={utilityCategories}
            categoryColors={categoryColors}
            categoryLabels={Object.fromEntries(visibleFields.map((field) => [field.key, field.label]))}
            selectedCategory={selectedCategory}
            metric={metric}
            currency={currency}
            onCategorySelect={setSelectedCategory}
          />
        ) : (
          <EmptyState title={boardQuery.isPending ? 'Loading' : boardQuery.isError ? 'Unable to load utilities' : 'No utilities'} body="Track meter readings and charges to see the trend here." />
        )}
      </SectionPanel>

      {isDetailsOpen && board ? (
        <UtilitiesDetailsModal
          points={months.map((month) => ({
            period: month.month,
            total: month.total,
            values: Object.fromEntries(visibleFields.flatMap((field) => { const amount = month.values[field.key]?.amount; return amount == null ? [] : [[field.key, amount]] })),
            usage: Object.fromEntries(visibleFields.flatMap((field) => { const usage = month.values[field.key]?.usage_amount; return usage == null ? [] : [[field.key, usage]] })),
            units: Object.fromEntries(visibleFields.map((field) => [field.key, field.unit])),
          }))}
          categories={visibleFields.map((field) => field.key)}
          categoryColors={categoryColors}
          categoryLabels={Object.fromEntries(visibleFields.map((field) => [field.key, field.label]))}
          currency={currency}
          timeZone={session?.household.timezone}
          onClose={() => setIsDetailsOpen(false)}
          onEditMonth={readOnly ? undefined : setEditingMonth}
          onConfiguration={onConfiguration ? () => { setIsDetailsOpen(false); onConfiguration() } : undefined}
        />
      ) : null}

      {editingMonth && board ? (
        <UtilityValuesModal
          key={`${subject.type}-${subject.id}-${editingMonth}`}
          subject={subject}
          subjectName={board.subject.name}
          initialMonth={editingMonth}
          onClose={() => setEditingMonth(null)}
          onSaved={async () => {
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['utility-board'] }),
              queryClient.invalidateQueries({ queryKey: ['expenses'] }),
              queryClient.invalidateQueries({ queryKey: ['overview'] }),
            ])
          }}
        />
      ) : null}
    </>
  )
}
