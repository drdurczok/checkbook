# ML Opportunities

An introspection of where machine learning could improve insights or data quality in
Checkbook, grounded in the data the app already collects (`ledger_entries`,
`categories` + `expense_groups`, `utility_bills`, `planning_*`, import runs). Ordered
roughly by value-to-effort.

## High value, low effort (statistical, no model hosting)

### 1. Auto-categorization of imported expenses
Bulk imports land entries with whatever category the source file carries — or none.
A classifier trained on the household's own history (description text + amount +
day-of-month → category/subcategory) could pre-fill `category_id` on import and flag
low-confidence rows for review. Even a TF-IDF + nearest-neighbour match against
previously categorized descriptions would remove most manual triage. This is the
single biggest data-quality lever: every downstream chart (expense mix by group,
trends, property rollups) is only as good as categorization coverage.

### 2. Anomaly detection on spend
Per category and per group, the monthly series is already computed for the dashboard.
Simple robust statistics (median + MAD, or seasonal decomposition for
utilities) can surface: "Groceries this month is 2.4x your typical month",
"Electricity usage rose 30% against the same season last year". Fits naturally as a
new card on the Overview page or as items in `recent_activity`.

### 3. Recurring-payment discovery
Detect near-periodic entries (same counterparty/description, similar amount, ~monthly
cadence) and suggest promoting them to `recurring_commitments` or planning rules.
Also the inverse: a recurring payment that *stopped* or *changed amount* (price hike
detection on subscriptions).

### 4. Duplicate / near-duplicate entry detection
Imports plus manual entry make duplicates likely (`source_fingerprint` exists but only
catches exact re-imports). Fuzzy matching on (date ±2 days, amount, description
similarity) could flag probable duplicates for one-click merge.

## Medium effort

### 5. Smarter cash-flow and net-worth forecasting
The projection engine is currently rule-based (baseline window average + deltas).
Time-series models (ETS/ARIMA, or gradient-boosted models with calendar features)
could capture seasonality — annual insurance, holiday spending, utility winters —
and produce prediction intervals instead of a single line, making the "Estimate"
toggle honest about uncertainty.

### 6. Group and budget suggestions
With expense groups now first-class: suggest group assignments for ungrouped
categories (embedding similarity between category names, e.g. "Takeaway" → Food),
and suggest realistic per-group budgets from historical spend quantiles rather than
asking the user to invent numbers in planning scenarios.

### 7. Utility usage insights
Meter readings + weather normalization (degree-days from a public API) would separate
"colder month" from "something changed in the house", and can estimate the payoff of
tariff changes. The `utility_meter_readings` chain already stores consecutive readings.

## Higher effort / LLM-assisted

### 8. Receipt and document extraction
Photograph a receipt or paste a bank statement PDF → extracted entries with proposed
category, group, and owner scope. An LLM with structured output (or a small local
vision model, given the privacy posture of household finance data) feeding the
existing bulk-import validation path.

### 9. Natural-language querying
"How much did we spend on the car last winter?" → translated to a filtered query over
ledger entries and rendered with the existing chart components. Feasible as an LLM
tool-use layer over the current API; the RLS/tenancy model already scopes anything
it could read.

### 10. Insight narration
A periodic (monthly) generated summary: notable changes, goal progress, upcoming
planned expenses vs. available cash — essentially turning the dashboard into a short
readable briefing.

## Constraints worth respecting

- **Privacy first**: this is household financial data. Prefer on-device/in-database
  statistics (1–7 need no external service) and make any LLM-backed feature (8–10)
  opt-in with an explicit external-processing disclosure.
- **Small data**: a single household has thousands, not millions, of rows. Classical
  statistics and per-household personalization beat deep models here; avoid anything
  that needs cross-household training unless the deployment model changes.
- **Rust backend**: `linfa`, `smartcore`, or plain SQL window functions cover 1–7
  without adding a Python sidecar; keep model inference inside the existing monolith.
- **Explainability**: every suggestion should show its evidence ("matched 14 similar
  past entries") and be one click to reject — trust in the numbers is the product.
