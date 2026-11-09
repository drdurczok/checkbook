import { Checkbox } from './ui/NativeControls'
import { useId, useMemo, useState } from 'react'
import { OutlinedInput, OutlinedNativeSelect, OutlinedTextarea } from './ui/OutlinedField'
import { Calendar, CalendarDays, Check, ChevronDown, ChevronRight, Coins, Folder, FolderKanban, Hash, Link2, Palette, Plus, Save, StickyNote, Tag, Trash2, X } from 'lucide-react'
import { Modal } from './Modal'
import { DetailActionsMenu } from './DetailActionsMenu'
import { ProjectStatusIcon } from './ProjectStatusIcon'
import { fmtDate, fmtMoney, numericAmount, currencySymbol, formatAmountDraft, parseAmountDraft } from '../lib/format'
import { PROJECT_COLORS, PROJECT_STATUS_LABELS, isProjectItemCompleted, projectColorKey, projectColorValue, projectItemTotal, projectItemsStatus, projectRooms, projectRoomsCompletion } from '../lib/projects'
import type { AssetDetailItem, AssetDetailRoom, AssetSummary, ProjectStatus } from '../types'

export type ProjectSavePayload = {
  name: string
  total_cost: number
  valuation_date: string
  status: ProjectStatus
  started_on: string | null
  ended_on: string | null
  notes: string
  details: Record<string, unknown>
}

type ProjectModalMode = 'view' | 'edit'

/** The last persisted project state. Cancel restores drafts from it, and
 *  view-mode autosaves read from it, so discarded edits never leak into saves. */
type ProjectDraft = {
  name: string
  category: string
  color: string
  startedOn: string
  endedOn: string
  notes: string
  rooms: AssetDetailRoom[]
}

const projectDraft = (project: AssetSummary): ProjectDraft => ({
  name: project.name,
  category: typeof project.details?.category === 'string' ? project.details.category : '',
  color: projectColorKey(project),
  startedOn: project.started_on ?? '',
  endedOn: project.ended_on ?? '',
  notes: project.notes ?? '',
  rooms: cloneRooms(projectRooms(project)),
})

const emptyItem = (): AssetDetailItem => ({ name: '', total_cost: 0, notes: '', completed: false })

const cloneRooms = (rooms: AssetDetailRoom[]): AssetDetailRoom[] =>
  rooms.map((room) => ({
    ...room,
    sections: room.sections.map((section) => ({
      ...section,
      items: section.items.map((item) => ({ ...item })),
    })),
  }))

const hasNumericValue = (value: unknown) =>
  value !== null && value !== undefined && value !== '' && Number.isFinite(numericAmount(value))

const computeProjectStats = (rooms: AssetDetailRoom[], storedStatus: ProjectStatus) => {
  const { completionPercent: percent, ...stats } = projectRoomsCompletion(rooms, storedStatus)
  return { ...stats, percent }
}

const withPatchedItem = (
  rooms: AssetDetailRoom[],
  roomIndex: number,
  sectionIndex: number,
  itemIndex: number,
  patch: Partial<AssetDetailItem>,
): AssetDetailRoom[] =>
  rooms.map((room, rIndex) =>
    rIndex === roomIndex
      ? {
          ...room,
          sections: room.sections.map((section, sIndex) =>
            sIndex === sectionIndex
              ? {
                  ...section,
                  items: section.items.map((item, iIndex) => (iIndex === itemIndex ? { ...item, ...patch } : item)),
                }
              : section,
          ),
        }
      : room,
  )

export function ProjectModal({
  project,
  currency,
  saving,
  assets,
  categoryOptions = [],
  initialMode = 'view',
  onClose,
  onSave,
  onAutoSave,
  onLinkAsset,
}: {
  project: AssetSummary
  currency: string
  saving: boolean
  assets: AssetSummary[]
  categoryOptions?: string[]
  initialMode?: ProjectModalMode
  onClose: () => void
  onSave: (payload: ProjectSavePayload) => Promise<boolean>
  onAutoSave: (payload: ProjectSavePayload) => void
  onLinkAsset: (assetId: string | null, sectionPath: string | null) => void
}) {
  const fieldId = useId()
  const storedStatus: ProjectStatus = project.status ?? 'completed'
  const [saved, setSaved] = useState<ProjectDraft>(() => projectDraft(project))
  const [mode, setMode] = useState<ProjectModalMode>(initialMode)
  const [name, setName] = useState(saved.name)
  const [category, setCategory] = useState(saved.category)
  const [color, setColor] = useState(saved.color)
  const [startedOn, setStartedOn] = useState(saved.startedOn)
  const [endedOn, setEndedOn] = useState(saved.endedOn)
  const [notes, setNotes] = useState(saved.notes)
  const [isNotesOpen, setIsNotesOpen] = useState(Boolean(saved.notes))
  const [rooms, setRooms] = useState<AssetDetailRoom[]>(() => cloneRooms(saved.rooms))
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set())
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [linkDraftAssetId, setLinkDraftAssetId] = useState<string | null>(null)

  const stats = useMemo(() => computeProjectStats(rooms, storedStatus), [rooms, storedStatus])
  const projectTotal = stats.itemCount ? stats.itemsTotal : numericAmount(project.total_cost)
  const isViewing = mode === 'view'
  const linkedAsset = project.linked_asset_id
    ? assets.find((asset) => asset.id === project.linked_asset_id) ?? null
    : null
  const linkedAssetName = linkedAsset?.name ?? project.linked_asset_name ?? null
  const linkedSectionPath = typeof project.details?.linked_section_path === 'string' ? project.details.linked_section_path : null
  // A project links to a section (the top-level grouping of a property) and shows
  // up there as a group, so the picker lists sections, not the groups beneath them.
  const sectionOptionsFor = (asset: AssetSummary | undefined | null) =>
    (asset ? projectRooms(asset) : []).map((room, roomIndex) => ({ path: `${roomIndex}`, label: room.name }))
  const linkedSectionLabel = sectionOptionsFor(linkedAsset).find((option) => option.path === linkedSectionPath)?.label ?? null
  const linkDraftAsset = linkDraftAssetId ? assets.find((asset) => asset.id === linkDraftAssetId) ?? null : null
  const linkDraftSections = sectionOptionsFor(linkDraftAsset)
  const dateRangeLabel = startedOn && endedOn
    ? `${fmtDate(startedOn)} → ${fmtDate(endedOn)}`
    : startedOn
      ? `From ${fmtDate(startedOn)}`
      : endedOn
        ? `Until ${fmtDate(endedOn)}`
        : ''

  async function submitSave() {
    const savedOk = await onSave(buildPayload(rooms, name, notes))
    if (savedOk) {
      setSaved({ name, category, color, startedOn, endedOn, notes, rooms })
      setMode('view')
    }
  }

  function cancelEditing() {
    setName(saved.name)
    setCategory(saved.category)
    setColor(saved.color)
    setStartedOn(saved.startedOn)
    setEndedOn(saved.endedOn)
    setNotes(saved.notes)
    setIsNotesOpen(Boolean(saved.notes))
    setRooms(cloneRooms(saved.rooms))
    setExpandedItems(new Set())
    setExpandedGroups(new Set())
    setLinkDraftAssetId(null)
    setMode('view')
  }

  function buildPayload(nextRooms: AssetDetailRoom[], nextName: string, nextNotes: string): ProjectSavePayload {
    const recalculated = nextRooms.map((room) => {
      const sections = room.sections.map((section) => ({
        ...section,
        total: section.items.reduce((sum, item) => sum + projectItemTotal(item), 0),
      }))
      return { ...room, sections, total: sections.reduce((sum, section) => sum + section.total, 0) }
    })
    const nextStats = computeProjectStats(recalculated, storedStatus)
    const details: Record<string, unknown> = { ...(project.details ?? {}), rooms: recalculated }
    if (category.trim()) {
      details.category = category.trim()
    } else {
      delete details.category
    }
    if (color) {
      details.color = color
    } else {
      delete details.color
    }
    return {
      name: nextName.trim() || project.name,
      total_cost: nextStats.itemCount ? nextStats.itemsTotal : numericAmount(project.total_cost),
      valuation_date: project.valuation_date,
      status: nextStats.itemCount ? nextStats.derivedStatus : storedStatus,
      started_on: startedOn || null,
      ended_on: endedOn || null,
      notes: nextNotes,
      details,
    }
  }

  function toggleItem(roomIndex: number, sectionIndex: number, itemIndex: number, completed: boolean) {
    const nextRooms = withPatchedItem(rooms, roomIndex, sectionIndex, itemIndex, { completed })
    setRooms(nextRooms)
    if (isViewing) {
      // The toggle is persisted immediately, so it becomes part of the saved
      // state a later Cancel restores to.
      setSaved((current) => ({ ...current, rooms: nextRooms }))
      onAutoSave(buildPayload(nextRooms, saved.name, saved.notes))
    }
  }

  function updateItem(roomIndex: number, sectionIndex: number, itemIndex: number, patch: Partial<AssetDetailItem>) {
    setRooms((current) => withPatchedItem(current, roomIndex, sectionIndex, itemIndex, patch))
  }

  function patchSection(roomIndex: number, sectionIndex: number, patch: (section: AssetDetailRoom['sections'][number]) => AssetDetailRoom['sections'][number]) {
    setRooms((current) =>
      current.map((room, rIndex) =>
        rIndex === roomIndex
          ? { ...room, sections: room.sections.map((section, sIndex) => (sIndex === sectionIndex ? patch(section) : section)) }
          : room,
      ),
    )
  }

  function addItem(roomIndex: number, sectionIndex: number) {
    patchSection(roomIndex, sectionIndex, (section) => ({ ...section, items: [...section.items, emptyItem()] }))
  }

  function removeItem(roomIndex: number, sectionIndex: number, itemIndex: number) {
    patchSection(roomIndex, sectionIndex, (section) => ({
      ...section,
      items: section.items.filter((_, iIndex) => iIndex !== itemIndex),
    }))
  }

  function renameGroup(roomIndex: number, sectionIndex: number, nextName: string) {
    patchSection(roomIndex, sectionIndex, (section) => ({ ...section, name: nextName }))
  }

  function removeGroup(roomIndex: number, sectionIndex: number) {
    setRooms((current) =>
      current
        .map((room, rIndex) =>
          rIndex === roomIndex
            ? { ...room, sections: room.sections.filter((_, sIndex) => sIndex !== sectionIndex) }
            : room,
        )
        .filter((room) => room.sections.length > 0),
    )
  }

  function addGroup() {
    const next = !rooms.length
      ? [{ name: 'Plan', total: 0, sections: [{ name: 'New group', total: 0, items: [] }] }]
      : rooms.map((room, rIndex) =>
          rIndex === rooms.length - 1
            ? { ...room, sections: [...room.sections, { name: 'New group', total: 0, items: [] }] }
            : room,
        )
    const roomIndex = rooms.length ? rooms.length - 1 : 0
    const sectionIndex = rooms.length ? rooms[roomIndex].sections.length : 0
    setRooms(next)
    setExpandedGroups((current) => new Set(current).add(`${roomIndex}:${sectionIndex}`))
  }

  function toggleExpanded(key: string) {
    setExpandedItems((current) => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  function toggleGroup(key: string) {
    setExpandedGroups((current) => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const renderCheck = (roomIndex: number, sectionIndex: number, itemIndex: number, completed: boolean) => (
    <label className="project-item__check" title={completed ? 'Mark as not done' : 'Mark as done'}>
      <Checkbox
        aria-label={completed ? 'Mark as not done' : 'Mark as done'}
        checked={completed}
        onChange={(event) => toggleItem(roomIndex, sectionIndex, itemIndex, event.target.checked)}

      />
      <span aria-hidden="true"><Check className="h-3.5 w-3.5" /></span>
    </label>
  )

  // Linking remains editable; view mode omits the redundant property chip.
  const linkControl = linkedAssetName ? (
    <span className="project-link-chip">
      <Link2 className="h-3.5 w-3.5" />
      {linkedAssetName}{linkedSectionLabel ? ` › ${linkedSectionLabel}` : ''}
      <button aria-label={`Unlink ${linkedAssetName}`} onClick={() => { onLinkAsset(null, null); setLinkDraftAssetId(null) }} title="Unlink" type="button">
        <X className="h-3 w-3" />
      </button>
    </span>
  ) : linkDraftAsset ? (
    linkDraftSections.length ? (
      <span className="project-hero-link">
        <Link2 className="h-3.5 w-3.5" />
        <span className="project-hero-link__draft">{linkDraftAsset.name} ›</span>
        <OutlinedNativeSelect
          id={`${fieldId}-link-section`}
          label="Choose a section"
          aria-label="Choose a section"
          className="project-hero-link__select"
          value=""
          onChange={(event) => {
            if (event.target.value) {
              onLinkAsset(linkDraftAsset.id, event.target.value)
              setLinkDraftAssetId(null)
            }
          }}
        >
          <option value="">Choose a section…</option>
          {linkDraftSections.map((option) => (
            <option key={option.path} value={option.path}>{option.label}</option>
          ))}
        </OutlinedNativeSelect>
        <button className="project-hero-link__cancel" onClick={() => setLinkDraftAssetId(null)} type="button">Cancel</button>
      </span>
    ) : (
      <span className="project-hero-link">
        <small>{linkDraftAsset.name} has no sections yet.</small>
        <button className="project-hero-link__cancel" onClick={() => setLinkDraftAssetId(null)} type="button">Cancel</button>
      </span>
    )
  ) : assets.length ? (
    <OutlinedNativeSelect
      id={`${fieldId}-link-property`}
      label="Link a property"
      className="project-hero-link__select"
      leadingIcon={<Link2 className="h-3.5 w-3.5" />}
      value=""
      onChange={(event) => {
        if (event.target.value) {
          setLinkDraftAssetId(event.target.value)
        }
      }}
    >
      <option value="">Link property</option>
      {assets.map((asset) => (
        <option key={asset.id} value={asset.id}>{asset.name}</option>
      ))}
    </OutlinedNativeSelect>
  ) : (
    <small className="project-hero-link__empty">No properties yet — add one on the Properties page first.</small>
  )

  return (
    <Modal
      className="quick-add-modal project-modal"
      title={isViewing
        ? (name.trim() || 'Project')
        : (
            <OutlinedInput
              id={`${fieldId}-name`}
              label="Project name"
              aria-label="Project name"
              className="project-title-input"
              placeholder="What are you planning?"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          )}
      titleId="project-modal-title"
      onClose={onClose}
      actions={
        <div className="project-modal-header-actions">
          {isViewing ? (
            <DetailActionsMenu label="Project actions" actions={[{ label: 'Edit', onClick: () => setMode('edit') }]} />
          ) : (
            <>
              <button aria-label="Cancel editing project" className="button button--compact button--ghost" onClick={cancelEditing} title="Cancel" type="button">
                <X className="h-4 w-4" />
                <span className="mobile-action-label">Cancel</span>
              </button>
              <button aria-label={saving ? 'Saving project' : 'Save project'} className="button button--compact" disabled={saving} onClick={() => void submitSave()} title="Save" type="button">
                <Save className="h-4 w-4" />
                <span className="mobile-action-label">{saving ? 'Saving...' : 'Save'}</span>
              </button>
            </>
          )}
          <button aria-label="Close project details" className="record-add-close" onClick={onClose} title="Close" type="button">
            <X className="h-4 w-4" />
          </button>
        </div>
      }
    >
      <form className="quick-add-form project-modal-form" onSubmit={(event) => event.preventDefault()}>
        <div className={`project-modal-hero is-${stats.derivedStatus}`}>
          <div className="project-modal-hero__top">
            <span className="project-modal-hero__icon"><FolderKanban className="h-5 w-5" /></span>
            <div className="project-modal-hero__stats">
              <div><span>Total</span><strong>{fmtMoney(projectTotal, currency)}</strong></div>
              <div><span>Done</span><strong>{fmtMoney(stats.completedCost, currency)}</strong></div>
              <div><span>Left</span><strong>{fmtMoney(Math.max(0, projectTotal - stats.completedCost), currency)}</strong></div>
            </div>
            <span className={`project-status-pill is-${stats.derivedStatus}`}>{PROJECT_STATUS_LABELS[stats.derivedStatus]}</span>
          </div>
          <div className="project-modal-hero__bar"><span style={{ width: `${stats.percent.toFixed(1)}%` }} /></div>
          <div className="project-modal-hero__footer">
            <small>
              {stats.itemCount
                ? `${stats.completedItemCount} of ${stats.itemCount} items complete`
                : isViewing
                  ? 'No items yet — hit Edit to break this project down.'
                  : 'No items yet — add a group below to break this project down.'}
            </small>
            {!isViewing ? <div className="project-hero-link-slot">{linkControl}</div> : null}
          </div>
        </div>

        {isViewing ? (
          category.trim() || dateRangeLabel ? (
            <div className="project-category-row">
              {category.trim() ? <span className="project-category-chip"><Tag className="h-3.5 w-3.5" />{category.trim()}</span> : null}
              {dateRangeLabel ? <span className="project-category-chip"><CalendarDays className="h-3.5 w-3.5" />{dateRangeLabel}</span> : null}
            </div>
          ) : null
        ) : (
          <div className="form-grid project-meta-grid">
            <OutlinedNativeSelect
              id={`${fieldId}-color`}
              label="Color"
              className="project-color-field"
              leadingIcon={<Palette />}
              trailing={<span className="project-color-dot" style={projectColorValue(color) ? { background: projectColorValue(color) } : undefined} />}
              value={color}
              onChange={(event) => setColor(event.target.value)}
            >
              {PROJECT_COLORS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </OutlinedNativeSelect>
            <OutlinedInput
              id={`${fieldId}-category`}
              label="Category"
              leadingIcon={<Folder />}
              list={`${fieldId}-category-options`}
              placeholder="Start typing..."
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            />
            <datalist id={`${fieldId}-category-options`}>
              {categoryOptions.map((option) => <option key={option} value={option} />)}
            </datalist>
            <div className="field-pair">
              <OutlinedInput id={`${fieldId}-from`} label="From" leadingIcon={<Calendar />} type="date" value={startedOn} onChange={(event) => setStartedOn(event.target.value)} />
              <OutlinedInput id={`${fieldId}-to`} label="To" leadingIcon={<Calendar />} type="date" value={endedOn} onChange={(event) => setEndedOn(event.target.value)} />
            </div>
          </div>
        )}

        <div className="project-groups">
          {rooms.map((room, roomIndex) => (
            <section className="project-room" key={roomIndex} aria-label={room.name || 'Project category'}>
              <header className="project-room__header">
                <strong>{room.name || 'Untitled category'}</strong>
                <span>{fmtMoney(room.sections.reduce((total, section) => total + section.items.reduce((sum, item) => sum + projectItemTotal(item), 0), 0), currency)}</span>
              </header>
              <div className="project-room__sections">
                {room.sections.map((section, sectionIndex) => {
                  const groupKey = `${roomIndex}:${sectionIndex}`
                  const groupTotal = section.items.reduce((sum, item) => sum + projectItemTotal(item), 0)
                  const groupStatus = projectItemsStatus(section.items, storedStatus)
                  const isGroupExpanded = expandedGroups.has(groupKey)
                  const groupMeta = (
                    <span className="project-group__meta">
                      {fmtMoney(groupTotal, currency)}
                      <ProjectStatusIcon status={groupStatus} />
                    </span>
                  )
                  return (
                    <section className="project-group" key={groupKey}>
                      {isViewing ? (
                        <button
                          aria-expanded={isGroupExpanded}
                          className="project-group__header project-group__header--view"
                          onClick={() => toggleGroup(groupKey)}
                          type="button"
                        >
                          {isGroupExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          <strong className="project-group__name">{section.name}</strong>
                          {groupMeta}
                        </button>
                      ) : (
                        <header className="project-group__header">
                          <button
                            aria-expanded={isGroupExpanded}
                            aria-label={isGroupExpanded ? 'Collapse group' : 'Expand group'}
                            className="icon-button project-group__toggle"
                            onClick={() => toggleGroup(groupKey)}
                            type="button"
                          >
                            {isGroupExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </button>
                          <OutlinedInput id={`${fieldId}-group-${groupKey}-name`} label="Group name" value={section.name} onChange={(event) => renameGroup(roomIndex, sectionIndex, event.target.value)} />
                          {groupMeta}
                          <button aria-label="Delete group" className="icon-button project-group__remove" onClick={() => removeGroup(roomIndex, sectionIndex)} type="button">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </header>
                      )}
                      {isGroupExpanded ? (
                        <div className="project-group__items">
                          {section.items.map((item, itemIndex) => {
                            const itemKey = `${roomIndex}:${sectionIndex}:${itemIndex}`
                            const completed = isProjectItemCompleted(item, storedStatus)
                            const computedTotal = projectItemTotal(item)
                            const totalIsComputed = hasNumericValue(item.unit_price) && hasNumericValue(item.quantity)
                            const isExpanded = expandedItems.has(itemKey)
                            if (isViewing) {
                              return (
                                <div className={`project-item project-item--view${completed ? ' is-complete' : ''}`} key={itemKey}>
                                  <div className="project-item__row project-item__row--view">
                                    {renderCheck(roomIndex, sectionIndex, itemIndex, completed)}
                                    <span className="project-item__label">
                                      <span className="project-item__title">{item.name || 'Untitled item'}</span>
                                    </span>
                                    <span className="project-item__pricing">
                                      {hasNumericValue(item.quantity) || hasNumericValue(item.unit_price) ? (
                                        <small className="project-item__calculation">{hasNumericValue(item.quantity) ? String(item.quantity) : '-'} × {hasNumericValue(item.unit_price) ? String(item.unit_price) : '-'}</small>
                                      ) : null}
                                      <strong className="project-item__total">{fmtMoney(computedTotal, currency)}</strong>
                                    </span>
                                  </div>
                                  {item.notes ? <p className="project-item__note">{item.notes}</p> : null}
                                </div>
                              )
                            }
                            return (
                              <div className={`project-item${completed ? ' is-complete' : ''}`} key={itemKey}>
                                <div className="project-item__row">
                                  {renderCheck(roomIndex, sectionIndex, itemIndex, completed)}
                                  <OutlinedInput
                                    id={`${fieldId}-item-${itemKey}-name`}
                                    label="Item name"
                                    aria-label="Item name"
                                    className="project-item__name"
                                    placeholder="Item"
                                    value={item.name}
                                    onChange={(event) => updateItem(roomIndex, sectionIndex, itemIndex, { name: event.target.value })}
                                  />
                                  {totalIsComputed ? (
                                    <strong className="project-item__total">{fmtMoney(computedTotal, currency)}</strong>
                                  ) : (
                                    <OutlinedInput
                                      id={`${fieldId}-item-${itemKey}-total`}
                                      label="Item total"
                                      aria-label="Item total"
                                      className="project-item__total-input"
                                      inputMode="decimal"
                                      step="0.01"
                                      type="number"
                                      value={String(item.total_cost ?? 0)}
                                      onChange={(event) => updateItem(roomIndex, sectionIndex, itemIndex, { total_cost: Number(event.target.value) || 0 })}
                                    />
                                  )}
                                  <button
                                    aria-expanded={isExpanded}
                                    aria-label="Item details"
                                    className="icon-button project-item__expand"
                                    onClick={() => toggleExpanded(itemKey)}
                                    type="button"
                                  >
                                    {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                                  </button>
                                  <button
                                    aria-label="Delete item"
                                    className="icon-button project-item__remove"
                                    onClick={() => removeItem(roomIndex, sectionIndex, itemIndex)}
                                    type="button"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </button>
                                </div>
                                {isExpanded ? (
                                  <div className="project-item__details">
                                    <OutlinedInput
                                      id={`${fieldId}-item-${itemKey}-quantity`}
                                      label="Quantity"
                                      leadingIcon={<Hash />}
                                      autoComplete="off"
                                      inputMode="decimal"
                                      placeholder="Quantity"
                                      value={String(item.quantity ?? '')}
                                      onChange={(event) => updateItem(roomIndex, sectionIndex, itemIndex, { quantity: event.target.value })}
                                    />
                                    <OutlinedInput
                                      id={`${fieldId}-item-${itemKey}-unit-price`}
                                      label="Unit price"
                                      leadingIcon={<Coins />}
                                      trailing={<span className={`record-add-field-currency${hasNumericValue(item.unit_price) ? '' : ' is-empty'}`}>{currencySymbol(currency)}</span>}
                                      autoComplete="off"
                                      inputMode="decimal"
                                      placeholder="Unit price"
                                      value={formatAmountDraft(String(item.unit_price ?? ''))}
                                      onChange={(event) => updateItem(roomIndex, sectionIndex, itemIndex, { unit_price: parseAmountDraft(event.target.value) })}
                                    />
                                    <OutlinedInput
                                      id={`${fieldId}-item-${itemKey}-notes`}
                                      label="Notes"
                                      className="project-item__notes"
                                      leadingIcon={<StickyNote />}
                                      placeholder="Notes"
                                      value={item.notes ?? ''}
                                      onChange={(event) => updateItem(roomIndex, sectionIndex, itemIndex, { notes: event.target.value })}
                                    />
                                  </div>
                                ) : null}
                              </div>
                            )
                          })}
                          {!isViewing ? (
                            <button className="project-add-item" onClick={() => addItem(roomIndex, sectionIndex)} type="button">
                              <Plus className="h-4 w-4" />
                              Item
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </section>
                  )
                })}
              </div>
            </section>
          ))}
          {!isViewing ? (
            <button className="project-add-group" onClick={addGroup} type="button">
              <Plus className="h-4 w-4" />
              Group
            </button>
          ) : null}
        </div>

        {isViewing ? (
          notes.trim() ? (
            <div className="project-modal-notes">
              <span>Notes</span>
              <p>{notes}</p>
            </div>
          ) : null
        ) : (
          <>
            {/* Notes are additive only: "+ Notes" reveals the field and
                disappears; empty notes simply save as no notes. */}
            {!isNotesOpen ? (
              <div className="record-add-notes-toggle-row">
                <button
                  aria-controls={`${fieldId}-notes`}
                  aria-expanded={false}
                  className="record-add-notes-toggle"
                  onClick={() => setIsNotesOpen(true)}
                  type="button"
                >
                  <Plus aria-hidden="true" className="h-4 w-4" />
                  Notes
                </button>
              </div>
            ) : null}
            {isNotesOpen ? (
              <OutlinedTextarea id={`${fieldId}-notes`} label="Notes" className="quick-add-notes" leadingIcon={<StickyNote />} placeholder="Optional details, links, reminders..." value={notes} onChange={(event) => setNotes(event.target.value)} />
            ) : null}
          </>
        )}

      </form>
    </Modal>
  )
}
