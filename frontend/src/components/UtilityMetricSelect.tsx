import { HeaderSelect } from './HeaderSelect'

export type UtilityMetric = 'money' | 'usage' | 'rate'

const METRIC_OPTIONS = [
  { value: 'money', label: 'Money' },
  { value: 'usage', label: 'Usage' },
  { value: 'rate', label: 'Unit price' },
]

/** The Money/Usage/Unit price chart metric picker, as the shared header
 * select so panel headers keep one dropdown idiom across pages. */
export function UtilityMetricSelect({ value, onChange }: {
  value: UtilityMetric
  onChange: (value: UtilityMetric) => void
}) {
  return (
    <HeaderSelect
      ariaLabel="Utility chart metric"
      groups={[{ options: METRIC_OPTIONS }]}
      menuAlign="end"
      triggerClassName="utility-metric-trigger"
      value={value}
      onChange={(next) => {
        if (next === 'money' || next === 'usage' || next === 'rate') {
          onChange(next)
        }
      }}
    />
  )
}
