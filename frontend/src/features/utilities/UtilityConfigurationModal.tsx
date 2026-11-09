import { useId, useMemo, useState } from 'react'
import Decimal from 'decimal.js'
import { ArrowLeft, ChevronDown, ChevronUp } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FormSheet } from '../../components/ui/FormSheet'
import { DetailActionsMenu } from '../../components/DetailActionsMenu'
import { Button } from '../../components/ui/Button'
import { OutlinedInput, OutlinedNativeSelect } from '../../components/ui/OutlinedField'
import { utilitySeriesColor } from '../../components/charts/shared'
import { UtilityColorPicker } from './UtilityColorPicker'
import { api } from '../../lib/api'
import { useSession } from '../../lib/session'
import type { UtilityContract, UtilityContractConfiguration, UtilityContractPrice } from '../../contracts/utilities'
import type { UtilitySubjectRef } from './queries'
import '../../styles/features/utility-configuration.css'

type Draft = Omit<UtilityContractConfiguration, 'color'> & { color: string; initial_price: string }
const contractColor = (contract: UtilityContract) => contract.color ?? utilitySeriesColor(contract.label) ?? '#1e6fd6'
const newDraft = (date: string): Draft => ({ label: '', tracking_mode: 'actual', unit: '', start_date: date, end_date: null, color: '#1e6fd6', initial_price: '' })
function priceValue(value: string): number {
  let price: Decimal
  try { price = new Decimal(value) } catch { throw new Error('Enter a valid price.') }
  if (!price.isFinite() || price.isNegative() || price.decimalPlaces() > 6) throw new Error('Price must be non-negative with at most six decimal places.')
  return price.toNumber()
}

export function UtilityConfigurationModal({ subject, subjectName, onClose }: {
  subject?: UtilitySubjectRef | null
  subjectName?: string
  onClose: () => void
}) {
  const { token, session } = useSession()
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: session?.household.timezone })
  const queryClient = useQueryClient()
  const id = useId()
  const propertyId = subject?.type === 'property' ? subject.id : null
  const [editing, setEditing] = useState<UtilityContract | 'new' | null>(null)
  const [draft, setDraft] = useState<Draft>(() => newDraft(today))
  const [showRetired, setShowRetired] = useState(true)
  const [reordering, setReordering] = useState(false)
  const [localOrder, setLocalOrder] = useState<string[]>([])
  const [priceEditing, setPriceEditing] = useState<UtilityContractPrice | null>(null)
  const [priceMonth, setPriceMonth] = useState(() => today.slice(0, 7))
  const [price, setPrice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const contracts = useQuery({ queryKey: ['utility-contracts', token, propertyId], queryFn: () => api.listUtilityContracts(token, propertyId!), enabled: Boolean(token && propertyId) })
  const contractId = editing && editing !== 'new' ? editing.id : null
  const prices = useQuery({ queryKey: ['utility-contract-prices', token, contractId], queryFn: () => api.listUtilityContractPrices(token, contractId!), enabled: Boolean(token && contractId) })
  // Local order wins only while it still names exactly the loaded contracts,
  // so a failed move or a refetch falls back to the server's ordering.
  const orderedContracts = useMemo(() => {
    const loaded = contracts.data ?? []
    if (!localOrder.length || localOrder.length !== loaded.length) return loaded
    const byId = new Map(loaded.map((contract) => [contract.id, contract]))
    const ordered = localOrder.map((cid) => byId.get(cid)).filter((contract) => contract !== undefined)
    return ordered.length === loaded.length ? ordered : loaded
  }, [contracts.data, localOrder])
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try {
      await action()
      await Promise.all(['utility-contracts', 'utility-contract-prices', 'utility-board', 'properties', 'overview', 'expenses'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })))
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Utility configuration failed.')
      return false
    } finally { setBusy(false) }
  }
  const moveContract = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (!propertyId || target < 0 || target >= orderedContracts.length) return
    const next = [...orderedContracts]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    const orderedIds = next.map((contract) => contract.id)
    setLocalOrder(orderedIds)
    void run(async () => {
      const saved = await api.reorderUtilityContracts(token, propertyId, orderedIds)
      setLocalOrder(saved.map((contract) => contract.id))
    }).then((ok) => { if (!ok) setLocalOrder([]) })
  }
  const save = () => run(async () => {
    if (!propertyId || !editing) return
    if (!draft.label.trim() || !draft.start_date) throw new Error('Enter a name and start date.')
    if (draft.end_date && draft.end_date < draft.start_date) throw new Error('End date cannot precede start date.')
    const config: UtilityContractConfiguration = { color: draft.color, label: draft.label.trim(), tracking_mode: draft.tracking_mode, unit: draft.tracking_mode === 'usage' || draft.tracking_mode === 'meter' ? draft.unit.trim() : '', start_date: draft.start_date, end_date: draft.end_date || null }
    const saved = editing === 'new'
      ? await api.createUtilityContract(token, { ...config, property_id: propertyId, initial_price: draft.tracking_mode !== 'actual' && draft.initial_price.trim() ? priceValue(draft.initial_price) : null })
      : await api.updateUtilityContract(token, editing.id, config)
    setEditing(saved)
    setDraft({ ...saved, color: contractColor(saved), initial_price: '' })
  })
  const savePrice = () => run(async () => {
    if (!contractId || !priceMonth) return
    const payload = { effective_on: `${priceMonth}-01`, price: priceValue(price) }
    if (priceEditing) await api.updateUtilityContractPrice(token, contractId, priceEditing.id, payload)
    else await api.createUtilityContractPrice(token, contractId, payload)
    setPriceEditing(null)
    setPrice('')
  })

  return <FormSheet className="utility-configuration-modal" title={editing ? editing === 'new' ? 'New utility contract' : draft.label : 'Utility contracts'} eyebrow={subjectName ?? 'Utilities'} titleId={`${id}-title`} onClose={onClose}
    leading={!editing && propertyId ? (
      <DetailActionsMenu
        label="Utility contracts options"
        placement="start"
        actions={[
          { label: 'New utility contract', disabled: busy, onClick: () => { setDraft(newDraft(today)); setEditing('new'); setError('') } },
          { label: reordering ? 'Done reordering' : 'Reorder contracts', disabled: busy || !orderedContracts.length, onClick: () => {
            if (!reordering) setShowRetired(true)
            setReordering((value) => !value)
          } },
        ]}
        toggles={[{ label: 'Show retired contracts', checked: showRetired, onChange: setShowRetired }]}
      />
    ) : undefined}
    actions={editing ? <button type="button" className="record-add-close" aria-label="Back to contracts" disabled={busy} onClick={() => { setEditing(null); setError(''); setPriceEditing(null); setPrice('') }}><ArrowLeft className="h-4 w-4" /></button> : undefined}>
    <div className="utility-configuration">
      {error ? <p role="alert" className="form-error">{error}</p> : null}
      {!propertyId ? <p>Select a property to manage its utility contracts.</p> : editing ? <>
        <form className="utility-configuration__form" onSubmit={(event) => { event.preventDefault(); void save() }}>
          <fieldset className="utility-configuration__fields" disabled={busy}>
            <div className="utility-configuration__name-row">
              <OutlinedInput id={`${id}-name`} label="Name" required value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
              <UtilityColorPicker value={draft.color} onChange={(color) => setDraft({ ...draft, color })} />
            </div>
            <OutlinedNativeSelect id={`${id}-tracking`} label="Tracking" value={draft.tracking_mode} onChange={(event) => setDraft({ ...draft, tracking_mode: event.target.value as Draft['tracking_mode'] })}>
              <option value="actual">Actual bills only</option><option value="fixed">Fixed monthly price</option><option value="usage">Usage and unit price</option><option value="meter">Meter readings and unit price</option>
            </OutlinedNativeSelect>
            {draft.tracking_mode === 'usage' || draft.tracking_mode === 'meter' ? <OutlinedInput id={`${id}-unit`} label="Unit" value={draft.unit} onChange={(event) => setDraft({ ...draft, unit: event.target.value })} /> : null}
            <OutlinedInput id={`${id}-start`} label="Start date" type="date" required value={draft.start_date} onChange={(event) => setDraft({ ...draft, start_date: event.target.value })} />
            <OutlinedInput id={`${id}-end`} label="End date (optional)" type="date" value={draft.end_date ?? ''} onChange={(event) => setDraft({ ...draft, end_date: event.target.value || null })} />
            {editing === 'new' && draft.tracking_mode !== 'actual' ? <OutlinedInput id={`${id}-initial-price`} label={draft.tracking_mode === 'fixed' ? 'Initial monthly price' : 'Initial unit price'} inputMode="decimal" value={draft.initial_price} onChange={(event) => setDraft({ ...draft, initial_price: event.target.value })} /> : null}
          </fieldset>
          <Button type="submit" busy={busy}>Save contract</Button>
        </form>
        {contractId ? <section className="utility-configuration__audit" aria-label="Price history">
          <h3>Price history</h3>
          {prices.isPending ? <p role="status">Loading prices...</p> : prices.isError ? <p role="alert">Unable to load price history.</p> : prices.data?.length ? <ul className="utility-configuration__list">{prices.data.map((item) => <li key={item.id}><button type="button" className="utility-configuration__select" disabled={busy} onClick={() => { setPriceEditing(item); setPriceMonth(item.effective_on.slice(0, 7)); setPrice(String(item.price)) }}><strong>{item.price}</strong><small>Effective from {item.effective_on.slice(0, 7)}</small><span>Edit price</span></button></li>)}</ul> : null}
          <form className="utility-configuration__form" onSubmit={(event) => { event.preventDefault(); void savePrice() }}>
            <fieldset className="utility-configuration__fields" disabled={busy}><OutlinedInput id={`${id}-price-month`} label="Effective month" type="month" required value={priceMonth} onChange={(event) => setPriceMonth(event.target.value)} /><OutlinedInput id={`${id}-price`} label={draft.tracking_mode === 'fixed' ? 'Monthly price' : 'Unit price'} required inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} /></fieldset>
            <Button busy={busy} type="submit">{priceEditing ? 'Save price' : 'Add price'}</Button>
            {priceEditing ? <Button variant="secondary" disabled={busy} onClick={() => { setPriceEditing(null); setPrice('') }}>Cancel price edit</Button> : null}
          </form>
        </section> : null}
      </> : reordering ? (
        contracts.isPending ? <p role="status">Loading contracts...</p> : contracts.isError ? <p role="alert">Unable to load utility contracts.</p> : !orderedContracts.length ? <p>No contracts yet.</p> : <ul className="utility-configuration__list">{orderedContracts.map((contract, index) => (
          <li key={contract.id} className={contract.retired ? 'utility-configuration__item--retired' : undefined}>
            <div className="utility-configuration__summary"><strong><i aria-hidden="true" className="utility-color-dot" style={{ background: utilitySeriesColor(contract.label, contract.color ? { [contract.label]: contract.color } : {}) }} />{contract.label}</strong><small>{contract.start_date} - {contract.end_date ?? 'Ongoing'}{contract.retired ? ' · Retired' : ''}</small></div>
            <div className="utility-configuration__arrows">
              <button type="button" aria-label={`Move ${contract.label} up`} disabled={busy || index === 0} onClick={() => moveContract(index, -1)}><ChevronUp className="h-4 w-4" /></button>
              <button type="button" aria-label={`Move ${contract.label} down`} disabled={busy || index === orderedContracts.length - 1} onClick={() => moveContract(index, 1)}><ChevronDown className="h-4 w-4" /></button>
            </div>
          </li>
        ))}</ul>
      ) : (
        contracts.isPending ? <p role="status">Loading contracts...</p> : contracts.isError ? <p role="alert">Unable to load utility contracts.</p> : !orderedContracts.length ? <p>No contracts yet. Use the options menu to create one.</p> : <ul className="utility-configuration__list">{orderedContracts.filter((contract) => showRetired || !contract.retired).map((contract) => <li key={contract.id} className={contract.retired ? 'utility-configuration__item--retired' : undefined}><button className="utility-configuration__select" type="button" disabled={busy} onClick={() => { setEditing(contract); setDraft({ ...contract, color: contractColor(contract), initial_price: '' }); setError('') }}><strong><i aria-hidden="true" className="utility-color-dot" style={{ background: utilitySeriesColor(contract.label, contract.color ? { [contract.label]: contract.color } : {}) }} />{contract.label}</strong><small>{contract.start_date} - {contract.end_date ?? 'Ongoing'}{contract.retired ? ' · Retired' : ''}</small></button></li>)}</ul>
      )}
    </div>
  </FormSheet>
}
