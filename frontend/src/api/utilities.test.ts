import { afterEach, expect, it, vi } from 'vitest'
import { utilitiesApi } from './utilities'
import { API_BASE } from './http'

afterEach(() => vi.unstubAllGlobals())

it.each([{ propertyId: 'home', query: 'property_id=home' }, { groupId: 'contract', query: 'group_id=contract' }])('persists utility completion for $query', async ({ query, ...subject }) => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
  vi.stubGlobal('fetch', fetchMock)
  const payload = { month: '2026-11', completed: true, entries: [] }
  await utilitiesApi.upsertUtilityEntries('test-token', payload, subject)
  expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/household/utilities/upsert?${query}`, expect.objectContaining({ method: 'POST', body: JSON.stringify(payload) }))
})

it('uses authenticated catalog endpoints for configuration and audit', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
  vi.stubGlobal('fetch', fetchMock)
  const config = { label: 'Water', unit: 'm3', entry_mode: 'usage' as const, unit_rate: 1.25 }
  await utilitiesApi.createUtilityField('test-token', { ...config, kind: 'metered' })
  await utilitiesApi.updateUtilityField('test-token', 'water/main', config)
  await utilitiesApi.listUtilityFieldAudit('test-token', 'water/main')
  expect(fetchMock).toHaveBeenNthCalledWith(1, `${API_BASE}/household/utility-field-catalog`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ ...config, kind: 'metered' }) }))
  expect(fetchMock).toHaveBeenNthCalledWith(2, `${API_BASE}/household/utility-field-catalog/water%2Fmain`, expect.objectContaining({ method: 'PUT', body: JSON.stringify(config) }))
  expect(fetchMock).toHaveBeenNthCalledWith(3, `${API_BASE}/household/utility-field-catalog/water%2Fmain/audit`, expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }))
})

it('persists utility order through the authenticated catalog endpoint', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] })
  vi.stubGlobal('fetch', fetchMock)
  await utilitiesApi.reorderUtilityFields('test-token', { keys: ['water', 'power'] })
  expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/household/utility-field-order`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ keys: ['water', 'power'] }), headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }))
})

it('updates lifecycle and accepts an empty deletion response', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ retired: true, hidden: true }) })
    .mockResolvedValueOnce({ ok: true, status: 204, json: vi.fn().mockRejectedValue(new Error('No content')) })
  vi.stubGlobal('fetch', fetchMock)
  const payload = { retired: true, hidden: true }
  await utilitiesApi.updateUtilityFieldLifecycle('test-token', 'water/main', payload)
  await expect(utilitiesApi.deleteUtilityField('test-token', 'water/main')).resolves.toBeUndefined()
  expect(fetchMock).toHaveBeenNthCalledWith(1, `${API_BASE}/household/utility-field-catalog/water%2Fmain/lifecycle`, expect.objectContaining({ method: 'PATCH', body: JSON.stringify(payload) }))
  expect(fetchMock).toHaveBeenNthCalledWith(2, `${API_BASE}/household/utility-field-catalog/water%2Fmain`, expect.objectContaining({ method: 'DELETE' }))
})

it.each([
  { propertyId: 'home', subjectQuery: 'property_id=home' },
  { groupId: 'contract', subjectQuery: 'group_id=contract' },
])('requests full utility history for $subjectQuery', async ({ subjectQuery, ...subject }) => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
  vi.stubGlobal('fetch', fetchMock)

  await utilitiesApi.getUtilityBoard('test-token', { ...subject, months: 0 })

  expect(fetchMock).toHaveBeenCalledWith(
    `${API_BASE}/household/utilities/board?${subjectQuery}&months=0`,
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }),
  )
})

it.each([
  { months: 12, suffix: '?months=12' },
  { months: undefined, suffix: '' },
])('preserves the utility history window when months is $months', async ({ months, suffix }) => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
  vi.stubGlobal('fetch', fetchMock)

  await utilitiesApi.getUtilityBoard('test-token', { months })

  expect(fetchMock).toHaveBeenCalledWith(
    `${API_BASE}/household/utilities/board${suffix}`,
    expect.any(Object),
  )
})

it('uses property-scoped contracts and month-effective editable price endpoints', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
  vi.stubGlobal('fetch', fetchMock)
  const config = { label: 'Power', tracking_mode: 'usage' as const, unit: 'kWh', start_date: '2026-01-01', end_date: null }
  await utilitiesApi.listUtilityContracts('token', 'home/main')
  await utilitiesApi.createUtilityContract('token', { ...config, property_id: 'home', initial_price: 0.2 })
  await utilitiesApi.updateUtilityContract('token', 'contract/main', config)
  await utilitiesApi.listUtilityContractPrices('token', 'contract/main')
  await utilitiesApi.createUtilityContractPrice('token', 'contract/main', { effective_on: '2026-01-01', price: 0.2 })
  await utilitiesApi.updateUtilityContractPrice('token', 'contract/main', 'price/main', { effective_on: '2026-01-01', price: 0.25 })
  await utilitiesApi.reorderUtilityContracts('token', 'home/main', ['contract/main', 'other'])
  expect(fetchMock).toHaveBeenNthCalledWith(1, `${API_BASE}/household/utilities/contracts?property_id=home%2Fmain`, expect.anything())
  expect(fetchMock).toHaveBeenNthCalledWith(2, `${API_BASE}/household/utilities/contracts`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ ...config, property_id: 'home', initial_price: 0.2 }) }))
  expect(fetchMock).toHaveBeenNthCalledWith(3, `${API_BASE}/household/utilities/contracts/contract%2Fmain`, expect.objectContaining({ method: 'PUT', body: JSON.stringify(config) }))
  expect(fetchMock).toHaveBeenNthCalledWith(4, `${API_BASE}/household/utilities/contracts/contract%2Fmain/prices`, expect.anything())
  expect(fetchMock).toHaveBeenNthCalledWith(5, `${API_BASE}/household/utilities/contracts/contract%2Fmain/prices`, expect.objectContaining({ method: 'POST' }))
  expect(fetchMock).toHaveBeenNthCalledWith(6, `${API_BASE}/household/utilities/contracts/contract%2Fmain/prices/price%2Fmain`, expect.objectContaining({ method: 'PUT', body: JSON.stringify({ effective_on: '2026-01-01', price: 0.25 }) }))
  expect(fetchMock).toHaveBeenNthCalledWith(7, `${API_BASE}/household/utilities/contracts/reorder`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ property_id: 'home/main', ordered_ids: ['contract/main', 'other'] }) }))
})
