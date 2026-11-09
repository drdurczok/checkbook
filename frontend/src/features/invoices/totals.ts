import Decimal from 'decimal.js'

type DecimalInput = Decimal.Value | null | undefined

export type InvoiceTotalLine = {
  quantity: DecimalInput
  unit_price: DecimalInput
  vat_rate: string
  currency?: string
}

type InvoiceNetLine = Pick<InvoiceTotalLine, 'quantity' | 'unit_price' | 'currency'>

export type InvoiceConversion = {
  enabled: boolean
  currency: string
  rate: DecimalInput
}

export type InvoiceTotals = {
  net: number
  vat: number
  gross: number
  byRate: Record<string, { net: number; vat: number }>
}

const decimal = (value: DecimalInput) => {
  if (value === null || value === undefined || value === '') return new Decimal(0)
  try {
    return new Decimal(value)
  } catch {
    return new Decimal(0)
  }
}

const money = (value: Decimal) => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)

const vatFraction = (rate: string) => {
  if (rate.trim().toLowerCase() === 'zw') return new Decimal(0)
  return decimal(rate).dividedBy(100)
}

const lineNetDecimal = (line: InvoiceNetLine, conversion: InvoiceConversion) => {
  const factor = conversion.enabled
    && conversion.currency
    && line.currency?.trim() === conversion.currency
    ? decimal(conversion.rate)
    : new Decimal(1)
  return money(decimal(line.quantity).times(decimal(line.unit_price)).times(factor))
}

export const invoiceLineNet = (line: InvoiceNetLine, conversion: InvoiceConversion) => (
  lineNetDecimal(line, conversion).toNumber()
)

export function invoiceTotals(
  lines: InvoiceTotalLine[],
  conversion: InvoiceConversion,
): InvoiceTotals {
  let net = new Decimal(0)
  let vat = new Decimal(0)
  const byRate = new Map<string, { net: Decimal; vat: Decimal }>()

  for (const line of lines) {
    const lineNet = lineNetDecimal(line, conversion)
    const lineVat = money(lineNet.times(vatFraction(line.vat_rate)))
    const bucket = byRate.get(line.vat_rate) ?? { net: new Decimal(0), vat: new Decimal(0) }

    net = net.plus(lineNet)
    vat = vat.plus(lineVat)
    bucket.net = bucket.net.plus(lineNet)
    bucket.vat = bucket.vat.plus(lineVat)
    byRate.set(line.vat_rate, bucket)
  }

  return {
    net: net.toNumber(),
    vat: vat.toNumber(),
    gross: net.plus(vat).toNumber(),
    byRate: Object.fromEntries(
      Array.from(byRate, ([rate, totals]) => [
        rate,
        { net: totals.net.toNumber(), vat: totals.vat.toNumber() },
      ]),
    ),
  }
}
