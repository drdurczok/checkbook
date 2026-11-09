export type FilterToggleProps = {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  compact?: boolean
  role?: 'switch' | 'menuitemcheckbox'
}

export function FilterToggle({ label, checked, onChange, compact = false, role = 'switch' }: FilterToggleProps) {
  return (
    <button
      aria-checked={checked}
      className={`app-filter-option app-filter-toggle${compact ? ' app-filter-toggle--compact' : ''}`}
      onClick={() => onChange(!checked)}
      role={role}
      type="button"
    >
      <span>{label}</span>
      <span aria-hidden="true" className="app-filter-switch"><i /></span>
    </button>
  )
}
