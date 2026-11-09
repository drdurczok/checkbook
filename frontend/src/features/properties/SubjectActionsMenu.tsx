import { DetailActionsMenu } from '../../components/DetailActionsMenu'

export function SubjectActionsMenu({ subjectName, onEdit, onNotes, onConfiguration }: {
  subjectName: string
  onEdit?: () => void
  onConfiguration?: () => void
  onNotes?: () => void
}) {
  return <DetailActionsMenu label={`${subjectName} options`} actions={[
    ...(onEdit ? [{ label: 'Edit', onClick: onEdit }] : []),
    ...(onConfiguration ? [{ label: 'Configuration', onClick: onConfiguration }] : []),
    ...(onNotes ? [{ label: 'Notes', onClick: onNotes }] : []),
  ]} />
}
