# UI Consistency Follow-ups

Scope: source review after the shared-input migration. These were findings
only when written; all seven have since been implemented in a follow-up change
(keep-last-saved drafts with Cancel restore, stack-aware dialog Escape via the
shared `useDialogBehavior` hook, Quick Add adopting that hook, token-alpha CSS
normalized to `rgb(var(--token) / alpha)`, compact button sizing split from
variants, an explicit invoice-ledger error state with retry, and inline
confirmations as alerts with Cancel focus). The notes below retain the original
audit wording and file references. Existing layout variants are not considered
defects simply because they differ.

## 1. Project Cancel retains drafts that later autosave (High)

`frontend/src/components/ProjectModal.tsx` switches to view mode on Cancel without
restoring `name`, `category`, `color`, dates, notes, or rooms. View-mode item toggles
subsequently call `onAutoSave(buildPayload(...))` using these same values. Canceled
edits can therefore appear in the view and later be saved with a checkbox change.
Property and income-source editors restore their draft on cancellation.

Proposed later work: separate saved snapshot from edit draft, restore on Cancel,
and use only saved data for view-mode autosave. Regression: edit name/item, Cancel,
then toggle completion; saved payload must exclude canceled edits.

## 2. Nested modal Escape handling is not stack-aware (Medium)

`frontend/src/components/Modal.tsx` adds a document Escape listener per mounted
instance. `IncomeSourceModal.tsx` embeds `InvoiceLedger.tsx`, which opens a portaled
`InvoiceBuilderModal.tsx` while the source modal remains mounted. Both listeners
can close their respective dialogs on the same Escape.

Proposed later work: shared topmost-modal ownership of Escape/focus and inert
background dialogs. Test that Escape closes only the invoice, returning focus to
its launcher in the source editor.

## 3. Quick Add bypasses shared dialog keyboard behavior (Medium)

`frontend/src/components/QuickAddRecordModal.tsx` hand-renders its dialog for the
record-kind title dropdown. It uses scroll locking but lacks the shared Modal's
focus placement/restoration, Tab wrapping, and Escape behavior. The distinct title
is intentional; inconsistent keyboard behavior is not required by that design.

Proposed later work: add a title/header slot to Modal or extract its behavior hook,
then use it here. Cover focus entry, Tab cycle, Escape and launcher restoration.

## 4. Invalid legacy color-alpha syntax loses borders and tints (Medium)

`frontend/src/styles/tokens.css` defines space-separated RGB channels. Many chrome
rules still use `rgba(var(--outline), 0.85)` / `rgba(var(--accent), 0.1)`, producing
invalid mixed-separator values. Examples: invoice cards/status badges in
`frontend/src/styles/features/invoices.css`, and payslip group fills/borders in
`frontend/src/styles/features/income-ledger.css`.

Proposed later work: systematically normalize to `rgb(var(--token) / alpha)` and
check rendered styles for representative cards/status states. This report is based
on syntax inspection, not a full browser audit of every legacy consumer.

## 5. Compact button size overrides semantic variants (Medium)

`frontend/src/components/ui/Button.tsx` exposes separate variant and size props,
but `frontend/src/App.css` groups `.button--compact` with `.button--ghost`. A compact
primary Save therefore gains the same neutral styling as Cancel. Compact danger
also inherits text treatment from the compact rule. Project/property/invoice
header actions rely on these classes.

Proposed later work: dimension-only size rules, color-only variant rules, shared
Button adoption, and a rendered variant-by-size test matrix. Do not standardize
all action placement without considering each editor's workflow.

## 6. Invoice loading errors resemble an empty ledger (Medium)

`frontend/src/components/InvoiceLedger.tsx` uses try/finally with no error state for
its invoice request. A failed load clears loading but leaves an empty array, so
users can see "No invoices yet" and zero totals instead of an error. Shared
`AsyncState.tsx` distinguishes these states elsewhere.

Proposed later work: use feature query state and shared loading/error/empty UI with
retry. Test a rejected request separately from a successful empty result.

## 7. Inline confirmations use modal semantics without modal focus (Low)

Property, income-source, and backup editors contain inline `role="alertdialog"`
panels. They do not receive their own focus boundary/placement, and the enclosing
modal continues trapping focus across unrelated controls.

Proposed later work: choose either a true shared confirmation modal with topmost
focus behavior, or intentional inline confirmation semantics and Cancel focus.
Preserve domain-specific blocking explanations and existing hold confirmations.

## Migration Notes

All text/number/date/month/search/select/textarea JSX controls now use the shared
outlined primitives. Native select option/change behavior is retained through
`OutlinedNativeSelect`; rich source/category selectors retain `OutlinedSelect`.
Binary toggles and file uploads are composed through `Checkbox` / `FileInput`
primitives, not forced into a text-field shell. Their existing visual variations
are preserved pending a separately approved interaction/theme pass.

`frontend/src/components/ui/input-adoption.test.ts` guards against new raw input,
select, or textarea JSX outside the primitive implementations. It does not claim
all button-rendered pickers/radio groups are standardized; those interactions are
outside the current input migration scope.
