import { useEffect, useId, useMemo, useRef, useState } from 'react'
import Decimal from 'decimal.js'
import { Building2, Calendar, Car, ChevronDown, Hammer, Landmark, Pencil, Plus, Save, StickyNote, Trash2, Wallet, Zap } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Modal } from '../components/Modal'
import { HoldConfirmButton } from '../components/HoldConfirmButton'
import { FormSheet } from '../components/ui/FormSheet'
import { HeaderSelect } from '../components/HeaderSelect'
import { ProjectModal, type ProjectSavePayload } from '../components/ProjectModal'
import { useProjectGantt } from '../components/ProjectGantt'
import { PropertyDetailModal } from '../components/PropertyDetailModal'
import { UtilityConfigurationModal } from '../features/utilities/UtilityConfigurationModal'
import { UtilityValuesModal } from '../features/utilities/UtilityValuesModal'
import { EmptyState, SectionPanel } from '../components/panel'
import { Button } from '../components/ui/Button'
import { OutlinedInput, OutlinedNativeSelect, OutlinedTextarea } from '../components/ui/OutlinedField'
import { HoldingsPanel } from '../features/accounts/HoldingsPanel'
import { AccountSummary } from '../features/accounts/AccountSummary'
import { accountAssetPayload } from '../features/accounts/model'
import { PropertySummary } from '../features/properties/PropertySummary'
import { PropertyLoans } from '../features/properties/PropertyLoans'
import { LoanDetailModal } from '../features/loans/LoanDetailModal'
import { usePropertyMutations } from '../features/properties/usePropertyMutations'
import { SubjectActionsMenu } from '../features/properties/SubjectActionsMenu'
import { usePropertiesQuery } from '../features/properties/queries'
import { SubjectUtilitiesPanel } from '../features/utilities/SubjectUtilitiesPanel'
import type { UtilitySubjectRef } from '../features/utilities/queries'
import { api } from '../lib/api'
import { currencySymbol, fmtMoney, formatAmountDraft, numericAmount, parseAmountDraft, todayInputValue } from '../lib/format'
import { useHeaderActions, useHeaderSlot } from '../lib/header-slot'
import { usePropertyDetailHandlers } from '../lib/usePropertyDetailHandlers'
import { useSession } from '../lib/session'
import type { AccountRegistration, AccountType, AssetSummary, Category, LoanSummary } from '../types'

type PhysicalAssetCategory = 'property' | 'vehicle' | 'other' | 'account'
type AddKind = 'property' | 'account' | 'project' | 'values'

type CreateForm = {
  name: string
  value: string
  valuation_date: string
  started_on: string
  ended_on: string
  notes: string
  category: PhysicalAssetCategory
  account_type: AccountType
  account_registration: AccountRegistration
}

type AccountEditForm = {
  started_on: string
  ended_on: string
  name: string
  account_type: AccountType
  account_registration: AccountRegistration
  value: string
  valuation_date: string
  notes: string
}

type ProjectForm = {
  name: string
  total_cost: string
  started_on: string
  ended_on: string
  notes: string
}

const ADD_TABS = [
  { key: 'property', label: 'Property', icon: Building2 },
  { key: 'account', label: 'Account', icon: Wallet },
  { key: 'project', label: 'Project', icon: Hammer },
  { key: 'values', label: 'Utility values', icon: Zap },
] as const

const ADD_SUBJECT_OPTION = '__add_property__'

const emptyProjectForm = (): ProjectForm => ({
  name: '',
  total_cost: '0',
  started_on: '',
  ended_on: '',
  notes: '',
})

const emptyCreateForm = (category: PhysicalAssetCategory = 'property'): CreateForm => ({
  name: '',
  value: '',
  valuation_date: todayInputValue(),
  started_on: '',
  ended_on: '',
  notes: '',
  category,
  account_type: 'savings',
  account_registration: 'regular',
})

const accountEditFormFromAsset = (asset: AssetSummary): AccountEditForm => ({
  started_on: asset.started_on ?? '',
  ended_on: asset.ended_on ?? '',
  name: asset.name,
  account_type: asset.account_type ?? 'savings',
  account_registration: asset.account_registration ?? 'regular',
  value: String(asset.total_cost ?? ''),
  valuation_date: asset.valuation_date ?? todayInputValue(),
  notes: asset.notes ?? '',
})

const isProperty = (record: AssetSummary) => (record.kind ?? 'asset') === 'asset'
const isVehicle = (record: AssetSummary) => record.category === 'vehicle'
const isAccount = (record: AssetSummary) => record.category === 'account'

export function AssetsPage({ initialPropertyId }: {
  initialPropertyId?: string | null
} = {}) {
  const { token, currency, setError, setMessage } = useSession()
  const queryClient = useQueryClient()
  const fieldId = useId()
  const [busy, setBusy] = useState<string | null>(null)
  const [records, setRecords] = useState<AssetSummary[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [utilityCounts, setUtilityCounts] = useState<Record<string, number>>({})
  const [selectedProperty, setSelectedProperty] = useState<AssetSummary | null>(null)
  const [selectedLoan, setSelectedLoan] = useState<LoanSummary | null>(null)
  const [selectedKey, setSelectedKey] = useState(initialPropertyId ? `property:${initialPropertyId}` : '')
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [addKind, setAddKind] = useState<AddKind>('property')
  const [isKindMenuOpen, setIsKindMenuOpen] = useState(false)
  const kindMenuRef = useRef<HTMLDivElement | null>(null)
  const [createForm, setCreateForm] = useState<CreateForm>(() => emptyCreateForm())
  const [isConfigurationOpen, setIsConfigurationOpen] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const [valuesSubject, setValuesSubject] = useState<{ ref: UtilitySubjectRef; name: string } | null>(null)
  const [projectForm, setProjectForm] = useState<ProjectForm>(() => emptyProjectForm())
  const [projectEditing, setProjectEditing] = useState<AssetSummary | null>(null)
  const [projectModalMode, setProjectModalMode] = useState<'view' | 'edit'>('view')
  const [accountEditForm, setAccountEditForm] = useState<AccountEditForm | null>(null)

  const propertiesQuery = usePropertiesQuery(token)
  const legacyGroups = useQuery({ queryKey: ['legacy-utility-groups', token], queryFn: () => api.getGroups(token, { kind: 'contract', include_historic: true }), enabled: Boolean(token) })
  const legacyGroup = legacyGroups.data?.find((group) => selectedKey === `legacy:${group.id}`)

  useEffect(() => {
    if (!propertiesQuery.data) return
    setRecords(propertiesQuery.data.records)
    setCategories(propertiesQuery.data.categories)
    setUtilityCounts(propertiesQuery.data.utilityCounts)
  }, [propertiesQuery.data])

  useEffect(() => {
    const error = propertiesQuery.error
    if (error) setError(error instanceof Error ? error.message : 'Properties refresh failed.')
  }, [propertiesQuery.error, setError])

  const load = async () => {
    await propertiesQuery.refetch()
  }

  const physicalAssets = useMemo(() => records.filter(isProperty), [records])
  const properties = useMemo(() => physicalAssets.filter((item) => !isVehicle(item) && !isAccount(item)), [physicalAssets])
  const vehicles = useMemo(() => physicalAssets.filter(isVehicle), [physicalAssets])
  const accounts = useMemo(() => physicalAssets.filter(isAccount), [physicalAssets])
  const projects = useMemo(() => records.filter((record) => !isProperty(record)), [records])
  const categoryOptions = useMemo(
    () => categories.filter((category) => category.kind === 'expense').map((category) => category.name),
    [categories],
  )
  const totalValue = useMemo(() => properties.reduce((sum, property) => sum.plus(property.total_cost), new Decimal(0)).toNumber(), [properties])
  const vehiclesValue = useMemo(() => vehicles.reduce((sum, vehicle) => sum.plus(vehicle.total_cost), new Decimal(0)).toNumber(), [vehicles])
  const accountsValue = useMemo(() => accounts.reduce((sum, account) => sum.plus(account.total_cost), new Decimal(0)).toNumber(), [accounts])

  // The dropdown key only counts when it names a known subject; stale ids
  // (a deleted asset, an unknown deep link) fall back to All assets.
  const selectedSubject = useMemo<UtilitySubjectRef | null>(() => {
    const separator = selectedKey.indexOf(':')
    if (separator < 0) return null
    const type = selectedKey.slice(0, separator)
    const id = selectedKey.slice(separator + 1)
    if (!id) return null
    if (type === 'property' && physicalAssets.some((asset) => asset.id === id)) return { type: 'property', id }
    return null
  }, [physicalAssets, selectedKey])
  const selectedPropertyRecord = selectedSubject?.type === 'property'
    ? physicalAssets.find((asset) => asset.id === selectedSubject.id) ?? null
    : null
  // Projects are shown only within their assigned property.
  const visibleProjects = useMemo(
    () => (selectedPropertyRecord
      ? selectedPropertyRecord.projects_enabled === false
        ? []
        : projects.filter((project) => project.linked_asset_id === selectedPropertyRecord.id)
      : []),
    [projects, selectedPropertyRecord],
  )
  const projectGantt = useProjectGantt({
    projects: visibleProjects,
    currency,
    onOpenProject: (record) => {
      setProjectModalMode('view')
      setProjectEditing(record)
    },
  })

  useEffect(() => {
    if (!isKindMenuOpen) {
      return
    }
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && kindMenuRef.current?.contains(event.target)) {
        return
      }
      setIsKindMenuOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [isKindMenuOpen])

  const propertyPill = (
    <HeaderSelect
      ariaLabel="Asset"
      separatorGroups
      groups={[
        { options: [{ value: '', label: 'All assets' }] },
        ...(properties.length ? [{ options: properties.map((property) => ({ value: `property:${property.id}`, label: property.name })) }] : []),
        ...(vehicles.length ? [{ options: vehicles.map((vehicle) => ({ value: `property:${vehicle.id}`, label: vehicle.name })) }] : []),
        ...(['savings', 'stocks', 'options'] as const).map((type) => ({
          options: accounts.filter((account) => account.account_type === type).map((account) => ({ value: `property:${account.id}`, label: account.name })),
        })),
        ...(legacyGroups.data?.length ? [{ options: legacyGroups.data.map((group) => ({ value: `legacy:${group.id}`, label: `${group.name} (legacy history)` })) }] : []),
        ...(!selectedSubject ? [{ options: [{ value: ADD_SUBJECT_OPTION, label: '+ New asset' }] }] : []),
      ]}
      value={selectedKey}
      onChange={(nextValue) => {
        if (nextValue === ADD_SUBJECT_OPTION) {
          setCreateForm(emptyCreateForm())
          setAddKind('property')
          setIsAddOpen(true)
          return
        }
        setSelectedKey(nextValue)
      }}
    />
  )
  useHeaderSlot(propertyPill, [accounts, legacyGroups.data, properties, selectedKey, vehicles])

  useHeaderActions(
    selectedPropertyRecord ? (
      <SubjectActionsMenu
        subjectName={selectedPropertyRecord.name}
        onConfiguration={selectedPropertyRecord.category !== 'account' && selectedPropertyRecord.category !== 'vehicle' && selectedPropertyRecord.utilities_enabled !== false ? () => setIsConfigurationOpen(true) : undefined}
        onEdit={() => {
          // Accounts edit their identity in their own compact sheet; the
          // property detail modal is property/vehicle-shaped.
          if (selectedPropertyRecord.category === 'account') {
            setAccountEditForm(accountEditFormFromAsset(selectedPropertyRecord))
          } else {
            setSelectedProperty(selectedPropertyRecord)
          }
        }}
        onNotes={() => setNotesOpen(true)}
      />
    ) : null,
    [selectedPropertyRecord],
  )

  const statsFor = (property: AssetSummary) => {
    const linked = property.projects_enabled === false
      ? []
      : projects.filter((project) => project.linked_asset_id === property.id)
    return {
      projects: linked.length,
      loans: (propertiesQuery.data?.loans ?? []).filter((loan) => loan.linked_property_id === property.id).length,
      utilities: property.utilities_enabled === false ? 0 : utilityCounts[property.id] ?? 0,
    }
  }

  async function createProperty() {
    if (!token || !createForm.name.trim()) {
      return
    }
    setBusy('property-save')
    try {
      await api.createAsset(token, {
        name: createForm.name,
        total_cost: Number(createForm.value || 0),
        valuation_date: createForm.valuation_date || todayInputValue(),
        kind: 'asset',
        category: createForm.category,
        started_on: createForm.started_on || null,
        ended_on: createForm.ended_on || null,
        notes: createForm.notes,
        account_type: createForm.category === 'account' ? createForm.account_type : null,
        account_registration: createForm.category === 'account' ? createForm.account_registration : null,
      })
      void queryClient.invalidateQueries({ queryKey: ['overview'] })
      setIsAddOpen(false)
      setCreateForm(emptyCreateForm(createForm.category))
      await load()
      setMessage(
        createForm.category === 'vehicle'
          ? 'Vehicle saved.'
          : createForm.category === 'account'
            ? 'Account saved.'
            : 'Property saved.',
      )
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Property create failed.')
    } finally {
      setBusy(null)
    }
  }

  async function deleteAccount() {
    if (!token || !selectedPropertyRecord || busy) return
    setBusy('account-delete')
    try {
      await api.deleteAsset(token, selectedPropertyRecord.id)
      setAccountEditForm(null)
      setSelectedKey('')
      void queryClient.invalidateQueries({ queryKey: ['overview'] })
      await load()
      setMessage('Account deleted.')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Account delete failed.')
    } finally {
      setBusy(null)
    }
  }

  async function saveAccountEdit() {
    const asset = selectedPropertyRecord
    if (!token || !asset || asset.category !== 'account' || !accountEditForm?.name.trim()) {
      return
    }
    setBusy('property-save')
    try {
      const updated = await api.updateAsset(token, asset.id, accountAssetPayload(asset, {
        name: accountEditForm.name.trim(),
        started_on: accountEditForm.started_on || null,
        ended_on: accountEditForm.ended_on || null,
        total_cost: numericAmount(accountEditForm.value),
        valuation_date: accountEditForm.valuation_date || asset.valuation_date,
        notes: accountEditForm.notes,
        account_type: accountEditForm.account_type,
        account_registration: accountEditForm.account_registration,
      }))
      setAccountEditForm(null)
      setRecords((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      setMessage('Account updated.')
      void queryClient.invalidateQueries({ queryKey: ['overview'] })
      await load()
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Account save failed.')
    } finally {
      setBusy(null)
    }
  }

  // Holdings saves replace the whole holdings list; refresh the assets
  // query and net worth while keeping the account selected.
  async function onHoldingsSaved(updated: AssetSummary) {
    setRecords((current) => current.map((item) => (item.id === updated.id ? updated : item)))
    void queryClient.invalidateQueries({ queryKey: ['overview'] })
    await load()
  }

  async function createProject() {
    if (!token || !projectForm.name.trim() || !selectedPropertyRecord || selectedPropertyRecord.category === 'account' || selectedPropertyRecord.projects_enabled === false) {
      return
    }
    setBusy('property-save')
    try {
      // A project started from a property view links to it right away.
      const details = { linked_asset_id: selectedPropertyRecord.id }
      const created = await api.createAsset(token, {
        name: projectForm.name,
        total_cost: Number(projectForm.total_cost || 0),
        valuation_date: todayInputValue(),
        status: 'planned',
        kind: 'project',
        started_on: projectForm.started_on || null,
        ended_on: projectForm.ended_on || null,
        notes: projectForm.notes,
        details,
      })
      setIsAddOpen(false)
      setProjectForm(emptyProjectForm())
      const next = await api.getAssets(token)
      setRecords(next)
      const record = next.find((item) => item.id === created.id) ?? null
      if (record) {
        setProjectModalMode('edit')
        setProjectEditing(record)
      }
      setMessage('Project saved.')
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Project create failed.')
    } finally {
      setBusy(null)
    }
  }

  async function saveProject(payload: ProjectSavePayload): Promise<boolean> {
    if (!token || !projectEditing) {
      return false
    }
    setBusy('property-save')
    try {
      const updated = await api.updateAsset(token, projectEditing.id, payload)
      setRecords((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      setProjectEditing(updated)
      setMessage('Project saved.')
      return true
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Project save failed.')
      return false
    } finally {
      setBusy(null)
    }
  }

  async function autoSaveProject(payload: ProjectSavePayload) {
    if (!token || !projectEditing) {
      return
    }
    try {
      const updated = await api.updateAsset(token, projectEditing.id, payload)
      setRecords((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      setProjectEditing(updated)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Progress save failed.')
    }
  }

  async function linkProjectToAsset(assetId: string | null, sectionPath: string | null) {
    if (!token || !projectEditing) {
      return
    }
    const details: Record<string, unknown> = { ...(projectEditing.details ?? {}) }
    if (assetId) {
      details.linked_asset_id = assetId
      if (sectionPath) {
        details.linked_section_path = sectionPath
      } else {
        delete details.linked_section_path
      }
    } else {
      delete details.linked_asset_id
      delete details.linked_section_path
    }
    try {
      const updated = await api.updateAsset(token, projectEditing.id, {
        name: projectEditing.name,
        total_cost: projectEditing.total_cost,
        valuation_date: projectEditing.valuation_date,
        status: projectEditing.status ?? 'planned',
        started_on: projectEditing.started_on ?? null,
        ended_on: projectEditing.ended_on ?? null,
        notes: projectEditing.notes ?? '',
        details,
      })
      setRecords((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      setProjectEditing(updated)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Asset link failed.')
    }
  }

  const activeProperty = selectedProperty ?? selectedPropertyRecord
  const propertyMutations = usePropertyMutations({
    selectedProperty: activeProperty,
    setSelectedProperty,
    setCategories,
    updateRecord: (updated) => setRecords((current) => current.map((item) => (item.id === updated.id ? updated : item))),
    onDeleted: async () => {
      setSelectedKey('')
      await load()
    },
  })

  const {
    listValuations,
    addValuation,
    removeValuation,
    linkProject,
    unlinkProject,
    listUtilityFields,
    trackUtilityField,
    untrackUtilityField,
  } = usePropertyDetailHandlers({
    token,
    selectedProperty: activeProperty,
    setError,
    onRecordUpdated: (updated) => setRecords((current) => current.map((item) => (item.id === updated.id ? updated : item))),
    onUtilityFieldsChanged: (tracked) => {
      void queryClient.invalidateQueries({ queryKey: ['utility-board'] })
      if (activeProperty) {
        setUtilityCounts((current) => ({ ...current, [activeProperty.id]: tracked.length }))
      }
    },
  })

  const goToProperty = (asset: AssetSummary) => {
    setSelectedKey(`property:${asset.id}`)
  }

  const renderCard = (asset: AssetSummary, selectable: boolean) => {
    const stats = statsFor(asset)
    const Icon = asset.category === 'vehicle' ? Car : asset.category === 'account' ? Wallet : Building2
    const openCard = () => (selectable ? goToProperty(asset) : setSelectedProperty(asset))
    return (
      <div
        className="property-card"
        key={asset.id}
        onClick={openCard}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            openCard()
          }
        }}
        role="button"
        tabIndex={0}
      >
        <div className="property-card__head">
          <span className="property-card__icon" aria-hidden="true"><Icon className="h-5 w-5" /></span>
          <strong className="property-card__name">{asset.name}</strong>
        </div>
        <div className="property-card__value">{fmtMoney(asset.total_cost, currency)}</div>
        {asset.category === 'account' ? null : (
          <div className="property-card__stats">
            {asset.projects_enabled === false ? null : (
              <button
                className="property-stat property-stat--link"
                onClick={(event) => {
                  event.stopPropagation()
                  goToProperty(asset)
                }}
                type="button"
              >
                <Hammer className="h-3.5 w-3.5" aria-hidden="true" />
                <strong>{stats.projects}</strong>
                <small>{stats.projects === 1 ? 'project' : 'projects'}</small>
              </button>
            )}
            <span className="property-stat">
              <Landmark className="h-3.5 w-3.5" aria-hidden="true" />
              <strong>{stats.loans}</strong>
              <small>{stats.loans === 1 ? 'loan' : 'loans'}</small>
            </span>
            {asset.category === 'vehicle' || asset.utilities_enabled === false ? null : (
              <button
                className="property-stat property-stat--link"
                onClick={(event) => {
                  event.stopPropagation()
                  goToProperty(asset)
                }}
                type="button"
              >
                <Zap className="h-3.5 w-3.5" aria-hidden="true" />
                <strong>{stats.utilities}</strong>
                <small>utilities</small>
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  const canAddProject = Boolean(selectedPropertyRecord && selectedPropertyRecord.category !== 'account' && selectedPropertyRecord.projects_enabled !== false)
  // Vehicles and accounts carry no utilities, so their subject views offer
  // neither the utility subject form nor the utility-values window.
  const canUseUtilities = Boolean(
    (selectedPropertyRecord
      && selectedPropertyRecord.category !== 'vehicle'
      && selectedPropertyRecord.category !== 'account'
      && selectedPropertyRecord.utilities_enabled !== false),
  )
  const availableAddTabs = ADD_TABS.filter((item) => {
    if (legacyGroup) return false
    if (!selectedSubject) return item.key === 'property' || item.key === 'account'
    if (item.key === 'property' || item.key === 'account') return false
    if (item.key === 'project') return canAddProject
    return canUseUtilities
  })
  const activeAddTab = availableAddTabs.find((item) => item.key === addKind) ?? availableAddTabs[0] ?? ADD_TABS[0]
  const ActiveAddIcon = activeAddTab.icon
  const isAccountSubject = selectedPropertyRecord?.category === 'account'
  const isVehicleSubject = selectedPropertyRecord?.category === 'vehicle'
  const subjectLoans = selectedPropertyRecord && !isAccountSubject
    ? (propertiesQuery.data?.loans ?? []).filter((loan) => loan.linked_property_id === selectedPropertyRecord.id)
    : []

  return (
    <>
      <div className={`page-stack properties-page${selectedPropertyRecord ? ' properties-page--selected' : ''}`}>
        {selectedPropertyRecord ? (
          <>
            {isAccountSubject ? (
              <AccountSummary asset={selectedPropertyRecord} currency={currency} token={token} />
            ) : (
              <PropertySummary
                property={selectedPropertyRecord}
                currency={currency}
                token={token}
                loans={subjectLoans}
                utilities={isVehicleSubject ? false : undefined}
              />
            )}
            {selectedSubject && !isVehicleSubject && !isAccountSubject && selectedPropertyRecord.utilities_enabled !== false ? (
              <SubjectUtilitiesPanel key={selectedKey} subject={selectedSubject} onConfiguration={() => setIsConfigurationOpen(true)} />
            ) : null}
            {isAccountSubject || selectedPropertyRecord.projects_enabled === false ? null : (
              <SectionPanel
                title="Projects"
                actions={projectGantt.slider}
              >
                {visibleProjects.length ? projectGantt.content : (
                  <EmptyState
                    title="No projects for this property"
                    body="Plan a renovation or purchase here — the add menu starts one linked to this property."
                  />
                )}
              </SectionPanel>
            )}
            {isAccountSubject ? (
              <HoldingsPanel key={selectedPropertyRecord.id} asset={selectedPropertyRecord} currency={currency} onSaved={onHoldingsSaved} />
            ) : (
              <PropertyLoans
                loans={subjectLoans}
                currency={currency}
                onOpenLoan={setSelectedLoan}
              />
            )}
          </>
        ) : legacyGroup ? <>
          <p role="status">Legacy unassigned history—requires explicit property resolution. This history is read-only.</p>
          <SubjectUtilitiesPanel key={legacyGroup.id} subject={{ type: 'contract', id: legacyGroup.id }} readOnly />
        </> : (
          <>
            <SectionPanel
              className="property-list-panel"
              title={`${properties.length} ${properties.length === 1 ? 'Property' : 'Properties'}`}
              actions={<span className="property-list-panel__total" aria-label="Properties total value">{fmtMoney(totalValue, currency)}</span>}
            >
              {properties.length ? (
                <div className="property-card-grid">{properties.map((asset) => renderCard(asset, true))}</div>
              ) : (
                <EmptyState
                  title={busy === 'properties' ? 'Loading' : 'No properties yet'}
                  body="Add a property — a home, a flat, a plot — then track its projects and utilities."
                />
              )}
            </SectionPanel>

            <SectionPanel
              className="property-list-panel"
              title={`${vehicles.length} ${vehicles.length === 1 ? 'Vehicle' : 'Vehicles'}`}
              actions={<span className="property-list-panel__total" aria-label="Vehicles total value">{fmtMoney(vehiclesValue, currency)}</span>}
            >
              {vehicles.length ? (
                <div className="property-card-grid">{vehicles.map((asset) => renderCard(asset, true))}</div>
              ) : (
                <EmptyState
                  title="No vehicles yet"
                  body="Add a car or other vehicle to track its value, loan, and running costs."
                />
              )}
            </SectionPanel>

            <SectionPanel
              className="property-list-panel"
              title={`${accounts.length} ${accounts.length === 1 ? 'Account' : 'Accounts'}`}
              actions={<span className="property-list-panel__total" aria-label="Accounts total value">{fmtMoney(accountsValue, currency)}</span>}
            >
              {accounts.length ? (
                <div className="property-card-grid">{accounts.map((asset) => renderCard(asset, true))}</div>
              ) : (
                <EmptyState
                  title="No accounts yet"
                  body="Add a savings account or a brokerage portfolio — including retirement accounts — to track its value and holdings."
                />
              )}
            </SectionPanel>
          </>
        )}
      </div>

      {availableAddTabs.length ? <button className="quick-add-fab property-add-fab" onClick={() => { setCreateForm(emptyCreateForm()); setProjectForm(emptyProjectForm()); setAddKind(availableAddTabs[0]?.key ?? 'property'); setIsAddOpen(true) }} type="button" aria-label="Add asset, utility, or project">
        <Plus className="h-6 w-6" />
      </button> : null}

      {isAddOpen ? (
        <FormSheet
          className="quick-add-modal record-add-modal property-create-modal"
          leading={
            <div className="record-add-icon" aria-hidden="true">
              <ActiveAddIcon className="h-5 w-5" />
            </div>
          }
          eyebrow="Add new"
          title={
            <span className="record-add-kind" ref={kindMenuRef}>
              <button
                aria-expanded={isKindMenuOpen}
                aria-haspopup="listbox"
                className="record-add-kind-toggle"
                onClick={() => setIsKindMenuOpen((value) => !value)}
                type="button"
              >
                {activeAddTab.label}
                <ChevronDown aria-hidden="true" className="h-4 w-4" />
              </button>
              {isKindMenuOpen ? (
                <div
                  aria-label="Add type"
                  className="record-add-kind-menu"
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      event.stopPropagation()
                      setIsKindMenuOpen(false)
                    }
                  }}
                  role="listbox"
                >
                  {availableAddTabs.map((item) => (
                    <button
                      aria-selected={addKind === item.key}
                      className={addKind === item.key ? 'is-active' : ''}
                      key={item.key}
                      onClick={() => {
                        setIsKindMenuOpen(false)
                        if (item.key === 'values' && selectedSubject) {
                          setIsAddOpen(false)
                          setValuesSubject({ ref: selectedSubject, name: selectedPropertyRecord?.name ?? '' })
                        } else if (item.key === 'property' || item.key === 'account') {
                          // The two asset kinds share one form: switching
                          // between them only swaps the Kind selection.
                          setCreateForm((current) => ({
                            ...current,
                            category: item.key === 'account'
                              ? 'account'
                              : current.category === 'account' ? 'property' : current.category,
                          }))
                          setAddKind(item.key)
                        } else setAddKind(item.key)
                      }}
                      role="option"
                      type="button"
                    >
                      <item.icon aria-hidden="true" className="h-4 w-4" />
                      {item.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </span>
          }
          titleId={`${fieldId}-add-title`}
          onClose={() => setIsAddOpen(false)}
        >

            {addKind === 'property' || addKind === 'account' ? (
              <form className="quick-add-form" onSubmit={(event) => { event.preventDefault(); void createProperty() }}>
                <div className="property-create-body">
                <div className="form-grid">
                  <OutlinedNativeSelect
                    id={`${fieldId}-kind`}
                    label="Kind"
                    value={createForm.category}
                    onChange={(event) => setCreateForm({ ...createForm, category: event.target.value as PhysicalAssetCategory })}
                  >
                    <option value="property">Property</option>
                    <option value="vehicle">Vehicle</option>
                    <option value="account">Account</option>
                    <option value="other">Other</option>
                  </OutlinedNativeSelect>
                  {createForm.category === 'account' ? (
                    <>
                      <OutlinedNativeSelect
                        id={`${fieldId}-account-type`}
                        label="Account type"
                        value={createForm.account_type}
                        onChange={(event) => setCreateForm({ ...createForm, account_type: event.target.value as AccountType })}
                      >
                        <option value="savings">Savings</option>
                        <option value="stocks">Stocks</option>
                        <option value="options">Options</option>
                      </OutlinedNativeSelect>
                      <OutlinedNativeSelect
                        id={`${fieldId}-registration`}
                        label="Registration"
                        value={createForm.account_registration}
                        onChange={(event) => setCreateForm({ ...createForm, account_registration: event.target.value as AccountRegistration })}
                      >
                        <option value="regular">Regular</option>
                        <option value="retirement">Retirement</option>
                      </OutlinedNativeSelect>
                    </>
                  ) : null}
                  <OutlinedInput id={`${fieldId}-name`} label="Name" leadingIcon={<Pencil aria-hidden="true" className="h-4 w-4" />} value={createForm.name} onChange={(event) => setCreateForm({ ...createForm, name: event.target.value })} />
                  <OutlinedInput id={`${fieldId}-value`} label="Value" leadingIcon={<Calendar aria-hidden="true" className="h-4 w-4" />} type="number" step="0.01" inputMode="decimal" value={createForm.value} onChange={(event) => setCreateForm({ ...createForm, value: event.target.value })} />
                  <OutlinedInput id={`${fieldId}-valuation`} label="Valuation" leadingIcon={<Calendar aria-hidden="true" className="h-4 w-4" />} type="date" value={createForm.valuation_date} onChange={(event) => setCreateForm({ ...createForm, valuation_date: event.target.value })} />
                  <div className="field-pair">
                    <OutlinedInput id={`${fieldId}-from`} label="From" leadingIcon={<Calendar aria-hidden="true" className="h-4 w-4" />} type="date" value={createForm.started_on} onChange={(event) => setCreateForm({ ...createForm, started_on: event.target.value })} />
                    <OutlinedInput id={`${fieldId}-to`} label="To" leadingIcon={<Calendar aria-hidden="true" className="h-4 w-4" />} type="date" value={createForm.ended_on} onChange={(event) => setCreateForm({ ...createForm, ended_on: event.target.value })} />
                  </div>
                  <OutlinedTextarea id={`${fieldId}-notes`} label="Notes" className="quick-add-notes" leadingIcon={<StickyNote aria-hidden="true" className="h-4 w-4" />} value={createForm.notes} onChange={(event) => setCreateForm({ ...createForm, notes: event.target.value })} />
                </div>
                </div>
                <div className="quick-add-actions">
                  <Button
                    busy={busy === 'property-save'}
                    busyLabel={<><Save className="h-4 w-4" /><span>Saving...</span></>}
                    type="submit"
                  >
                    <Save className="h-4 w-4" />
                    <span>Save</span>
                  </Button>
                </div>
              </form>
            ) : (
              <form className="quick-add-form" onSubmit={(event) => { event.preventDefault(); void createProject() }}>
                <div className="property-create-body">
                <div className="form-grid">
                  <OutlinedInput id={`${fieldId}-project-name`} label="Name" leadingIcon={<Pencil aria-hidden="true" className="h-4 w-4" />} placeholder="Name" value={projectForm.name} onChange={(event) => setProjectForm({ ...projectForm, name: event.target.value })} />
                  <OutlinedInput
                    id={`${fieldId}-project-total`}
                    label="Total"
                    leadingIcon={<Hammer aria-hidden="true" className="h-4 w-4" />}
                    trailing={currencySymbol(currency)}
                    autoComplete="off"
                    inputMode="decimal"
                    placeholder="Total"
                    value={formatAmountDraft(projectForm.total_cost)}
                    onChange={(event) => setProjectForm({ ...projectForm, total_cost: parseAmountDraft(event.target.value) })}
                  />
                  <div className="field-pair">
                    <OutlinedInput id={`${fieldId}-project-start`} label="Start" leadingIcon={<Calendar aria-hidden="true" className="h-4 w-4" />} type="date" value={projectForm.started_on} onChange={(event) => setProjectForm({ ...projectForm, started_on: event.target.value })} />
                    <OutlinedInput id={`${fieldId}-project-end`} label="End" leadingIcon={<Calendar aria-hidden="true" className="h-4 w-4" />} type="date" value={projectForm.ended_on} onChange={(event) => setProjectForm({ ...projectForm, ended_on: event.target.value })} />
                  </div>
                  <OutlinedTextarea id={`${fieldId}-project-notes`} label="Notes" className="quick-add-notes" leadingIcon={<StickyNote aria-hidden="true" className="h-4 w-4" />} placeholder="Notes" value={projectForm.notes} onChange={(event) => setProjectForm({ ...projectForm, notes: event.target.value })} />
                </div>
                {selectedPropertyRecord && selectedPropertyRecord.projects_enabled !== false ? (
                  <p className="utility-move-hint">
                    Links to <strong>{selectedPropertyRecord.name}</strong> — start it here or pick another property later.
                  </p>
                ) : null}
                </div>
                <div className="quick-add-actions">
                  <Button
                    busy={busy === 'property-save'}
                    busyLabel={<><Save className="h-4 w-4" /><span>Saving...</span></>}
                    type="submit"
                  >
                    <Save className="h-4 w-4" />
                    <span>Save</span>
                  </Button>
                </div>
              </form>
            )}
        </FormSheet>
      ) : null}

      {accountEditForm && isAccountSubject && selectedPropertyRecord ? (
        <FormSheet
          className="quick-add-modal account-edit-modal"
          eyebrow="Account"
          title={selectedPropertyRecord.name}
          titleId={`${fieldId}-account-edit-title`}
          onClose={() => setAccountEditForm(null)}
        >
          <form
            className="quick-add-form"
            onSubmit={(event) => {
              event.preventDefault()
              void saveAccountEdit()
            }}
          >
            <div className="property-create-body">
              <div className="form-grid">
                <OutlinedInput id={`${fieldId}-account-name`} label="Name" leadingIcon={<Pencil aria-hidden="true" className="h-4 w-4" />} value={accountEditForm.name} onChange={(event) => setAccountEditForm({ ...accountEditForm, name: event.target.value })} />
                <OutlinedNativeSelect
                  id={`${fieldId}-account-type`}
                  label="Account type"
                  value={accountEditForm.account_type}
                  onChange={(event) => setAccountEditForm({ ...accountEditForm, account_type: event.target.value as AccountType })}
                >
                  <option value="savings">Savings</option>
                  <option value="stocks">Stocks</option>
                  <option value="options">Options</option>
                </OutlinedNativeSelect>
                <OutlinedNativeSelect
                  id={`${fieldId}-account-registration`}
                  label="Registration"
                  value={accountEditForm.account_registration}
                  onChange={(event) => setAccountEditForm({ ...accountEditForm, account_registration: event.target.value as AccountRegistration })}
                >
                  <option value="regular">Regular</option>
                  <option value="retirement">Retirement</option>
                </OutlinedNativeSelect>
                <OutlinedInput
                  id={`${fieldId}-account-value`}
                  label="Value"
                  leadingIcon={<Calendar aria-hidden="true" className="h-4 w-4" />}
                  trailing={currencySymbol(currency)}
                  autoComplete="off"
                  inputMode="decimal"
                  value={formatAmountDraft(accountEditForm.value)}
                  onChange={(event) => setAccountEditForm({ ...accountEditForm, value: parseAmountDraft(event.target.value) })}
                />
                <OutlinedInput id={`${fieldId}-account-start`} label="Opened" type="date" value={accountEditForm.started_on} onChange={(event) => setAccountEditForm({ ...accountEditForm, started_on: event.target.value })} />
                <OutlinedInput id={`${fieldId}-account-end`} label="Closed" type="date" min={accountEditForm.started_on || undefined} value={accountEditForm.ended_on} onChange={(event) => setAccountEditForm({ ...accountEditForm, ended_on: event.target.value })} />
                <OutlinedInput id={`${fieldId}-account-valuation`} label="Valuation date" leadingIcon={<Calendar aria-hidden="true" className="h-4 w-4" />} type="date" value={accountEditForm.valuation_date} onChange={(event) => setAccountEditForm({ ...accountEditForm, valuation_date: event.target.value })} />
                <OutlinedTextarea id={`${fieldId}-account-notes`} label="Notes" className="quick-add-notes" leadingIcon={<StickyNote aria-hidden="true" className="h-4 w-4" />} value={accountEditForm.notes} onChange={(event) => setAccountEditForm({ ...accountEditForm, notes: event.target.value })} />
              </div>
            </div>
            <div className="quick-add-actions">
              <HoldConfirmButton ariaLabel="Delete account" disabled={busy !== null} onConfirm={() => void deleteAccount()}>
                <Trash2 aria-hidden="true" className="h-4 w-4" />
              </HoldConfirmButton>
              <Button
                busy={busy === 'property-save'}
                disabled={busy === 'account-delete'}
                busyLabel={<><Save className="h-4 w-4" /><span>Saving...</span></>}
                type="submit"
              >
                <Save className="h-4 w-4" />
                <span>Save</span>
              </Button>
            </div>
          </form>
        </FormSheet>
      ) : null}

      {selectedLoan ? (
        <LoanDetailModal
          loan={selectedLoan}
          properties={physicalAssets}
          onClose={() => setSelectedLoan(null)}
          onSaved={(updated) => {
            setSelectedLoan(updated)
            void queryClient.invalidateQueries({ queryKey: ['properties', token] })
          }}
        />
      ) : null}

      {selectedProperty ? (
        <PropertyDetailModal
          key={selectedProperty.id}
          initialMode="edit"
          property={selectedProperty}
          projects={projects}
          categories={categories}
          currency={currency}
          saving={propertyMutations.saving}
          deleting={propertyMutations.deleting}
          utilityCount={utilityCounts[selectedProperty.id]}
          onClose={() => setSelectedProperty(null)}
          onSave={propertyMutations.save}
          onDelete={propertyMutations.deleteProperty}
          onCreateOwnCategory={propertyMutations.createOwnCategory}
          onListValuations={listValuations}
          onAddValuation={addValuation}
          onDeleteValuation={removeValuation}
          onLinkProject={linkProject}
          onUnlinkProject={unlinkProject}
          onListUtilityFields={listUtilityFields}
          onTrackUtilityField={trackUtilityField}
          onUntrackUtilityField={untrackUtilityField}
          onOpenProject={(project) => {
            setSelectedProperty(null)
            setProjectModalMode('view')
            setProjectEditing(project)
          }}
        />
      ) : null}

      {notesOpen && selectedPropertyRecord ? (
        <Modal className="property-notes-popup" title="Notes" onClose={() => setNotesOpen(false)}>
          <p className="property-valuation-popup__date">{selectedPropertyRecord?.notes || 'No notes.'}</p>
        </Modal>
      ) : null}

      {valuesSubject ? (
        <UtilityValuesModal
          subject={valuesSubject.ref}
          subjectName={valuesSubject.name}
          onClose={() => setValuesSubject(null)}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ['utility-board', token] })}
        />
      ) : null}

      {isConfigurationOpen ? <UtilityConfigurationModal subject={selectedSubject} subjectName={selectedPropertyRecord?.name} onClose={() => setIsConfigurationOpen(false)} /> : null}

      {projectEditing ? (
        <ProjectModal
          key={projectEditing.id}
          assets={physicalAssets}
          categoryOptions={categoryOptions}
          currency={currency}
          initialMode={projectModalMode}
          project={projectEditing}
          saving={busy === 'property-save'}
          onClose={() => setProjectEditing(null)}
          onSave={(payload) => saveProject(payload)}
          onAutoSave={(payload) => void autoSaveProject(payload)}
          onLinkAsset={(assetId, sectionPath) => void linkProjectToAsset(assetId, sectionPath)}
        />
      ) : null}
    </>
  )
}
