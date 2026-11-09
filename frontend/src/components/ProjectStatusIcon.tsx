import { Check } from 'lucide-react'
import { PROJECT_STATUS_LABELS } from '../lib/projects'
import type { ProjectStatus } from '../types'

/** Small circular state indicator: empty = not started, half = in progress, filled check = done. */
export function ProjectStatusIcon({ status }: { status: ProjectStatus }) {
  return (
    <span aria-label={PROJECT_STATUS_LABELS[status]} className={`project-status-icon is-${status}`} role="img" title={PROJECT_STATUS_LABELS[status]}>
      {status === 'completed' ? <Check className="h-3 w-3" /> : null}
    </span>
  )
}
