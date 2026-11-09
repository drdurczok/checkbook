import { Check, Link2 } from 'lucide-react'
import { ProjectStatusIcon } from './ProjectStatusIcon'
import { fmtCurrency } from '../lib/format'
import { isProjectItemCompleted, projectItemTotal, projectPlanningTotal, projectRooms, sectionStatusWithProjects } from '../lib/projects'
import type { AssetDetailRoom, AssetSummary, ProjectStatus } from '../types'

type Props = {
  rooms: AssetDetailRoom[]
  /** Distinguishes key namespaces when multiple breakdowns render on the
   * same page (e.g. a property's own rooms vs. its linked projects' rooms). */
  keyPrefix: string
  currency: string
  /** Status source for items/sections that don't set their own `completed`
   * flag explicitly. */
  statusSource: ProjectStatus | undefined
  expandedRoomKeys: Set<string>
  expandedSectionKeys: Set<string>
  toggleRoom: (key: string) => void
  toggleSection: (key: string) => void
  toggleItemNotes: (key: string) => void
  expandedItemKeys: Set<string>
  /** Sub-projects linked directly under a room (only the property's own
   * breakdown has these — a linked project's own rooms don't nest further). */
  linkedProjectsForRoom?: (roomIndex: number) => AssetSummary[]
  onOpenProject?: (project: AssetSummary) => void
}

/** Read-only room → section → item breakdown, used both for a property's
 * own rooms and for the rooms of projects linked to it. Editing (add/rename/
 * delete) is a separate, richer tree that lives in PropertyDetailModal —
 * this component only covers the view-mode rendering the two previously
 * duplicated verbatim. */
export function RoomBreakdown({
  rooms,
  keyPrefix,
  currency,
  statusSource,
  expandedRoomKeys,
  expandedSectionKeys,
  expandedItemKeys,
  toggleRoom,
  toggleSection,
  toggleItemNotes,
  linkedProjectsForRoom,
  onOpenProject,
}: Props) {
  return (
    <>
      {rooms.map((room, roomIndex) => {
        const roomKey = `${keyPrefix}-room-${roomIndex}`
        const isRoomExpanded = expandedRoomKeys.has(roomKey)
        const roomLinkedProjects = linkedProjectsForRoom?.(roomIndex) ?? []
        const roomTotal =
          room.sections.reduce((sum, section) => sum + section.items.reduce((nested, item) => nested + projectItemTotal(item), 0), 0) +
          roomLinkedProjects.reduce((sum, project) => sum + projectPlanningTotal(project), 0)
        return (
          <article className={`property-room-card ${isRoomExpanded ? 'is-expanded' : ''}`} key={roomKey}>
            <button className="property-room-card__header asset-click-row" onClick={() => toggleRoom(roomKey)} type="button" aria-expanded={isRoomExpanded}>
              <strong>{isRoomExpanded ? '-' : '+'} {room.name}</strong>
              <span>{fmtCurrency(roomTotal, currency)}</span>
            </button>
            {isRoomExpanded ? (
              <div className="property-room-sections">
                {room.sections.map((section, sectionIndex) => {
                  const sectionKey = `${roomKey}-${sectionIndex}`
                  const isSectionExpanded = expandedSectionKeys.has(sectionKey)
                  const sectionTotal = section.items.reduce((sum, item) => sum + projectItemTotal(item), 0)
                  const sectionStatus = sectionStatusWithProjects(section, statusSource, [])
                  return (
                    <section className={`property-room-section ${isSectionExpanded ? 'is-expanded' : ''}`} key={sectionKey}>
                      <button className="property-room-section__header asset-click-row" onClick={() => toggleSection(sectionKey)} type="button" aria-expanded={isSectionExpanded}>
                        <strong>{isSectionExpanded ? '-' : '+'} {section.name}</strong>
                        <span className="property-section-meta">
                          {fmtCurrency(sectionTotal, currency)}
                          <ProjectStatusIcon status={sectionStatus} />
                        </span>
                      </button>
                      {isSectionExpanded ? (
                        <div className="property-room-items">
                          {section.items.map((item, itemIndex) => {
                            const itemKey = `${sectionKey}-${itemIndex}`
                            const isExpanded = expandedItemKeys.has(itemKey)
                            const isItemCompleted = isProjectItemCompleted(item, statusSource)
                            const totalValue = projectItemTotal(item)
                            return (
                              <div className="property-room-item-shell" key={itemKey}>
                                <button
                                  className={`property-room-item property-room-item--button property-room-item--status ${isExpanded ? 'is-expanded' : ''} ${isItemCompleted ? 'is-complete' : ''}`}
                                  onClick={() => toggleItemNotes(itemKey)}
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
                              </div>
                            )
                          })}
                        </div>
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
                        <button className="property-linked-toggle" onClick={() => toggleSection(linkedKey)} type="button" aria-expanded={isLinkedExpanded}>
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
            ) : null}
          </article>
        )
      })}
    </>
  )
}
