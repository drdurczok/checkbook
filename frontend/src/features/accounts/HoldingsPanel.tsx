import { useRef, useState } from 'react'
import { Pencil, Plus, Save, Trash2 } from 'lucide-react'
import { HoldConfirmButton } from '../../components/HoldConfirmButton'
import { EmptyState, SectionPanel } from '../../components/panel'
import { FormSheet } from '../../components/ui/FormSheet'
import { Button } from '../../components/ui/Button'
import { OutlinedInput, OutlinedTextarea } from '../../components/ui/OutlinedField'
import type { AccountHolding, AssetSummary } from '../../contracts/assets'
import { api } from '../../lib/api'
import { currencySymbol, fmtDate, fmtMoney, formatAmountDraft, parseAmountDraft } from '../../lib/format'
import { useSession } from '../../lib/session'
import '../../styles/features/accounts.css'
import { useHoldingPrices } from './queries'
import { HoldingQuote } from './HoldingQuote'
import {
  accountAssetPayload,
  draftFromHolding,
  emptyHoldingDraft,
  hasHoldingErrors,
  holdingPayloadFromDraft,
  holdingProfit,
  investedTickers,
  isClosedHolding,
  normalizeTicker,
  openHoldingsValue,
  splitHoldings,
  totalProfit,
  validateHoldingDraft,
  type HoldingDraft,
  type HoldingDraftErrors,
} from './model'

type HoldingSheet = { mode: 'add' } | { mode: 'edit'; holding: AccountHolding }

/** Holdings of one account asset: a compact table with per-lot realized
 * P/L, plus the add/edit sheet and hold-to-confirm delete. Every mutation
 * resends the complete holdings list through api.updateAsset. */
export function HoldingsPanel({ asset, currency, onSaved }: {
  asset: AssetSummary
  currency: string
  onSaved: (updated: AssetSummary) => void | Promise<void>
}) {
  const { token, setError, setMessage } = useSession()
  const [sheet, setSheet] = useState<HoldingSheet | null>(null)
  const [draft, setDraft] = useState<HoldingDraft>(() => emptyHoldingDraft())
  const [errors, setErrors] = useState<HoldingDraftErrors>({})
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const tableShell = useRef<HTMLDivElement>(null)

  const prices = useHoldingPrices(token, asset)
  const quoteEnabled = investedTickers(asset).length > 0
  const showQuotes = asset.account_type === 'stocks'
  const holdings = asset.holdings ?? []
  const { open, closed } = splitHoldings(holdings)
  const realizedTotal = totalProfit(closed)
  const openTotal = openHoldingsValue(open)

  const openAddSheet = () => {
    setDraft(emptyHoldingDraft())
    setErrors({})
    setSheet({ mode: 'add' })
  }

  const openEditSheet = (holding: AccountHolding) => {
    setDraft(draftFromHolding(holding))
    setErrors({})
    setSheet({ mode: 'edit', holding })
  }

  async function persistHoldings(nextHoldings: Array<AccountHolding | Omit<AccountHolding, 'id'>>, successMessage: string) {
    if (!token || saving.current) {
      return
    }
    saving.current = true
    setBusy(true)
    try {
      const updated = await api.updateAsset(token, asset.id, accountAssetPayload(asset, { holdings: nextHoldings }))
      setSheet(null)
      setMessage(successMessage)
      await onSaved(updated)
      return true
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Holdings save failed.')
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  async function saveDraft() {
    const nextErrors = validateHoldingDraft(draft, asset.account_type)
    setErrors(nextErrors)
    if (hasHoldingErrors(nextErrors)) {
      return
    }
    const payload = holdingPayloadFromDraft(draft, asset.account_type)
    if (sheet?.mode === 'edit') {
      const holdingId = sheet.holding.id
      await persistHoldings(holdings.map((holding) => (holding.id === holdingId ? { ...holding, ...payload } : holding)), 'Holding updated.')
    } else {
      await persistHoldings([...holdings, payload], 'Holding added.')
    }
  }

  async function deleteHolding(holding: AccountHolding) {
    const saved = await persistHoldings(holdings.filter((row) => row.id !== holding.id), 'Holding deleted.')
    if (saved && tableShell.current) tableShell.current.scrollLeft = 0
  }

  return (
    <SectionPanel
      className="holdings-panel"
      title="Holdings"
      actions={
        <div className="holdings-panel__actions">
          <span className="holdings-panel__totals">
            <span aria-label="Open holdings value">Cost basis {fmtMoney(openTotal, currency)}</span>
            <span aria-label="Realized profit and loss">P/L {fmtMoney(realizedTotal, currency)}</span>
          </span>
          <button className="button button--compact button--ghost" disabled={busy} onClick={openAddSheet} type="button">
            <Plus aria-hidden="true" className="h-4 w-4" />
            Add holding
          </button>
        </div>
      }
    >
      {showQuotes ? <div className="holdings-prices-note">
        {!quoteEnabled ? <p>Add a US ticker and quantity to value an invested holding. Legacy holdings without tickers and sold holdings are not priced.</p> : null}
        {quoteEnabled && prices.isPending ? <p role="status">Loading daily closing prices...</p> : null}
        {quoteEnabled && prices.isError ? <p role="alert">Closing prices could not be refreshed. {prices.data ? 'Last successful prices are retained as stale.' : 'Your cost basis is unchanged.'}</p> : null}
        {quoteEnabled ? <Button variant="secondary" size="compact" disabled={prices.isFetching} onClick={() => void prices.refetch()}>{prices.isFetching ? 'Refreshing prices...' : 'Refresh prices'}</Button> : null}
      </div> : null}
      {holdings.length ? (
        <div className="holdings-table-shell" ref={tableShell}>
          <table className="holdings-table">
            <thead>
              <tr>
                <th scope="col">{showQuotes ? 'Ticker' : 'Name'}</th>
                <th scope="col">Qty</th>
                <th scope="col">Cost basis</th>
                <th scope="col">Purchased</th>
                <th scope="col">Sold</th>
                <th scope="col">P/L</th>
                {showQuotes ? <th scope="col">Daily close / market value (USD)</th> : null}
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((holding) => {
                const profit = holdingProfit(holding)
                const name = showQuotes ? holding.ticker || holding.name : holding.name
                return (
                  <tr key={holding.id}>
                    <th scope="row">{name}</th>
                    <td>{holding.quantity != null ? holding.quantity : '—'}</td>
                    <td>{fmtMoney(holding.value, currency)}</td>
                    <td>{holding.purchased_on ? fmtDate(holding.purchased_on) : '—'}</td>
                    <td>{holding.sold_on ? fmtDate(holding.sold_on) : '—'}</td>
                    <td>{profit != null ? fmtMoney(profit, currency) : '—'}</td>
                    {showQuotes ? <td>{isClosedHolding(holding) ? 'Sold - not priced' : !holding.ticker ? 'Manual - no ticker' : prices.isPending && quoteEnabled ? 'Loading...' : <HoldingQuote holding={holding} price={prices.data?.prices.find((price) => price.ticker === normalizeTicker(holding.ticker ?? ''))} failed={prices.isError} />}</td> : null}
                    <td>
                      <div className="holdings-table__actions">
                        <button
                          aria-label={`Edit ${name}`}
                          className="holdings-table__icon-button"
                          disabled={busy}
                          onClick={() => openEditSheet(holding)}
                          title={`Edit ${name}`}
                          type="button"
                        >
                          <Pencil aria-hidden="true" className="h-4 w-4" />
                        </button>
                        <HoldConfirmButton
                          ariaLabel={`Delete ${name}`}
                          disabled={busy}
                          onConfirm={() => void deleteHolding(holding)}
                        >
                          <Trash2 aria-hidden="true" className="h-4 w-4" />
                        </HoldConfirmButton>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          title="No holdings yet"
          body="Track the lots inside this account — fund shares, stock, or options — with their purchase and sale details."
        />
      )}

      {sheet ? (
        <FormSheet
          className="quick-add-modal holdings-sheet"
          eyebrow="Holdings"
          title={sheet.mode === 'add' ? 'Add holding' : showQuotes ? sheet.holding.ticker || sheet.holding.name : sheet.holding.name}
          onClose={() => setSheet(null)}
        >
          <form
            className="quick-add-form"
            onSubmit={(event) => {
              event.preventDefault()
              void saveDraft()
            }}
          >
            <div className="property-create-body">
              <div className="form-grid">
                {!showQuotes ? <OutlinedInput
                  id="holding-name"
                  label="Name"
                  error={errors.name}
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                /> : null}
                {showQuotes ? <OutlinedInput
                  id="holding-ticker"
                  label="US ticker"
                  hint="US stocks/ETFs only, e.g. AAPL or BRK-B. Used as the holding name."
                  error={errors.ticker}
                  autoCapitalize="characters"
                  value={draft.ticker}
                  onChange={(event) => setDraft({ ...draft, ticker: event.target.value })}
                /> : null}
                <OutlinedInput
                  id="holding-quantity"
                  label="Quantity"
                  error={errors.quantity}
                  hint="Optional"
                  inputMode="decimal"
                  value={formatAmountDraft(draft.quantity)}
                  onChange={(event) => setDraft({ ...draft, quantity: parseAmountDraft(event.target.value) })}
                />
                <OutlinedInput
                  id="holding-unit-price"
                  label="Unit price"
                  error={errors.unit_price}
                  hint="Optional"
                  inputMode="decimal"
                  trailing={currencySymbol(currency)}
                  value={formatAmountDraft(draft.unit_price)}
                  onChange={(event) => setDraft({ ...draft, unit_price: parseAmountDraft(event.target.value) })}
                />
                <OutlinedInput
                  id="holding-value"
                  label="Value"
                  error={errors.value}
                  inputMode="decimal"
                  trailing={currencySymbol(currency)}
                  value={formatAmountDraft(draft.value)}
                  onChange={(event) => setDraft({ ...draft, value: parseAmountDraft(event.target.value) })}
                />
                <OutlinedInput
                  id="holding-purchased-on"
                  label="Purchased"
                  type="date"
                  value={draft.purchased_on}
                  onChange={(event) => setDraft({ ...draft, purchased_on: event.target.value })}
                />
                <OutlinedInput
                  id="holding-sold-on"
                  label="Sold"
                  error={errors.sold_on}
                  hint="Optional"
                  type="date"
                  value={draft.sold_on}
                  onChange={(event) => setDraft({ ...draft, sold_on: event.target.value })}
                />
                <OutlinedInput
                  id="holding-sell-value"
                  label="Sell value"
                  error={errors.sell_value}
                  hint="Optional"
                  inputMode="decimal"
                  trailing={currencySymbol(currency)}
                  value={formatAmountDraft(draft.sell_value)}
                  onChange={(event) => setDraft({ ...draft, sell_value: parseAmountDraft(event.target.value) })}
                />
                <OutlinedTextarea
                  id="holding-notes"
                  label="Notes"
                  className="quick-add-notes"
                  value={draft.notes}
                  onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                />
              </div>
            </div>
            <div className="quick-add-actions">
              <Button busy={busy} type="submit">
                <Save aria-hidden="true" className="h-4 w-4" />
                <span>{busy ? 'Saving...' : 'Save'}</span>
              </Button>
            </div>
          </form>
        </FormSheet>
      ) : null}
    </SectionPanel>
  )
}
