export type DateRangeKey = 'month' | '6m' | '12m' | 'ytd' | 'all'

export const DATE_RANGE_OPTIONS: Array<{ key: DateRangeKey; label: string }> = [
  { key: 'month', label: 'Current month' },
  { key: '6m', label: '6 months' },
  { key: '12m', label: '12 months' },
  { key: 'ytd', label: 'YTD' },
  { key: 'all', label: 'All time' },
]

export const todayInputValue = () => new Date().toLocaleDateString('sv-SE')

export const fmtCurrency = (value: number, currency: string) =>
  new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(value)

export const normalizeCurrencyCode = (value?: string | null) => {
  const normalized = String(value || 'PLN').toUpperCase()
  return normalized === 'EURO' ? 'EUR' : normalized
}

/** Grouped digits without the currency, so callers can render the code at a
 * different size (fmtMoney bundles both into one string). */
export const fmtNumber = (value: number, precision = 0) =>
  new Intl.NumberFormat(undefined, {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  }).format(value)

export const fmtMoney = (value: number, currency: string, precision = 0) => {
  const code = normalizeCurrencyCode(currency)
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    }).format(value)
  } catch {
    return `${value.toFixed(precision)} ${code}`
  }
}

export const fmtDate = (value?: string | null) =>
  value ? new Date(value).toLocaleDateString() : 'Not set'

export const fmtLoanDate = (value?: string | null) => {
  const text = String(value ?? '').trim()
  const isoDate = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (isoDate) {
    return new Date(`${isoDate[1]}-${isoDate[2]}-${isoDate[3]}T00:00:00`).toLocaleDateString()
  }
  const polishDate = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)
  if (polishDate) {
    return new Date(
      Number(polishDate[3]),
      Number(polishDate[2]) - 1,
      Number(polishDate[1]),
    ).toLocaleDateString()
  }
  const googleExportDate = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (googleExportDate) {
    return new Date(
      Number(googleExportDate[3]),
      Number(googleExportDate[1]) - 1,
      Number(googleExportDate[2]),
    ).toLocaleDateString()
  }
  const monthYear = text.match(/^(\d{1,2})[./](\d{4})$/)
  if (monthYear) {
    return `${monthYear[2]}-${monthYear[1].padStart(2, '0')}`
  }
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) {
    return ''
  }
  return parsed.toLocaleDateString()
}

export const fmtMonth = (value: string) => {
  const [year, month] = value.split('-').map(Number)
  if (!year || !month) {
    return value
  }
  return `${year}-${String(month).padStart(2, '0')}`
}

export const numericAmount = (value: unknown) => {
  if (typeof value === 'number') {
    return value
  }
  const normalized = String(value ?? '')
    .replace(/\s/g, '')
    .replace(',', '.')
    .replace(/[^0-9.-]/g, '')
  const amount = Number(normalized)
  return Number.isFinite(amount) ? amount : 0
}

/** Canonical amount-draft grouping: unambiguous in every locale because the
    parser never treats it as a decimal separator. */
const amountGroupSeparator = '\u2009'

/** Normalizes typed text into a plain numeric draft (`digits` + optional `.` decimals). */
export const parseAmountDraft = (value: string): string => {
  const cleaned = value.replace(/[^\d.,]/g, '').replaceAll(',', '.')
  const [integerPart = '', ...decimalParts] = cleaned.split('.')
  const decimals = decimalParts.join('')
  const integer = integerPart || (decimals ? '0' : '')
  if (decimalParts.length > 0) {
    return integer || decimals ? `${integer}.${decimals}` : ''
  }
  return integer
}

/** Renders a numeric draft with thin-space grouping while the user is still typing. */
export const formatAmountDraft = (raw: string): string => {
  const trimmed = raw.trim()
  if (!trimmed) {
    return ''
  }
  const [integerPart = '', ...decimalParts] = trimmed.split('.')
  const grouped = (integerPart || '0').replace(
    /\B(?=(\d{3})+(?!\d))/g,
    amountGroupSeparator,
  )
  if (decimalParts.length > 0) {
    return `${grouped}.${decimalParts.join('')}`
  }
  return grouped
}

export const currencySymbol = (value?: string | null): string => {
  const code = normalizeCurrencyCode(value)
  try {
    const parts = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 0,
    }).formatToParts(0)
    return parts.find((part) => part.type === 'currency')?.value ?? code
  } catch {
    return code
  }
}

export const isoDate = (value: Date) => {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export const addMonths = (value: Date, delta: number) =>
  new Date(value.getFullYear(), value.getMonth() + delta, 1)

export const resolveDateRange = (range: DateRangeKey, forecast = false): {
  start_date?: string
  end_date?: string
  include_planned?: boolean
} => {
  const today = new Date()
  if (range === 'all') {
    return forecast ? { include_planned: true } : { end_date: isoDate(today) }
  }
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
  const start =
    range === 'month'
      ? monthStart
      : range === 'ytd'
      ? new Date(today.getFullYear(), 0, 1)
      : addMonths(monthStart, range === '6m' ? -5 : -11)
  const forecastEnd = range === 'ytd'
    ? new Date(today.getFullYear(), 11, 31)
    : new Date(today.getFullYear(), today.getMonth() + (range === 'month' ? 1 : range === '6m' ? 7 : 13), 0)
  return {
    start_date: isoDate(start),
    end_date: isoDate(forecast ? forecastEnd : today),
    ...(forecast ? { include_planned: true } : {}),
  }
}

export const rangeLabel = (range: DateRangeKey, forecast = false) => {
  const resolved = resolveDateRange(range, forecast)
  if (!resolved.start_date) {
    return forecast ? 'All available records, including future dates' : `All records through ${fmtDate(resolved.end_date)}`
  }
  return `${fmtDate(resolved.start_date)} - ${fmtDate(resolved.end_date)}`
}

/** Short picker label for a range, e.g. "12 months"; falls back to resolved dates. */
export const dateRangeOptionLabel = (range: DateRangeKey) =>
  DATE_RANGE_OPTIONS.find((option) => option.key === range)?.label ?? rangeLabel(range)

export const fmtFileSize = (value?: string) => {
    const size = Number(value)
  if (!Number.isFinite(size) || size <= 0) {
    return ''
  }
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${Math.max(1, Math.round(size / 1024))} KB`
}

const moneyColumn = (columnKey: string) =>
  columnKey.includes('amount') ||
  columnKey.includes('balance') ||
  columnKey.includes('payment')

const dateColumn = (columnKey: string) =>
  columnKey.includes('date') || columnKey === 'as_of_date'

const timestampColumn = (columnKey: string) => columnKey.endsWith('_at')

const labelColumn = (columnKey: string) =>
  ['asset_type', 'liability_type', 'owner_scope', 'data_source', 'status', 'entity_kind'].includes(columnKey)

export const friendlyText = (value: string) =>
  value
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())

const formatPayload = (value: Record<string, unknown>) => {
  const parts = Object.entries(value)
    .filter(([, nextValue]) => nextValue !== null && nextValue !== undefined && nextValue !== '')
    .slice(0, 12)
    .map(([key, nextValue]) => {
      const displayValue =
        typeof nextValue === 'object' && nextValue !== null
          ? JSON.stringify(nextValue)
          : String(nextValue)
      return `${key}: ${displayValue}`
    })
  return parts.length ? parts.join(' | ') : '-'
}

export const formatRawValue = (columnKey: string, value: unknown, currency: string) => {
  if (value === null || value === undefined || value === '') {
    return '-'
  }
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No'
  }
  if (moneyColumn(columnKey)) {
    const numeric = numericAmount(value)
    if (Number.isFinite(numeric)) {
      return fmtCurrency(numeric, currency)
    }
  }
  if (columnKey.includes('interest_rate')) {
    const raw = numericAmount(value)
    const numeric = raw > 0 && raw < 1 ? raw * 100 : raw
    if (Number.isFinite(numeric)) {
      return `${numeric.toFixed(2)}%`
    }
  }
  if (typeof value === 'string' && timestampColumn(columnKey)) {
    const parsedDate = new Date(value)
    if (Number.isNaN(parsedDate.getTime())) {
      return value
    }
    return parsedDate.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
  }
  if (typeof value === 'string' && dateColumn(columnKey)) {
    const parsedDate = new Date(`${value}T00:00:00`)
    if (Number.isNaN(parsedDate.getTime())) {
      return value
    }
    return parsedDate.toLocaleDateString(undefined, {
      dateStyle: 'medium',
    })
  }
  if (typeof value === 'object') {
    return formatPayload(value as Record<string, unknown>)
  }
  if (typeof value === 'string') {
    return labelColumn(columnKey) ? friendlyText(value) : value
  }
  return String(value)
}
