# Checkbook — Business Overview

## Elevator pitch

Checkbook is a private, self-hosted household finance system that replaces the sprawling personal spreadsheet most families eventually outgrow — giving couples and families one place to see net worth, income, taxes, mortgages, renovations, and utility costs together, without handing their financial data to a third-party fintech app.

## Short description

Checkbook is a household finance web application for tracking income, expenses, assets, properties, loans, utilities, and renovation projects in one connected system. It's built for people who currently manage their finances in a large, hand-maintained spreadsheet and want the same level of detail and control — multiple income sources with full payslip breakdowns, per-property value history, room-by-room renovation budgets, utility meter tracking — but with structured data, real-time dashboards, and no formula-breakage risk.

## Long description

Most personal finance apps optimize for a single use case: budgeting, or net-worth tracking, or bill splitting. Households with more complex financial lives — multiple jobs and business income streams, a mortgage plus a car loan plus smaller installment debts, an ongoing home renovation, several tracked properties and vehicles, and recurring utility bills across multiple services — tend to abandon these apps and fall back to a giant, fragile Excel/Google Sheets workbook with years of manually-entered history, custom formulas, and cross-referenced tabs.

Checkbook is designed to be the structured, queryable replacement for that workbook. It models a household as a set of **income sources** (jobs, contracts, business/freelance gigs), **properties and assets** (real estate, vehicles) with value-history tracking and depreciation/appreciation projections, **loans and mortgages** with full amortization schedules, **utilities** (metered and flat-cost services) with bill and meter-reading history, **renovation/improvement projects** organized by room and section, and a unified **planning** view that forecasts future cash flow from all of the above. Every entry — a payslip, a utility bill, a mortgage payment — is owned by a specific household member or held jointly, so shared and individual finances stay distinguishable inside one shared ledger.

Because it's self-hosted (Docker Compose, PostgreSQL, no external financial data broker), the household's financial history never leaves infrastructure the household controls. The application also includes an invoicing module (with NIP/tax-ID-aware buyer and seller records and Typst-rendered PDF output), reflecting that at least one target user runs freelance/contractor income alongside employment income and needs to issue their own invoices.

### Problem statement

- Spreadsheet-based household finance tracking doesn't scale: formulas break, historical data becomes hard to audit, and there's no real dashboard, just static cells.
- Consumer budgeting apps (Mint-style) are built around bank-feed aggregation and category budgets; they don't model property value history, renovation projects, multi-job payslip detail, or loan amortization in the depth a spreadsheet power-user expects.
- Multi-job / multi-currency / contractor-plus-employment households (common for tech workers on B2B or SII/UoP-style contracts in markets like Poland) need per-source income tracking with full payslip breakdown (gross, social insurance, health insurance, tax advance, PPK/retirement contribution, net) — most apps only track a lump "paycheck" amount.
- Sensitive lifetime financial history (a decade-plus of payslips, mortgage payments, and account balances) shouldn't have to live in a third-party cloud service with an opaque data-retention and monetization policy.

### Current gaps / known limitations

- Single-tenant-per-deployment self-hosting model: no multi-household SaaS offering, no billing/subscription layer — a household runs and maintains its own instance.
- Payslip modeling (gross/social/health/tax-advance/PPK breakdown) is tailored to Polish payroll structure; other tax jurisdictions would need adapted fields.
- Currency handling defaults to a single household currency (PLN in the reference deployment); genuinely mixed-currency net worth is not a first-class feature.
- No mobile app — the frontend is a responsive web app, not a native client.
- No bank-feed/Open Banking integration; all data entry is manual or via bulk JSON import (with a companion Excel-to-JSON conversion script for migrating existing spreadsheets).

## Target audience

- **Households/couples with complex finances** who currently track everything in a large personal spreadsheet and want a structured, dashboard-driven replacement without losing detail.
- **Multi-income earners** — people with a primary job plus side contracts, freelance/business income, or a spouse's separate income who need per-source tracking and correct (not naively inflated) annualized-income reporting.
- **Homeowners mid-renovation or managing multiple properties/vehicles** who want to track room-by-room project budgets, contractor items, and asset value history (including manually-recorded valuations that produce a real appreciation/depreciation curve, not just a flat assumed rate).
- **Privacy-conscious, technically capable users** willing to self-host (Docker Compose + PostgreSQL) in exchange for full data ownership — likely software engineers or technically adjacent professionals, matching the household this instance was built for.
- **Freelancers/contractors** who need lightweight invoicing (buyer/seller records, NIP tax IDs, PDF generation) alongside their personal finance tracking.

## Key features

- **Overview dashboard** — household net worth, gross/net income per year, estimated tax position, and a consolidated financial snapshot across every module.
- **Planning** — forward-looking cash-flow projection combining income, recurring expenses, loan payments, and utility costs, with statistical outlier trimming so one unusual month doesn't skew the forecast.
- **Income tracking**
  - Multiple income sources per person (employment, business, rental, investment, benefit, other), each with its own tenure (start/end date), employer/organization, and category.
  - Full Polish-style payslip breakdown per entry: base pay, taxable/non-taxable additions and deductions, gross pay, social insurance, health insurance, PPK contribution, tax advance withheld, net payable.
  - Duration-aware annualized income reporting — a short-tenure contract shows its actual total earned rather than a misleadingly extrapolated "run rate."
  - Income milestones (raises, promotions) plotted on a tenure timeline.
- **Properties & assets**
  - Per-property value history with multiple dated valuation points, rendered as a multi-segment appreciation/depreciation chart (each segment uses its own implied monthly rate between known value points).
  - Feature toggles per property (utilities, linked projects, linked expenses) so the detail view only shows what's relevant to that property.
  - Linking properties to renovation projects and tracked utility services.
- **Renovation/improvement projects** — organized by room and section, with individual line items, budgets, and progress tracking.
- **Utilities** — tracked per service (metered: electricity/water/gas with meter readings; flat-cost: internet/subscriptions), with full bill history and catalog-grouped service linking to properties.
- **Loans & mortgages** — full amortization schedules (principal, interest, remaining balance per payment) for mortgages, auto loans, and smaller installment debts.
- **Accounts & net worth** — balance-snapshot history per financial account, rolled into the household net-worth figure.
- **Invoicing** — buyer/seller records (with NIP tax IDs), reusable templates, and Typst-rendered PDF invoice generation for freelance/contractor billing.
- **Bulk import** — JSON-based bulk data import for migrating existing records. Convert source spreadsheets outside the repository and validate the resulting payload before importing; household-specific converters and private source documents are not distributed.
- **Multi-user households with ownership scopes** — every entry is tagged self-owned, spouse-owned, or joint, so individual and shared finances coexist in one household ledger without being conflated.
- **Authentication & isolation** — Cloudflare Access JWT or Google ID-token sign-in, hashed opaque application sessions, and PostgreSQL row-level security enforcing household data isolation.

## Technology overview

- **Frontend**: React 19 + TypeScript + Vite — a single-page application covering Overview, Planning, Income, Properties, Projects, Utilities, Imports, and Settings.
- **Backend**: Rust (1.96) modular monolith on Axum/Tokio, organized as a Cargo workspace:
  - `checkbook-domain` — pure financial calculations (compounding/depreciation, loan math, statistical trimming for forecasts) and core value types.
  - `checkbook-application` — permissions and application-level policy.
  - `checkbook-postgres` — migrations, tenant-scoped transactions, and persistence.
  - `checkbook-documents` — Typst-based invoice PDF rendering with bundled fonts.
  - `checkbook-api` — the public REST API and private data-load API.
  - `checkbook` — CLI and server process (`migrate`, `bootstrap-database`, `serve`, `seed-development`).
- **Database**: PostgreSQL 18 only, via SQLx with compile-time-checked (offline) queries; `rust_decimal`/`NUMERIC` used throughout for financial values to avoid floating-point drift.
- **Deployment**: Docker Compose (local and production overlays); migrations run as a one-shot deployment job, `serve` never performs schema changes at runtime.
- **Security**: Cloudflare Access or Google ID-token authentication, hashed opaque sessions, PostgreSQL row-level security for per-household isolation, and a restricted `checkbook_app` database role separate from the migration-owning admin role.
- **No** Python, SQLite, Redis, TimescaleDB, SQLAlchemy, Alembic, or runtime schema repair — a deliberately narrow, boring, auditable stack.

## Differentiation

| | Consumer budgeting apps (Mint-style) | Personal spreadsheet | Checkbook |
|---|---|---|---|
| Multi-source payslip detail | No | Manual, fragile | Structured, per-entry |
| Property value history & depreciation curves | No | Manual formulas | Built-in, multi-segment |
| Renovation project budgets | No | Ad hoc tabs | First-class model (rooms/sections/items) |
| Loan amortization | Sometimes | Manual formulas | Built-in schedules |
| Data ownership | Vendor-hosted | Local file, no dashboard | Self-hosted, dashboarded |
| Multi-person household ownership scopes | Limited | Manual | Built-in (self/spouse/joint) |
| Freelance invoicing | No | Separate tool | Built-in |
