import { useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import Decimal from 'decimal.js'
import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { Button } from '../../components/ui/Button'
import { FormSheet } from '../../components/ui/FormSheet'
import { Checkbox } from '../../components/ui/NativeControls'
import { OutlinedInput } from '../../components/ui/OutlinedField'
import type { NetWorthComponentRow, NetWorthGroupKey, NetWorthMonthPayload } from '../../contracts/dashboard'
import { api } from '../../lib/api'
import { fmtNumber } from '../../lib/format'
import { useSession } from '../../lib/session'
import '../../styles/features/net-worth.css'

import { NET_WORTH_GROUPS } from './model'

type DraftComponent = { id: number; group_key: NetWorthGroupKey; label: string; value: string }

const buildDraft = (source: NetWorthComponentRow): DraftComponent[] =>
  NET_WORTH_GROUPS.flatMap(({ key }) =>
    Object.entries(source[key].components).map(([label, value]) => ({ id: 0, group_key: key, label, value: String(value) })),
  ).map((component, index) => ({ ...component, id: index }))

/** Order-insensitive fingerprint so a reshuffled-but-equal save stays idempotent. */
const componentFingerprint = (components: { group_key: string; label: string; value: string | number }[]) =>
  components.map((component) => `${component.group_key}\u0000${component.label.trim()}\u0000${Number(component.value)}`).sort().join('\u0001')

export function NetWorthMonthEditor({ row, onSaved, onClose, onPeriodChange }: {
  row: NetWorthComponentRow
  onSaved: () => void
  onClose: () => void
  onPeriodChange?: (period: string) => void
}) {
  const { token, setMessage } = useSession()
  const queryClient = useQueryClient()
  const id = useId()
  const [completed, setCompleted] = useState(row.completed ?? false)
  const [components, setComponents] = useState<DraftComponent[]>(() => buildDraft(row))
  // The stored state when editing began; refreshed row props must not reset it.
  const [initialSnapshot] = useState(() => componentFingerprint(buildDraft(row)))
  const [nextId, setNextId] = useState(components.length)
  const [validationError, setValidationError] = useState('')
  const [choosingMonth, setChoosingMonth] = useState(false)
  const mutation = useMutation({
    // The store rejects changing a completed month's components in one step:
    // it only accepts an identical payload or an explicit reopen. Re-completing
    // an edited month therefore reopens with the new values first, then marks
    // the month completed again — two documented transitions, one save action.
    mutationFn: ({ payload, reopenFirst }: { payload: NetWorthMonthPayload; reopenFirst: boolean }) =>
      (reopenFirst
        ? api.updateNetWorthMonth(token, row.period, { ...payload, completed: false })
        : Promise.resolve()
      ).then(() => api.updateNetWorthMonth(token, row.period, payload)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['overview'] })
      setMessage('Net worth month updated.')
      onSaved()
    },
  })
  const locked = completed || mutation.isPending
  const automatic = NET_WORTH_GROUPS.flatMap(({ key }) =>
    Object.entries(row[key].automatic_components ?? {}).filter(([, value]) => value !== 0)
      .map(([label, value]) => ({ group_key: key, label, value })),
  )
  const automaticTotal = automatic.reduce((sum, component) =>
    sum.add(component.group_key === 'debt' ? new Decimal(component.value).negated() : component.value), new Decimal(0))
  const total = components.reduce((sum, component) => {
    try {
      const value = new Decimal(component.value || 0)
      return value.isFinite() ? sum.add(component.group_key === 'debt' ? value.negated() : value) : sum
    } catch { return sum }
  }, automaticTotal)
  const change = (componentId: number, field: 'label' | 'value', value: string) => {
    setComponents((current) => current.map((component) => component.id === componentId ? { ...component, [field]: value } : component))
  }
  const close = () => { if (!mutation.isPending) onClose() }

  return (
    <FormSheet title="Edit net worth" className="net-worth-editor" onClose={close}
      eyebrow={<button type="button" className="net-worth-editor__month" aria-label={`Change month, ${row.period}`} aria-expanded={choosingMonth}
        disabled={mutation.isPending} onClick={() => setChoosingMonth((current) => !current)}>
        {row.period}<ChevronDown size={12} aria-hidden="true" />
      </button>}>
      {choosingMonth ? <OutlinedInput id={`${id}-month`} label="Net worth month" type="month" value={row.period} onChange={(event) => {
        if (/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) onPeriodChange?.(event.target.value)
      }} /> : null}
      <form className="quick-add-form" aria-label="Edit net worth month" onSubmit={(event) => {
        event.preventDefault()
        const seen = new Set<string>()
        const payload: NetWorthMonthPayload = { completed, components: [] }
        for (const component of components) {
          const label = component.label.trim()
          const value = Number(component.value)
          const key = `${component.group_key}:${label}`
          if (!label || !component.value.trim() || !Number.isFinite(value) || (component.group_key === 'debt' && value < 0)) {
            setValidationError('Each subgroup needs a name and a valid value. Debt cannot be negative.')
            return
          }
          if (seen.has(key)) {
            setValidationError('Subgroup names must be unique within each group.')
            return
          }
          seen.add(key)
          payload.components.push({ group_key: component.group_key, label, value })
        }
        setValidationError('')
        const changed = completed !== (row.completed ?? false) || componentFingerprint(payload.components) !== initialSnapshot
        mutation.mutate({
          payload,
          reopenFirst: (row.completed ?? false) && completed && changed,
        })
      }}>
        <div className="net-worth-editor__summary">
          <strong>Net worth <span>{fmtNumber(total.toNumber())}</span></strong>
          <label className="net-worth-editor__status">
            <Checkbox checked={completed} disabled={mutation.isPending} onChange={(event) => setCompleted(event.target.checked)} />
            Completed
          </label>
        </div>
        {completed ? <p className="muted">Manual values are locked. Untick Completed to edit them.</p> : null}
        <div className={completed ? 'net-worth-editor__groups is-completed' : 'net-worth-editor__groups'}>
          {NET_WORTH_GROUPS.map((group) => (
            <section className="net-worth-editor__group" key={group.key} aria-label={group.label}>
              <h3>{group.label}</h3>
              {automatic.filter((component) => component.group_key === group.key).map((component) => (
                <div className="net-worth-editor__automatic" key={component.label} aria-label={`Automatic ${component.label}`}>
                  <span><strong>{component.label}</strong></span>
                  <output aria-label={`${component.label} automatic value`}>{fmtNumber(component.value)}</output>
                </div>
              ))}
              {components.filter((component) => component.group_key === group.key).map((component) => (
                <div className="net-worth-editor__component" key={component.id}>
                  <OutlinedInput id={`${id}-${component.id}-label`} label={`${group.label} subgroup`} value={component.label} required disabled={locked}
                    onChange={(event) => change(component.id, 'label', event.target.value)} />
                  <OutlinedInput id={`${id}-${component.id}-value`} label={`${group.label} value`} value={component.value} type="number" step="any" inputMode="decimal"
                    min={group.key === 'debt' ? '0' : undefined} required disabled={locked} onChange={(event) => change(component.id, 'value', event.target.value)} />
                  <button type="button" className="net-worth-editor__remove" title="Remove subgroup" aria-label={`Remove ${component.label || group.label} subgroup`} disabled={locked}
                    onClick={() => setComponents((current) => current.filter((item) => item.id !== component.id))}>
                    <Trash2 aria-hidden="true" size={16} />
                  </button>
                </div>
              ))}
              <Button type="button" variant="secondary" disabled={locked} onClick={() => {
                setComponents((current) => [...current, { id: nextId, group_key: group.key, label: '', value: '' }])
                setNextId((current) => current + 1)
              }}><Plus aria-hidden="true" size={14} /> Add {group.label.toLowerCase()} subgroup</Button>
            </section>
          ))}
        </div>
        {validationError || mutation.isError ? <p role="alert">{validationError || (mutation.error instanceof Error ? mutation.error.message : 'Failed to save month.')}</p> : null}
        <div className="quick-add-actions">
          <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? 'Saving...' : 'Save month'}</Button>
        </div>
      </form>
    </FormSheet>
  )
}
