import { Checkbox } from './ui/NativeControls'
import { useEffect, useId, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import { OutlinedInput, OutlinedNativeSelect, OutlinedTextarea } from './ui/OutlinedField'
import { AlertTriangle, Check, FileText, Hammer, Layers, Link2, Minus, MoreVertical, Pencil, Plus, Tags, TrendingUp, X, Zap } from 'lucide-react'
import { Modal } from './Modal'
import { FilterToggle } from './FilterToggle'
import { SectionPanel } from './panel'
import { ProjectStatusIcon } from './ProjectStatusIcon'
import { RoomBreakdown } from './RoomBreakdown'
import { ValueTrendChart } from './charts'
import { colorForIndex, editFormFromProperty, emptyItem, emptyRoom, emptySection, hasNumericValue, recalculateRooms } from '../features/properties/propertyEditorModel'
import type { EditForm, FeatureKey, PropertyDetailModalProps } from '../features/properties/propertyEditorModel'
import { valueTrendSeries } from '../features/properties/valueTrend'
import { fmtCurrency, fmtDate, numericAmount, todayInputValue } from '../lib/format'
import { isProjectItemCompleted, projectItemTotal, projectPlanningTotal, projectRooms, sectionStatusWithProjects } from '../lib/projects'
import type { AssetDetailItem, AssetDetailRoom, AssetDetailSection, AssetSummary, ProjectStatus, PropertyValuation } from '../types'

function InlinePropertyInformation({ children }: ComponentProps<typeof Modal>) {
  return <SectionPanel title="Property information" className="property-detail-page property-information-panel">{children}</SectionPanel>
}

export function PropertyDetailModal({
  presentation = 'modal',
  initialMode = 'view',
  property,
  projects,
  categories,
  currency,
  saving,
  deleting,
  utilityCount,
  onClose,
  onSave,
  onDelete,
  onOpenProject,
  onCreateOwnCategory,
  onListValuations,
  onAddValuation,
  onDeleteValuation,
  onLinkProject,
  onUnlinkProject,
}: PropertyDetailModalProps) {
  const fieldId = useId()
  const [actionsOpen, setActionsOpen] = useState(false)
  const [includeForecast, setIncludeForecast] = useState(false)
  const actionsRef = useRef<HTMLDivElement>(null)
  const actionsTriggerRef = useRef<HTMLButtonElement>(null)
  const actionsMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!actionsOpen) return
    actionsMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !actionsRef.current?.contains(event.target)) setActionsOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [actionsOpen])
  const [isEditMode, setIsEditMode] = useState(presentation === 'modal' && initialMode === 'edit')
  const Surface = presentation === 'inline' ? InlinePropertyInformation : Modal
  const saveRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (isEditMode) saveRef.current?.focus()
  }, [isEditMode])
  const [editForm, setEditForm] = useState<EditForm>(() => editFormFromProperty(property))
  const [editingTarget, setEditingTarget] = useState<string | null>(null)
  const [expandedRoomKeys, setExpandedRoomKeys] = useState<Set<string>>(new Set())
  const [expandedSectionKeys, setExpandedSectionKeys] = useState<Set<string>>(new Set())
  const [expandedItemKeys, setExpandedItemKeys] = useState<Set<string>>(new Set())
  const [deletePrompt, setDeletePrompt] = useState<null | 'blocked' | 'confirm'>(null)
  const deleteCancelRef = useRef<HTMLButtonElement | null>(null)
  // The inline delete confirmation is an alert inside this dialog: focus the
  // safe action when it appears so keyboard users land on Cancel first.
  useEffect(() => {
    if (deletePrompt === 'confirm') {
      deleteCancelRef.current?.focus()
    }
  }, [deletePrompt])
  const [creatingOwnCategory, setCreatingOwnCategory] = useState(false)
  const [showCategoryPicker, setShowCategoryPicker] = useState(false)
  // key: 'new' (adding another value), 'primary' (editing the Value/As of
  // anchor), or a valuations[].id (editing that history point via replace).
  const [valuationDraft, setValuationDraft] = useState<{ key: string; value: string; date: string } | null>(null)
  const [valuations, setValuations] = useState<PropertyValuation[]>([])
  const [notesOpen, setNotesOpen] = useState(() => Boolean(property.notes))
  const [showProjectPicker, setShowProjectPicker] = useState(false)
  const activeEditorRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!editingTarget) {
      return
    }
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && activeEditorRef.current?.contains(target)) {
        return
      }
      setEditingTarget(null)
    }
    document.addEventListener('pointerdown', closeOnOutside)
    return () => document.removeEventListener('pointerdown', closeOnOutside)
  }, [editingTarget])

  useEffect(() => {
    let cancelled = false
    onListValuations?.().then((rows) => {
      if (!cancelled) {
        setValuations(rows)
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [property.id])

  const storedStatus = property.status
  const allLinkedProjects = projects.filter((project) => project.linked_asset_id === property.id)
  const linkedProjects = property.projects_enabled === false ? [] : allLinkedProjects
  const availableProjects = projects.filter((project) => !project.linked_asset_id)
  // The breakdown can live directly on the property, or on a linked project
  // (bulk-imported data attaches rooms to the renovation project instead of
  // the property itself), so count both.
  const categoryCount =
    projectRooms(property).length + linkedProjects.reduce((sum, project) => sum + projectRooms(project).length, 0)
  // Linked projects attach to a section (top-level grouping) and render there as
  // their own group alongside the regular groups.
  const linkedProjectsFor = (roomIndex: number) =>
    projects.filter(
      (project) =>
        project.linked_asset_id === property.id &&
        typeof project.details?.linked_section_path === 'string' &&
        project.details.linked_section_path === `${roomIndex}`,
    )

  const expenseCategories = (categories ?? []).filter((category) => category.kind === 'expense')
  const linkedCategoryNames = expenseCategories
    .filter((category) => (property.linked_category_ids ?? []).includes(category.id))
    .map((category) => category.name)
  // Stable per-category color keyed by position in the full list, so a
  // category's color doesn't shift around as others are linked/unlinked.
  const categoryColor = (categoryId: string) => colorForIndex(expenseCategories.findIndex((c) => c.id === categoryId))
  const editLinkedCategories = expenseCategories.filter((category) => editForm.linkedCategoryIds.includes(category.id))
  const hasOwnCategory = editLinkedCategories.some((category) => category.name.trim() === editForm.name.trim())
  const availableCategoriesForPicker = expenseCategories
    .filter((category) => !editForm.linkedCategoryIds.includes(category.id))
    .map((category) => {
      const parent = category.parent_id ? expenseCategories.find((candidate) => candidate.id === category.parent_id) : null
      return { id: category.id, label: parent ? `${parent.name} › ${category.name}` : category.name }
    })
    .toSorted((left, right) => left.label.localeCompare(right.label))
  const valueTrendPoints =
    !isEditMode && property.depreciation_rate
      ? valueTrendSeries(
          [
            { value: property.original_total_cost ?? property.total_cost, date: property.valuation_date },
            ...valuations.map((entry) => ({ value: entry.value, date: entry.effective_date })),
          ],
          property.depreciation_rate,
        )
      : []

  function toggleLinkedCategory(categoryId: string) {
    setEditForm((current) => ({
      ...current,
      linkedCategoryIds: current.linkedCategoryIds.includes(categoryId)
        ? current.linkedCategoryIds.filter((id) => id !== categoryId)
        : [...current.linkedCategoryIds, categoryId],
    }))
  }

  const sortedValuations = valuations.toSorted((left, right) => left.effective_date.localeCompare(right.effective_date))

  async function removeValuation(valuationId: string) {
    const removed = await onDeleteValuation?.(valuationId)
    if (removed) {
      setValuations((current) => current.filter((entry) => entry.id !== valuationId))
    }
  }

  async function confirmValuationDraft() {
    if (!valuationDraft || !hasNumericValue(valuationDraft.value) || !valuationDraft.date) {
      return
    }
    const { key, value, date } = valuationDraft
    if (key === 'primary') {
      setEditForm({ ...editForm, value, valuation_date: date })
      setValuationDraft(null)
      return
    }
    // History entries have no update endpoint — "editing" replaces the old
    // point with a new one (add then delete) rather than patching in place.
    // Adding first means a failed delete leaves a harmless duplicate instead
    // of a failed add permanently losing the original point.
    const created = await onAddValuation?.(numericAmount(value), date)
    if (!created) {
      return
    }
    if (key !== 'new') {
      const removed = await onDeleteValuation?.(key)
      setValuations((current) => [...current.filter((entry) => entry.id !== key), created])
      if (!removed) {
        return
      }
    } else {
      setValuations((current) => [...current, created])
    }
    setValuationDraft(null)
  }

  async function linkProject(project: AssetSummary) {
    const updated = await onLinkProject?.(project)
    if (updated) {
      setShowProjectPicker(false)
    }
  }

  async function unlinkProject(project: AssetSummary) {
    await onUnlinkProject?.(project)
  }

  const featureEnabledKey: Record<FeatureKey, 'depreciationEnabled' | 'projectsEnabled' | 'utilitiesEnabled' | 'expensesEnabled'> = {
    depreciation: 'depreciationEnabled',
    projects: 'projectsEnabled',
    utilities: 'utilitiesEnabled',
    expenses: 'expensesEnabled',
  }

  function enableFeature(key: FeatureKey) {
    setEditForm((current) => ({
      ...current,
      [featureEnabledKey[key]]: true,
      featureOrder: current.featureOrder.includes(key) ? current.featureOrder : [...current.featureOrder, key],
    }))
  }

  function disableFeature(key: FeatureKey) {
    setEditForm((current) => ({
      ...current,
      [featureEnabledKey[key]]: false,
      featureOrder: current.featureOrder.filter((existing) => existing !== key),
    }))
  }

  async function createOwnCategory() {
    setCreatingOwnCategory(true)
    try {
      const updated = await onCreateOwnCategory?.()
      if (updated) {
        // Union, not replace — the server only knows about already-saved
        // links, so overwriting here would silently drop any categories the
        // user picked from the dropdown earlier in this same edit session.
        setEditForm((current) => ({
          ...current,
          linkedCategoryIds: Array.from(new Set([...current.linkedCategoryIds, ...(updated.linked_category_ids ?? [])])),
        }))
      }
    } finally {
      setCreatingOwnCategory(false)
    }
  }

  function updateRoom(roomIndex: number, patch: Partial<AssetDetailRoom>) {
    setEditForm((current) => ({
      ...current,
      rooms: current.rooms.map((room, index) => (index === roomIndex ? { ...room, ...patch } : room)),
    }))
  }

  function updateSection(roomIndex: number, sectionIndex: number, patch: Partial<AssetDetailSection>) {
    setEditForm((current) => ({
      ...current,
      rooms: current.rooms.map((room, index) =>
        index === roomIndex
          ? { ...room, sections: room.sections.map((section, sIndex) => (sIndex === sectionIndex ? { ...section, ...patch } : section)) }
          : room,
      ),
    }))
  }

  function updateItem(roomIndex: number, sectionIndex: number, itemIndex: number, patch: Partial<AssetDetailItem>) {
    setEditForm((current) => ({
      ...current,
      rooms: current.rooms.map((room, index) =>
        index === roomIndex
          ? {
              ...room,
              sections: room.sections.map((section, sIndex) =>
                sIndex === sectionIndex
                  ? { ...section, items: section.items.map((item, iIndex) => (iIndex === itemIndex ? { ...item, ...patch } : item)) }
                  : section,
              ),
            }
          : room,
      ),
    }))
  }

  function addRoom(afterIndex = -1) {
    setEditForm((current) => {
      const rooms = [...current.rooms]
      const insertAt = Math.min(Math.max(afterIndex + 1, 0), rooms.length)
      rooms.splice(insertAt, 0, emptyRoom())
      setEditingTarget(`room:${insertAt}`)
      expandRoom(`room-${insertAt}`)
      return { ...current, rooms }
    })
  }

  function addSection(roomIndex: number, afterIndex = -1) {
    setEditForm((current) => ({
      ...current,
      rooms: current.rooms.map((room, index) => {
        if (index !== roomIndex) {
          return room
        }
        const sections = [...room.sections]
        const insertAt = Math.min(Math.max(afterIndex + 1, 0), sections.length)
        sections.splice(insertAt, 0, emptySection())
        setEditingTarget(`section:${roomIndex}:${insertAt}`)
        expandSection(`${roomIndex}-${insertAt}`)
        return { ...room, sections }
      }),
    }))
  }

  function addItem(roomIndex: number, sectionIndex: number, afterIndex = -1) {
    setEditForm((current) => ({
      ...current,
      rooms: current.rooms.map((room, index) =>
        index === roomIndex
          ? {
              ...room,
              sections: room.sections.map((section, sIndex) => {
                if (sIndex !== sectionIndex) {
                  return section
                }
                const items = [...section.items]
                const insertAt = Math.min(Math.max(afterIndex + 1, 0), items.length)
                items.splice(insertAt, 0, emptyItem())
                setEditingTarget(`item:${roomIndex}:${sectionIndex}:${insertAt}`)
                expandSection(`${roomIndex}-${sectionIndex}`)
                return { ...section, items }
              }),
            }
          : room,
      ),
    }))
  }

  function toggleKey(setter: typeof setExpandedItemKeys, key: string) {
    setter((current) => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  function toggleItemNotes(key: string) {
    toggleKey(setExpandedItemKeys, key)
  }

  function toggleRoom(key: string) {
    toggleKey(setExpandedRoomKeys, key)
  }

  function expandRoom(key: string) {
    setExpandedRoomKeys((current) => (current.has(key) ? current : new Set(current).add(key)))
  }

  function toggleSection(key: string) {
    toggleKey(setExpandedSectionKeys, key)
  }

  function expandSection(key: string) {
    setExpandedSectionKeys((current) => (current.has(key) ? current : new Set(current).add(key)))
  }

  async function save() {
    const rooms = recalculateRooms(editForm.rooms)
    const calculatedTotal = rooms.reduce((sum, room) => sum + numericAmount(room.total), 0)
    // A breakdown drives the value when it has line items; otherwise the manual value stands.
    const total = calculatedTotal > 0 ? calculatedTotal : numericAmount(editForm.value)
    const saved = await onSave({
      name: editForm.name,
      total_cost: total,
      valuation_date: editForm.valuation_date || todayInputValue(),
      started_on: editForm.started_on || null,
      ended_on: editForm.ended_on || null,
      notes: editForm.notes,
      category: editForm.category,
      // Always persisted, regardless of the toggle — like the other three
      // feature toggles, disabling this card only hides it, it doesn't
      // discard the configured rate.
      depreciation_rate: numericAmount(editForm.depreciationRatePercent) / 100,
      depreciation_enabled: editForm.depreciationEnabled,
      utilities_enabled: editForm.utilitiesEnabled,
      projects_enabled: editForm.projectsEnabled,
      expenses_enabled: editForm.expensesEnabled,
      linked_category_ids: editForm.linkedCategoryIds,
      details: { ...(property.details ?? {}), rooms },
    })
    if (saved) {
      setEditForm(editFormFromProperty(property))
      setIsEditMode(false)
      setEditingTarget(null)
      if (initialMode === 'edit') onClose()
    }
  }

  const rooms = isEditMode ? editForm.rooms : projectRooms(property)
  // Bulk-imported properties usually carry no rooms of their own — the real
  // breakdown lives on a linked renovation project instead. Fall back to
  // showing those projects' rooms (read-only; edit them via onOpenProject)
  // so the popup isn't empty despite the stat count saying otherwise.
  const fallbackProjectRoomGroups =
    presentation !== 'inline' && !isEditMode && rooms.length === 0 && property.projects_enabled !== false
      ? linkedProjects
          .map((linkedProject) => ({ project: linkedProject, rooms: projectRooms(linkedProject) }))
          .filter((group) => group.rooms.length > 0)
      : []
  const editRoomsTotal = isEditMode
    ? recalculateRooms(editForm.rooms).reduce((sum, room) => sum + numericAmount(room.total), 0)
    : 0
  const hasBreakdownTotal = editRoomsTotal > 0
  const computedTotal = isEditMode
    ? (hasBreakdownTotal ? editRoomsTotal : numericAmount(editForm.value))
    : property.total_cost
  // Live preview: recomputed on every keystroke against the anchor value/date
  // the user is currently editing, not the last-saved property, so the chart
  // reacts immediately to changes in Value/As of/Monthly change.
  const editAnchorValue = hasBreakdownTotal ? editRoomsTotal : numericAmount(editForm.value)
  const editValueTrendPoints =
    isEditMode && editForm.depreciationEnabled && editAnchorValue > 0
      ? valueTrendSeries(
          [
            { value: editAnchorValue, date: editForm.valuation_date || todayInputValue() },
            ...valuations.map((entry) => ({ value: entry.value, date: entry.effective_date })),
          ],
          numericAmount(editForm.depreciationRatePercent) / 100,
        )
      : []

  return (
    <Surface
      className={`drive-picker asset-detail-modal property-detail-page${deletePrompt ? ' has-delete-prompt' : ''}`}
      eyebrow="Property details"
      title={isEditMode ? 'Edit property' : property.name}
      titleId="property-detail-title"
      onClose={onClose}
      actions={
        <div className="asset-detail-actions">
          {isEditMode ? (
            <button ref={saveRef} aria-label={saving ? 'Saving property' : 'Save property'} className="net-worth-modal__close" disabled={saving} onClick={() => void save()} title="Save" type="button">
              <Check className="h-4 w-4" />
            </button>
          ) : null}
          {!isEditMode || onDelete ? (
            <div className="nw-options nw-options--end" ref={actionsRef}
              onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setActionsOpen(false) }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && actionsOpen) {
                  event.preventDefault()
                  event.stopPropagation()
                  setActionsOpen(false)
                  actionsTriggerRef.current?.focus()
                }
              }}
            >
              <button ref={actionsTriggerRef} aria-label="Property actions" aria-haspopup="menu" aria-expanded={actionsOpen}
                className="net-worth-modal__close" title="Property actions" type="button"
                onClick={() => setActionsOpen((open) => !open)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActionsOpen(true) }
                }}
              ><MoreVertical className="h-4 w-4" /></button>
              {actionsOpen ? (
                <div className="nw-options__menu" role="menu" aria-label="Property actions" ref={actionsMenuRef}
                  onKeyDown={(event) => {
                    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'))
                    const index = items.indexOf(document.activeElement as HTMLButtonElement)
                    const next = event.key === 'ArrowDown' ? (index + 1) % items.length
                      : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length
                        : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1
                    if (next >= 0) { event.preventDefault(); items[next]?.focus() }
                  }}
                >
                  {!isEditMode ? <button role="menuitem" className="nw-options__item" onClick={() => { setActionsOpen(false); setIsEditMode(true) }} type="button">Edit</button> : null}
                  {onDelete ? (
                    <button role="menuitem" className="nw-options__item" disabled={saving || deleting} onClick={() => { setActionsOpen(false); actionsTriggerRef.current?.focus(); setDeletePrompt(allLinkedProjects.length ? 'blocked' : 'confirm') }} type="button">Delete</button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          {!isEditMode ? (
            <button aria-label="Close property details" className="net-worth-modal__close" onClick={onClose} title="Close" type="button">
              x
            </button>
          ) : null}
        </div>
      }
    >
      {deletePrompt === 'blocked' ? (
        <div className="property-delete-panel" role="alert">
          <span className="property-delete-panel__icon"><AlertTriangle className="h-5 w-5" /></span>
          <div className="property-delete-panel__text">
            <strong>Can't delete this property yet</strong>
            <p>
              {allLinkedProjects.length === 1 ? 'A project is' : `${allLinkedProjects.length} projects are`} linked to it.
              Please unlink or delete {allLinkedProjects.length === 1 ? 'it' : 'them'} first.
            </p>
            {onOpenProject ? (
              <div className="property-delete-panel__projects">
                {allLinkedProjects.map((project) => (
                  <button className="property-delete-panel__project" key={project.id} onClick={() => onOpenProject(project)} type="button">
                    <Link2 className="h-3.5 w-3.5" />{project.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button className="button button--compact button--ghost" onClick={() => setDeletePrompt(null)} type="button">Got it</button>
        </div>
      ) : deletePrompt === 'confirm' ? (
        <div className="property-delete-panel" role="alert" aria-label="Confirm delete">
          <span className="property-delete-panel__icon"><AlertTriangle className="h-5 w-5" /></span>
          <div className="property-delete-panel__text">
            <strong>Delete this property?</strong>
            <p>{property.name} and its breakdown will be permanently removed. This can't be undone.</p>
          </div>
          <div className="property-delete-panel__actions">
            <button ref={deleteCancelRef} className="button button--compact button--ghost" disabled={deleting} onClick={() => setDeletePrompt(null)} type="button">Cancel</button>
            <button className="button button--compact button--danger" disabled={deleting} onClick={() => void onDelete?.()} type="button">
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      ) : null}
      <div className="detail-table">
        {isEditMode || presentation === 'inline' ? null : (
          <div className="property-detail-summary">
            {property.projects_enabled !== false ? (
              <span className="property-stat">
                <Hammer className="h-3.5 w-3.5" aria-hidden="true" />
                <strong>{linkedProjects.length}</strong>
                <small>{linkedProjects.length === 1 ? 'project' : 'projects'}</small>
              </span>
            ) : null}
            <span className="property-stat">
              <Layers className="h-3.5 w-3.5" aria-hidden="true" />
              <strong>{categoryCount}</strong>
              <small>{categoryCount === 1 ? 'category' : 'categories'}</small>
            </span>
            {utilityCount && property.utilities_enabled !== false ? (
              <span className="property-stat">
                <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                <strong>{utilityCount}</strong>
                <small>utilities</small>
              </span>
            ) : null}
            {linkedCategoryNames.length && property.expenses_enabled !== false ? (
              <span className="property-stat">
                <Tags className="h-3.5 w-3.5" aria-hidden="true" />
                <strong>{linkedCategoryNames.length}</strong>
                <small>{linkedCategoryNames.length === 1 ? 'linked category' : 'linked categories'}</small>
              </span>
            ) : null}
          </div>
        )}
        {!isEditMode && presentation === 'inline' ? (
          <>
            <div className="detail-row">
              <span>Kind</span>
              <strong>{property.category === 'vehicle' ? 'Vehicle' : property.category === 'account' ? 'Account' : property.category === 'other' ? 'Other' : 'Property'}</strong>
            </div>
            {property.started_on ? <div className="detail-row"><span>From</span><strong>{fmtDate(property.started_on)}</strong></div> : null}
            {property.ended_on ? <div className="detail-row"><span>To</span><strong>{fmtDate(property.ended_on)}</strong></div> : null}
            {property.notes ? <div className="detail-row"><span>Notes</span><p>{property.notes}</p></div> : null}
            <section className="valuation-history" aria-label="Value history">
              <h3 className="property-edit-section__title">Value history</h3>
              <div className="detail-row">
                <span>{fmtDate(property.valuation_date)}</span>
                <strong>{fmtCurrency(property.original_total_cost ?? property.total_cost, currency)}</strong>
                <small>Original value</small>
              </div>
              {sortedValuations.map((entry) => (
                <div className="detail-row" key={entry.id}>
                  <span>{fmtDate(entry.effective_date)}</span>
                  <strong>{fmtCurrency(entry.value, currency)}</strong>
                </div>
              ))}
            </section>
          </>
        ) : null}
        {valueTrendPoints.length ? (
          <div className="property-value-trend">
            <div className="property-edit-section__head">
              <h3 className="property-edit-section__title">
                <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
                {(property.depreciation_rate ?? 0) > 0 ? 'Appreciation' : 'Depreciation'} outlook
              </h3>
              <FilterToggle label="Forecast" checked={includeForecast} onChange={setIncludeForecast} compact />
            </div>
            <ValueTrendChart points={valueTrendPoints.filter((point) => includeForecast || !point.projected)} currency={currency} />
          </div>
        ) : null}
        {isEditMode ? (
          <div className="property-details-edit">
            <section className="property-edit-section">
              <h3 className="property-edit-section__title">
                <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                Details
              </h3>
              <OutlinedInput id={`${fieldId}-name`} label="Name" className="property-details-edit__name" value={editForm.name} onChange={(event) => setEditForm({ ...editForm, name: event.target.value })} />
              <OutlinedNativeSelect
                  id={`${fieldId}-kind`}
                  label="Kind"
                  value={editForm.category}
                  onChange={(event) => setEditForm({ ...editForm, category: event.target.value as EditForm['category'] })}
                >
                  <option value="property">Property</option>
                  <option value="vehicle">Vehicle</option>
                  <option value="account">Account</option>
                  <option value="other">Other</option>
              </OutlinedNativeSelect>
              <div className="field-pair">
                <OutlinedInput id={`${fieldId}-from`} label="From" type="date" value={editForm.started_on} onChange={(event) => setEditForm({ ...editForm, started_on: event.target.value })} />
                <OutlinedInput id={`${fieldId}-to`} label="To" type="date" value={editForm.ended_on} onChange={(event) => setEditForm({ ...editForm, ended_on: event.target.value })} />
              </div>
              {hasBreakdownTotal ? (
                <div className="form-grid form-grid--3col">
                  <OutlinedInput id={`${fieldId}-value`} label="Value" type="number" step="0.01" inputMode="decimal" disabled value={String(editRoomsTotal)} hint="From breakdown" />
                  <OutlinedInput id={`${fieldId}-as-of`} label="As of" type="date" value={editForm.valuation_date} onChange={(event) => setEditForm({ ...editForm, valuation_date: event.target.value })} />
                </div>
              ) : (
                <div className="valuation-history">
                  <div className="chip-row">
                    <div className="value-pill" style={{ '--chip-color': '#2563eb' } as React.CSSProperties}>
                      <span>{fmtCurrency(numericAmount(editForm.value) || 0, currency)} · {fmtDate(editForm.valuation_date)}</span>
                      <button
                        className="value-pill__icon"
                        onClick={() => setValuationDraft({ key: 'primary', value: editForm.value, date: editForm.valuation_date })}
                        type="button"
                        aria-label="Edit value"
                        title="Edit"
                      >
                        <Pencil className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </div>
                    {onListValuations ? sortedValuations.map((entry) => (
                      <div className="value-pill" key={entry.id} style={{ '--chip-color': '#2563eb' } as React.CSSProperties}>
                        <span>{fmtCurrency(entry.value, currency)} · {fmtDate(entry.effective_date)}</span>
                        <button
                          className="value-pill__icon"
                          onClick={() => setValuationDraft({ key: entry.id, value: String(entry.value), date: entry.effective_date })}
                          type="button"
                          aria-label="Edit value"
                          title="Edit"
                        >
                          <Pencil className="h-3 w-3" aria-hidden="true" />
                        </button>
                        <button
                          className="value-pill__icon"
                          onClick={() => void removeValuation(entry.id)}
                          type="button"
                          aria-label="Remove value"
                          title="Remove"
                        >
                          <X className="h-3 w-3" aria-hidden="true" />
                        </button>
                      </div>
                    )) : null}
                  </div>
                  {onListValuations ? (
                    valuationDraft ? (
                      <div className="form-grid form-grid--3col">
                        <OutlinedInput
                          id={`${fieldId}-valuation-value`}
                          label="Value"
                          type="number"
                          step="0.01"
                          inputMode="decimal"
                          value={valuationDraft.value}
                          onChange={(event) => setValuationDraft({ ...valuationDraft, value: event.target.value })}
                        />
                        <OutlinedInput
                          id={`${fieldId}-valuation-date`}
                          label="Date"
                          type="date"
                          value={valuationDraft.date}
                          onChange={(event) => setValuationDraft({ ...valuationDraft, date: event.target.value })}
                        />
                        <div className="inline-field">
                          <span aria-hidden="true">&nbsp;</span>
                          <div className="chip-row">
                            <button className="button button--compact" onClick={() => void confirmValuationDraft()} type="button">Save</button>
                            <button className="button button--compact button--ghost" onClick={() => setValuationDraft(null)} type="button">Cancel</button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <button
                        className="feature-add-card feature-add-card--valuation"
                        onClick={() => setValuationDraft({ key: 'new', value: '', date: todayInputValue() })}
                        type="button"
                      >
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Add another value</span>
                      </button>
                    )
                  ) : null}
                </div>
              )}
              {editForm.notes || notesOpen ? (
                <OutlinedTextarea id={`${fieldId}-notes`} label="Notes" className="quick-add-notes property-details-edit__notes" autoFocus={notesOpen} value={editForm.notes} onChange={(event) => setEditForm({ ...editForm, notes: event.target.value })} />
              ) : (
                <button
                  className="feature-add-card feature-add-card--notes property-details-edit__notes"
                  onClick={() => setNotesOpen(true)}
                  type="button"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Add note</span>
                </button>
              )}
            </section>

            {editForm.featureOrder.map((key) => {
              if (key === 'depreciation') {
                return (
                  <section className="property-edit-section property-edit-section--valuation" key={key}>
                    <div className="property-edit-section__head">
                      <h3 className="property-edit-section__title">
                        <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
                        Depreciation &amp; appreciation
                      </h3>
                      <button
                        className="feature-card-remove"
                        onClick={() => disableFeature('depreciation')}
                        type="button"
                        aria-label="Remove depreciation & appreciation"
                        title="Remove"
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <OutlinedInput
                      id={`${fieldId}-monthly-change`}
                      label="Monthly change %"
                      type="number"
                      step="0.01"
                      min="-100"
                      max="100"
                      inputMode="decimal"
                      placeholder="0"
                      value={editForm.depreciationRatePercent}
                      onChange={(event) => setEditForm({ ...editForm, depreciationRatePercent: event.target.value })}
                      hint={'Negative depreciates, positive appreciates, compounding monthly from "As of".'}
                    />
                    {editValueTrendPoints.length ? (
                      <div className="property-edit-live-chart">
                        <div className="property-edit-section__head">
                          <FilterToggle label="Forecast" checked={includeForecast} onChange={setIncludeForecast} compact />
                        </div>
                        <ValueTrendChart points={editValueTrendPoints.filter((point) => includeForecast || !point.projected)} currency={currency} />
                      </div>
                    ) : (
                      <p className="property-edit-live-chart__empty">Enter a value above to preview the curve live.</p>
                    )}
                  </section>
                )
              }
              if (key === 'projects') {
                return (
                  <section className="property-edit-section property-edit-section--projects" key={key}>
                    <div className="property-edit-section__head">
                      <h3 className="property-edit-section__title">
                        <Hammer className="h-3.5 w-3.5" aria-hidden="true" />
                        Projects
                      </h3>
                      <button
                        className="feature-card-remove"
                        onClick={() => disableFeature('projects')}
                        type="button"
                        aria-label="Remove projects"
                        title="Remove"
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <small className="property-edit-section__hint">
                      Projects linked to this {editForm.category === 'vehicle' ? 'vehicle' : 'property'} appear in its Projects section.
                    </small>
                    {linkedProjects.length ? (
                      <div className="chip-row">
                        {linkedProjects.map((linkedProject) => (
                          <div className="value-pill" key={linkedProject.id} style={{ '--chip-color': '#d97706' } as React.CSSProperties}>
                            <button className="value-pill__label" onClick={() => onOpenProject?.(linkedProject)} type="button">
                              <Link2 className="h-3 w-3" aria-hidden="true" />
                              <span>{linkedProject.name}</span>
                            </button>
                            {onUnlinkProject ? (
                              <button
                                className="value-pill__icon"
                                onClick={() => void unlinkProject(linkedProject)}
                                type="button"
                                aria-label={`Unlink ${linkedProject.name}`}
                                title="Unlink"
                              >
                                <X className="h-3 w-3" aria-hidden="true" />
                              </button>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="property-item-note">No linked projects yet.</p>
                    )}
                    {onLinkProject ? (
                      showProjectPicker ? (
                        availableProjects.length ? (
                          <OutlinedNativeSelect
                            id={`${fieldId}-link-project`}
                            label="Link project"
                            autoFocus
                            onChange={(event) => {
                              const target = availableProjects.find((project) => project.id === event.target.value)
                              if (target) {
                                void linkProject(target)
                              }
                            }}
                            onBlur={() => setShowProjectPicker(false)}
                            value=""
                          >
                            <option value="">Select a project…</option>
                            {availableProjects.map((project) => (
                              <option key={project.id} value={project.id}>{project.name}</option>
                            ))}
                          </OutlinedNativeSelect>
                        ) : (
                          <p className="property-item-note">No unlinked projects available.</p>
                        )
                      ) : (
                        <button
                          className="feature-add-card feature-add-card--projects"
                          onClick={() => setShowProjectPicker(true)}
                          type="button"
                        >
                          <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Link project</span>
                        </button>
                      )
                    ) : null}
                  </section>
                )
              }
              if (key === 'utilities') {
                return (
                  <section className="property-edit-section property-edit-section--utilities" key={key}>
                    <div className="property-edit-section__head">
                      <h3 className="property-edit-section__title">
                        <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                        Utilities
                      </h3>
                      <button
                        className="feature-card-remove"
                        onClick={() => disableFeature('utilities')}
                        type="button"
                        aria-label="Remove utilities"
                        title="Remove"
                      >
                        <Minus className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <small className="property-edit-section__hint">
                      This {editForm.category === 'vehicle' ? 'vehicle' : 'property'} appears in the Utilities board
                      {utilityCount ? ` — currently tracking ${utilityCount} ${utilityCount === 1 ? 'service' : 'services'}.` : '.'}
                    </small>
                    <p className="property-item-note">Manage linked utilities in the asset options Configuration menu.</p>
                  </section>
                )
              }
              return (
                <section className="property-edit-section property-edit-section--expenses" key={key}>
                  <div className="property-edit-section__head">
                    <h3 className="property-edit-section__title">
                      <Tags className="h-3.5 w-3.5" aria-hidden="true" />
                      Linked expense categories
                    </h3>
                    <button
                      className="feature-card-remove"
                      onClick={() => { disableFeature('expenses'); setShowCategoryPicker(false) }}
                      type="button"
                      aria-label="Remove linked expense categories"
                      title="Remove"
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {editLinkedCategories.length ? (
                    <div className="chip-row">
                      {editLinkedCategories.map((category) => (
                        <button
                          className="category-chip category-chip--removable"
                          key={category.id}
                          onClick={() => toggleLinkedCategory(category.id)}
                          style={{ '--chip-color': categoryColor(category.id) } as React.CSSProperties}
                          type="button"
                          title={`Remove ${category.name}`}
                        >
                          <span>{category.name}</span>
                          <X className="h-3 w-3" aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="property-item-note">No linked categories yet.</p>
                  )}
                  {showCategoryPicker ? (
                    availableCategoriesForPicker.length ? (
                      <OutlinedNativeSelect
                        id={`${fieldId}-add-category`}
                        label="Add category"
                        autoFocus
                        onChange={(event) => {
                          if (event.target.value) {
                            toggleLinkedCategory(event.target.value)
                          }
                          setShowCategoryPicker(false)
                        }}
                        onBlur={() => setShowCategoryPicker(false)}
                        value=""
                      >
                        <option value="">Select a category…</option>
                        {availableCategoriesForPicker.map((option) => (
                          <option key={option.id} value={option.id}>{option.label}</option>
                        ))}
                      </OutlinedNativeSelect>
                    ) : (
                      <p className="property-item-note">All available categories are already linked.</p>
                    )
                  ) : (
                    <div className="chip-row">
                      <button className="feature-add-card feature-add-card--expenses" onClick={() => setShowCategoryPicker(true)} type="button">
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Add expense category</span>
                      </button>
                      {onCreateOwnCategory && !hasOwnCategory ? (
                        <button
                          className="button button--compact button--ghost"
                          disabled={creatingOwnCategory}
                          onClick={() => void createOwnCategory()}
                          type="button"
                        >
                          <Tags className="h-3.5 w-3.5" />
                          {creatingOwnCategory ? 'Creating...' : 'Own expense category'}
                        </button>
                      ) : null}
                    </div>
                  )}
                  <small className="property-edit-section__hint">Expenses tagged with a linked category count toward this {editForm.category === 'vehicle' ? 'vehicle' : 'property'}'s spend.</small>
                </section>
              )
            })}

            {!editForm.depreciationEnabled || !editForm.projectsEnabled || !editForm.utilitiesEnabled || !editForm.expensesEnabled ? (
              <div className="property-edit-span feature-add-row">
                {!editForm.depreciationEnabled ? (
                  <button
                    className="feature-add-card feature-add-card--valuation"
                    onClick={() => enableFeature('depreciation')}
                    type="button"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Depreciation &amp; appreciation</span>
                  </button>
                ) : null}
                {!editForm.projectsEnabled ? (
                  <button
                    className="feature-add-card feature-add-card--projects"
                    onClick={() => enableFeature('projects')}
                    type="button"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Projects</span>
                  </button>
                ) : null}
                {!editForm.utilitiesEnabled ? (
                  <button
                    className="feature-add-card feature-add-card--utilities"
                    onClick={() => enableFeature('utilities')}
                    type="button"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Utilities</span>
                  </button>
                ) : null}
                {!editForm.expensesEnabled ? (
                  <button
                    className="feature-add-card feature-add-card--expenses"
                    onClick={() => enableFeature('expenses')}
                    type="button"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Expenses</span>
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {rooms.length ? (
          <div className="property-room-breakdown">
            {isEditMode ? (
              <>
                <button className="asset-insert-button asset-insert-button--top" onClick={() => addRoom(-1)} type="button" aria-label="Add category">
                  +
                </button>
                {rooms.map((room, roomIndex) => {
              const roomTarget = `room:${roomIndex}`
              const isRoomEditing = isEditMode && editingTarget === roomTarget
              const roomKey = `room-${roomIndex}`
              const isRoomExpanded = isEditMode || expandedRoomKeys.has(roomKey)
              const roomLinkedProjects = isEditMode ? [] : linkedProjectsFor(roomIndex)
              const roomTotal =
                room.sections.reduce(
                  (sum, section) => sum + section.items.reduce((nested, item) => nested + projectItemTotal(item), 0),
                  0,
                ) + roomLinkedProjects.reduce((sum, project) => sum + projectPlanningTotal(project), 0)
              return (
                <article className={`property-room-card ${isRoomExpanded ? 'is-expanded' : ''}`} key={`room-${roomIndex}`}>
                  {isRoomEditing ? (
                    <div className="property-room-card__header asset-click-row asset-active-edit" ref={activeEditorRef}>
                      <OutlinedInput id={`${fieldId}-room-${roomIndex}-name`} label="Category name" value={room.name} onChange={(event) => updateRoom(roomIndex, { name: event.target.value })} />
                      <span>{fmtCurrency(roomTotal, currency)}</span>
                    </div>
                  ) : (
                    <button
                      className="property-room-card__header asset-click-row"
                      onClick={() => {
                        if (isEditMode) {
                          expandRoom(roomKey)
                          setEditingTarget(roomTarget)
                          return
                        }
                        toggleRoom(roomKey)
                      }}
                      type="button"
                      aria-expanded={isRoomExpanded}
                    >
                      <strong>{isEditMode ? '' : `${isRoomExpanded ? '-' : '+'} `}{room.name}</strong>
                      <span>{fmtCurrency(roomTotal, currency)}</span>
                    </button>
                  )}
                  {isRoomExpanded ? (
                    <>
                      {isEditMode ? (
                        <button className="asset-insert-button asset-insert-button--top" onClick={() => addSection(roomIndex, -1)} type="button" aria-label="Add section">
                          +
                        </button>
                      ) : null}
                      <div className="property-room-sections">
                        {room.sections.map((section, sectionIndex) => {
                          const sectionKey = `${roomIndex}-${sectionIndex}`
                          const sectionTarget = `section:${roomIndex}:${sectionIndex}`
                          const isSectionEditing = isEditMode && editingTarget === sectionTarget
                          const isSectionExpanded = expandedSectionKeys.has(sectionKey)
                          const sectionTotal = section.items.reduce((sum, item) => sum + projectItemTotal(item), 0)
                          const sectionStatus = sectionStatusWithProjects(section, storedStatus, [])
                          return (
                            <section className={`property-room-section ${isSectionExpanded ? 'is-expanded' : ''}`} key={`section-${roomIndex}-${sectionIndex}`}>
                              {isSectionEditing ? (
                                <div className="property-room-section__header asset-click-row asset-active-edit" ref={activeEditorRef}>
                                  <OutlinedInput id={`${fieldId}-section-${roomIndex}-${sectionIndex}-name`} label="Section name" value={section.name} onChange={(event) => updateSection(roomIndex, sectionIndex, { name: event.target.value })} />
                                  <span className="property-section-meta">
                                    {fmtCurrency(sectionTotal, currency)}
                                    <ProjectStatusIcon status={sectionStatus} />
                                  </span>
                                </div>
                              ) : (
                                <button
                                  className="property-room-section__header asset-click-row"
                                  onClick={() => {
                                    if (isEditMode) {
                                      expandSection(sectionKey)
                                      setEditingTarget(sectionTarget)
                                      return
                                    }
                                    toggleSection(sectionKey)
                                  }}
                                  type="button"
                                  aria-expanded={isSectionExpanded}
                                >
                                  <strong>{isSectionExpanded ? '-' : '+'} {section.name}</strong>
                                  <span className="property-section-meta">
                                    {fmtCurrency(sectionTotal, currency)}
                                    <ProjectStatusIcon status={sectionStatus} />
                                  </span>
                                </button>
                              )}
                              {isEditMode ? (
                                <button className="asset-insert-button asset-insert-button--top" onClick={() => addItem(roomIndex, sectionIndex, -1)} type="button" aria-label="Add row">
                                  +
                                </button>
                              ) : null}
                              {isSectionExpanded ? (
                                <div className="property-room-items">
                                  {section.items.map((item, itemIndex) => {
                                    const itemKey = `${roomIndex}-${sectionIndex}-${itemIndex}`
                                    const itemTarget = `item:${itemKey}`
                                    const isExpanded = expandedItemKeys.has(itemKey)
                                    const isItemEditing = isEditMode && editingTarget === itemTarget
                                    const canEditTotal = !hasNumericValue(item.unit_price) || !hasNumericValue(item.quantity)
                                    const totalValue = projectItemTotal(item)
                                    const isItemCompleted = isProjectItemCompleted(item, storedStatus)
                                    return (
                                      <div className="property-room-item-shell" key={`item-${roomIndex}-${sectionIndex}-${itemIndex}`}>
                                        {isItemEditing ? (
                                          <div className="property-room-item property-room-item--button is-expanded asset-active-edit" ref={activeEditorRef}>
                                            <div className="property-inline-edit">
                                              <div className="property-inline-edit__title-row">
                                                <label className="project-item__check property-inline-edit__check" title={isItemCompleted ? 'Mark as not done' : 'Mark as done'}>
                                                  <Checkbox
                                                    aria-label={isItemCompleted ? 'Mark as not done' : 'Mark as done'}
                                                    checked={isItemCompleted}
                                                    onChange={(event) => updateItem(roomIndex, sectionIndex, itemIndex, { completed: event.target.checked })}

                                                  />
                                                  <span aria-hidden="true"><Check className="h-3.5 w-3.5" /></span>
                                                </label>
                                                <OutlinedInput id={`${fieldId}-item-${itemKey}-name`} label="Item" className="property-inline-edit__name" value={item.name} onChange={(event) => updateItem(roomIndex, sectionIndex, itemIndex, { name: event.target.value })} />
                                              </div>
                                              <OutlinedInput id={`${fieldId}-item-${itemKey}-unit-price`} label="Unit price" value={String(item.unit_price ?? '')} onChange={(event) => updateItem(roomIndex, sectionIndex, itemIndex, { unit_price: event.target.value })} />
                                              <OutlinedInput id={`${fieldId}-item-${itemKey}-quantity`} label="Quantity" value={String(item.quantity ?? '')} onChange={(event) => updateItem(roomIndex, sectionIndex, itemIndex, { quantity: event.target.value })} />
                                              {canEditTotal ? (
                                                <OutlinedInput id={`${fieldId}-item-${itemKey}-total`} label="Total" min="0" step="0.01" type="number" value={String(item.total_cost ?? 0)} onChange={(event) => updateItem(roomIndex, sectionIndex, itemIndex, { total_cost: Number(event.target.value) })} />
                                              ) : (
                                                <div className="property-computed-total">
                                                  <span>Total</span>
                                                  <strong>{fmtCurrency(totalValue, currency)}</strong>
                                                </div>
                                              )}
                                              <OutlinedTextarea id={`${fieldId}-item-${itemKey}-notes`} label="Notes" className="quick-add-notes" value={item.notes ?? ''} onChange={(event) => updateItem(roomIndex, sectionIndex, itemIndex, { notes: event.target.value })} />
                                            </div>
                                          </div>
                                        ) : (
                                          <button
                                            className={`property-room-item property-room-item--button property-room-item--status ${isExpanded ? 'is-expanded' : ''} ${isItemCompleted ? 'is-complete' : ''}`}
                                            onClick={() => isEditMode ? setEditingTarget(itemTarget) : toggleItemNotes(itemKey)}
                                            type="button"
                                          >
                                            <span aria-hidden="true" className={`property-item-status${isItemCompleted ? ' is-complete' : ''}`}>
                                              {isItemCompleted ? <Check className="h-3 w-3" /> : null}
                                            </span>
                                            <span>{item.name}</span>
                                            <small>
                                              {item.unit_price ? String(item.unit_price) : '-'}
                                              {' x '}
                                              {item.quantity ? String(item.quantity) : '-'}
                                            </small>
                                            <strong>{fmtCurrency(totalValue, currency)}</strong>
                                            {isExpanded ? <p className="property-item-note">{item.notes || 'No notes.'}</p> : null}
                                          </button>
                                        )}
                                        {isEditMode ? (
                                          <button className="asset-insert-button" onClick={() => addItem(roomIndex, sectionIndex, itemIndex)} type="button" aria-label="Add row">
                                            +
                                          </button>
                                        ) : null}
                                      </div>
                                    )
                                  })}
                                </div>
                              ) : null}
                              {isEditMode ? (
                                <button className="asset-insert-button" onClick={() => addSection(roomIndex, sectionIndex)} type="button" aria-label="Add section">
                                  +
                                </button>
                              ) : null}
                            </section>
                          )
                        })}
                        {roomLinkedProjects.map((project) => {
                          const projectStatus: ProjectStatus = project.derived_status ?? project.status ?? 'planned'
                          const linkedKey = `linked-${project.id}`
                          const isLinkedExpanded = expandedSectionKeys.has(linkedKey)
                          const linkedItems = projectRooms(project).flatMap((linkedRoom) => linkedRoom.sections.flatMap((linkedSection) => linkedSection.items))
                          return (
                            <section className={`property-room-section property-room-section--linked ${isLinkedExpanded ? 'is-expanded' : ''}`} key={linkedKey}>
                              <div className="property-room-section__header property-room-section__header--linked">
                                <button
                                  className="property-linked-toggle"
                                  onClick={() => toggleSection(linkedKey)}
                                  type="button"
                                  aria-expanded={isLinkedExpanded}
                                >
                                  <strong>{isLinkedExpanded ? '-' : '+'} {project.name}</strong>
                                </button>
                                {onOpenProject ? (
                                  <button
                                    className="property-linked-open"
                                    onClick={() => onOpenProject(project)}
                                    type="button"
                                    aria-label={`Open ${project.name}`}
                                    title="Open linked project"
                                  >
                                    <Link2 className="h-4 w-4" />
                                  </button>
                                ) : (
                                  <span className="property-linked-open" aria-hidden="true"><Link2 className="h-4 w-4" /></span>
                                )}
                                <span className="property-section-meta">
                                  {fmtCurrency(projectPlanningTotal(project), currency)}
                                  <ProjectStatusIcon status={projectStatus} />
                                </span>
                              </div>
                              {isLinkedExpanded ? (
                                <div className="property-room-items">
                                  {linkedItems.length ? (
                                    linkedItems.map((item, itemIndex) => {
                                      const done = isProjectItemCompleted(item, project.status)
                                      return (
                                        <div className="property-room-item-shell" key={`${linkedKey}-item-${itemIndex}`}>
                                          <div className={`property-room-item property-room-item--status ${done ? 'is-complete' : ''}`}>
                                            <span aria-hidden="true" className={`property-item-status${done ? ' is-complete' : ''}`}>
                                              {done ? <Check className="h-3 w-3" /> : null}
                                            </span>
                                            <span>{item.name}</span>
                                            <small>
                                              {item.unit_price ? String(item.unit_price) : '-'}
                                              {' x '}
                                              {item.quantity ? String(item.quantity) : '-'}
                                            </small>
                                            <strong>{fmtCurrency(projectItemTotal(item), currency)}</strong>
                                          </div>
                                        </div>
                                      )
                                    })
                                  ) : (
                                    <p className="property-item-note property-linked-empty">No items in this project yet.</p>
                                  )}
                                </div>
                              ) : null}
                            </section>
                          )
                        })}
                      </div>
                    </>
                  ) : null}
                  {isEditMode ? (
                    <button className="asset-insert-button" onClick={() => addRoom(roomIndex)} type="button" aria-label="Add category">
                      +
                    </button>
                  ) : null}
                </article>
              )
            })}
              </>
            ) : (
              <RoomBreakdown
                rooms={rooms}
                keyPrefix="own"
                currency={currency}
                statusSource={storedStatus}
                expandedRoomKeys={expandedRoomKeys}
                expandedSectionKeys={expandedSectionKeys}
                expandedItemKeys={expandedItemKeys}
                toggleRoom={toggleRoom}
                toggleSection={toggleSection}
                toggleItemNotes={toggleItemNotes}
                linkedProjectsForRoom={presentation === 'inline' ? undefined : linkedProjectsFor}
                onOpenProject={onOpenProject}
              />
            )}
          </div>
        ) : null}
        {fallbackProjectRoomGroups.length ? (
          <div className="property-room-breakdown">
            {fallbackProjectRoomGroups.map(({ project, rooms: projectRoomList }) => (
              <div className="property-linked-project-group" key={project.id}>
                <div className="property-linked-project-group__head">
                  <strong>{project.name}</strong>
                  <span className="property-section-meta">
                    {fmtCurrency(projectPlanningTotal(project), currency)}
                    <ProjectStatusIcon status={project.derived_status ?? project.status ?? 'planned'} />
                  </span>
                  {onOpenProject ? (
                    <button
                      className="property-linked-open"
                      onClick={() => onOpenProject(project)}
                      type="button"
                      aria-label={`Open ${project.name}`}
                      title="Open linked project"
                    >
                      <Link2 className="h-4 w-4" />
                    </button>
                  ) : null}
                </div>
                <RoomBreakdown
                  rooms={projectRoomList}
                  keyPrefix={`fallback-${project.id}`}
                  currency={currency}
                  statusSource={project.status}
                  expandedRoomKeys={expandedRoomKeys}
                  expandedSectionKeys={expandedSectionKeys}
                  expandedItemKeys={expandedItemKeys}
                  toggleRoom={toggleRoom}
                  toggleSection={toggleSection}
                  toggleItemNotes={toggleItemNotes}
                />
              </div>
            ))}
          </div>
        ) : null}
        {!isEditMode && property.expenses_enabled !== false && linkedCategoryNames.length ? (
          <div className="detail-row">
            <span>Linked expenses</span>
            <strong>{fmtCurrency(property.linked_expense_total ?? 0, currency)}</strong>
            <small>{linkedCategoryNames.join(', ')}</small>
          </div>
        ) : null}
      </div>
      <div className="detail-row detail-row--total property-detail-footer">
        <span>Total cost</span>
        <strong>{fmtCurrency(computedTotal, currency)}</strong>
        {!isEditMode && property.depreciation_rate ? (
          <small>
            Original {fmtCurrency(property.original_total_cost ?? property.total_cost, currency)} as of {fmtDate(property.valuation_date)}
            {' · '}
            {property.depreciation_rate > 0 ? '+' : ''}
            {(property.depreciation_rate * 100).toFixed(2)}%/mo
          </small>
        ) : null}
      </div>
    </Surface>
  )
}
