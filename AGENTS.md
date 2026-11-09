# Checkbook Repository Guide

This file defines the default operating rules for automated coding agents and
human contributors working in this repository. It applies to the entire tree.
If a more specific `AGENTS.md` is added below a directory, the nearest file
takes precedence for that subtree.

The goal is reliable, reviewable delivery. Prefer a narrow complete change with
the right tests over a broad rewrite. Preserve repository invariants even when a
shortcut appears to make an individual task easier.

## First Principles

- Read the relevant implementation, tests, manifests, and configuration before
  editing. Do not infer the architecture from filenames alone.
- Inspect `git status --short` before changing files. The worktree may contain
  user changes; never discard, overwrite, or reformat unrelated work.
- Keep changes within the layer that owns the behavior. Do not bypass an
  existing domain, authorization, persistence, API, query, or UI abstraction.
- Fix root causes. Do not weaken lints, tests, RLS, authentication, contract
  checks, audit policy, or type safety to make a check pass.
- Add or update focused tests for behavior changes. A compile-only check is not
  enough for financial calculations, authorization, persistence, or API work.
- Run the smallest useful checks while iterating, then the change-appropriate
  final checks listed below.
- Report commands actually run and any checks that could not run. PostgreSQL
  integration tests skip when their environment variables are absent, so a
  green test process does not by itself prove they executed.
- Do not deploy, rotate credentials, mutate production data, or run destructive
  database operations unless the task explicitly requires it.

## System Overview

Checkbook is a household-finance application implemented as a Rust modular
monolith with a React frontend:

- Rust 1.96, edition 2024, Axum, Tokio, and SQLx.
- PostgreSQL 18 is the only runtime database.
- React 19, TypeScript, Vite, TanStack Query, and plain/Tailwind-backed CSS.
- Financial values use `rust_decimal` and PostgreSQL `NUMERIC`.
- Invoices are rendered by Typst with bundled Noto Sans fonts.
- Cloudflare Access, Google ID tokens, or isolated development authentication
  establish application sessions.
- PostgreSQL row-level security (RLS) is the final household-isolation boundary.

There is intentionally no Python runtime, SQLite, Redis, TimescaleDB, runtime
schema repair, or migration-on-server-start behavior. The CI guard
`infrastructure/scripts/check-no-python-runtime.sh` enforces part of this.

## Repository Map

| Path | Responsibility |
| --- | --- |
| `crates/checkbook-domain` | Domain values, finance calculations, planning algorithms, household time handling |
| `crates/checkbook-application` | Application policy, permissions, access context, clocks, application errors |
| `crates/checkbook-postgres` | Migrations, tenant transactions, persistence, imports, backups, maintenance |
| `crates/checkbook-documents` | Typst invoice templates, bundled fonts, PDF rendering |
| `crates/checkbook-api` | Axum routes, auth boundaries, DTOs, OpenAPI, HTTP error mapping |
| `crates/checkbook` | CLI, process configuration, listeners, startup and shutdown |
| `frontend/src/api` | Domain-specific HTTP clients |
| `frontend/src/contracts` | API transport types grouped by domain |
| `frontend/src/features` | Feature query hooks, mutations, models, and complex feature UI |
| `frontend/src/components` | Reusable visual and interaction components |
| `frontend/src/components/ui` | Small shared UI primitives |
| `frontend/src/pages` | Route-level composition |
| `frontend/src/styles` | Design tokens, shared primitives, and feature styles |
| `tests/contract` | Reviewed cross-layer API snapshots |
| `.sqlx` | Committed SQLx query metadata used by offline builds |
| `infrastructure` | Container images, host setup, deployment and policy scripts |
| `.gitlab-ci.yml` | Authoritative CI commands and deployment flow |

## Dependency Direction

Keep internal dependencies flowing in this direction:

```text
checkbook-domain
       ^
checkbook-application
       ^
checkbook-postgres      checkbook-documents
       ^                      ^
       +------ checkbook-api -+
                    ^
               checkbook CLI
```

More concretely:

- Domain code must not depend on Axum, SQLx, PostgreSQL, environment variables,
  or frontend transport shapes.
- Application policy may depend on domain types, but not on HTTP or concrete
  persistence details.
- PostgreSQL code implements storage and tenant transaction behavior. It must
  not own HTTP response policy.
- Documents may consume validated domain values but must not reach into API or
  database concerns.
- API code translates HTTP/auth/DTO concerns into application and persistence
  calls. Keep business calculations out of route handlers.
- The binary owns process configuration and orchestration. Keep endpoint logic
  in `checkbook-api` and database logic in `checkbook-postgres`.

When adding behavior, place pure calculations and invariants in the domain,
permissions in application policy, SQL in PostgreSQL modules, transport mapping
in API modules, and only process wiring in the CLI.

## Toolchain and Prerequisites

Use the pinned versions where the repository specifies them:

- Rust `1.96.0` with `rustfmt` and `clippy` from `rust-toolchain.toml`.
- Node.js 22, matching CI.
- npm with `frontend/package-lock.json`; use `npm ci`, not an unreviewed lockfile
  rewrite.
- Docker with Compose v2 for the standard local stack.
- PostgreSQL 18 for direct database development and integration tests.
- `cargo-sqlx` 0.8.6 when regenerating SQLx metadata.
- `cargo-audit` and `cargo-deny` for dependency/security verification.

Useful repository aliases are:

```sh
cargo check-all
cargo clippy-all
```

## Local Development

### Full stack with Compose

The most reproducible local environment is:

```sh
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
```

Default host ports are frontend `13009`, development-auth API `18000`, and
PostgreSQL `25432`. The stack migrates the schema, bootstraps the restricted
`checkbook_app` role, seeds development data, and then starts the application.

Stop it without deleting data using:

```sh
docker compose -f docker-compose.yml -f docker-compose.local.yml down
```

Do not add `-v` unless destroying the local PostgreSQL volume is intentional.

### Direct backend work

Start PostgreSQL, migrate as the administrative role, bootstrap the application
role, and then serve as the restricted role:

```sh
docker compose up -d postgres

export ADMIN_DATABASE_URL=postgresql://checkbook_admin:checkbook@localhost:25432/checkbook
export DATABASE_URL="$ADMIN_DATABASE_URL"
cargo run --bin checkbook -- migrate

export DB_APP_PASSWORD=checkbook-app
cargo run --bin checkbook -- bootstrap-database

export DATABASE_URL=postgresql://checkbook_app:checkbook-app@localhost:25432/checkbook
export DEV_AUTH_ENABLED=true
export LISTEN_ADDRESS=127.0.0.1:8001
export DEV_AUTH_LISTEN_ADDRESS=127.0.0.1:8000
cargo run --bin checkbook -- serve
```

`serve` must never run migrations or repair schema. Migration and application
role bootstrap are explicit one-shot deployment steps.

### Direct frontend work

With the development-auth listener available on `127.0.0.1:8000`:

```sh
cd frontend
npm ci
npm run dev
```

Vite serves on `http://localhost:5173` and proxies `/api` and `/health` to port
`8000`. Use `VITE_API_BASE_URL` only when a non-proxied API base is required.
`VITE_ENABLE_DEV_AUTH` is a build-time flag and must be false in production.
When a production build runs with it set to `true`, the post-build step
`frontend/scripts/apply-dev-branding.mjs` replaces the built favicon and PWA app
icons with the amber dev variant from `frontend/brand/dev` (generated by
`frontend/scripts/generate-dev-branding.mjs`) so deployed dev apps are
distinguishable from production by their tab and installed icons.

For first-time browser-test setup:

```sh
cd frontend
npx playwright install chromium
```

## Rust Conventions

- All crates inherit workspace lints. `unsafe` is forbidden; Clippy denies all
  warnings plus `unwrap`, `expect`, and `panic` usage.
- Use `Result` and meaningful error context. Do not replace recoverable errors
  with process termination or silent defaults.
- Prefer existing workspace dependencies. Add shared versions to
  `[workspace.dependencies]`, then reference them with `.workspace = true`.
- Preserve exact internal crate versions and the established dependency graph.
- Keep public modules narrow. Re-export domain concepts deliberately from each
  crate's `lib.rs`; do not turn crate roots into indiscriminate barrels.
- Use UUIDs according to existing model and persistence patterns. Do not invent
  externally meaningful integer identifiers.
- Use the application `Clock` abstraction where deterministic time matters.
- Add succinct comments only for non-obvious safety, SQL, auth, or algorithmic
  reasoning. Do not narrate straightforward code.

### Finance and domain values

- Never use binary floating point for calculations, rounding, totals, rates, or
  persistence. Use `rust_decimal::Decimal` and the domain `Money` boundary.
- Perform currency and non-negative validation at domain boundaries.
- Preserve line-based decimal invoice rounding and existing loan/compounding
  semantics unless a requirements change explicitly calls for different rules.
- Serialized JSON may use the established transport representation, but convert
  to validated decimal/domain values before calculations.
- Household date/month logic belongs in `checkbook-domain/src/time.rs`; do not
  replace household-time-zone behavior with server-local dates.
- Unit test boundary cases: zero values, rounding edges, invalid inputs, date
  boundaries, overpayments, and cadence behavior as relevant.

## PostgreSQL, RLS, and Transactions

Household isolation is a security invariant, not merely a query convention.

- Run household-scoped operations inside `tenant::begin(pool, household_id,
  read_only)`. This sets the transaction-local `app.household_id` used by RLS.
- Use `read_only = true` for reads and `false` for writes. Write transactions
  acquire the household advisory lock to serialize household mutations.
- Do not issue household-scoped queries directly against `PgPool`, bypass RLS,
  disable forced RLS, or rely only on a `WHERE household_id = ...` predicate.
- Include `household_id` explicitly in inserts and preserve composite foreign
  keys/policies that prevent cross-household references.
- Keep global maintenance and administrative operations constrained to the
  established functions and restricted privileges. Do not grant the app role
  `BYPASSRLS`, superuser, schema ownership, or audit-event update/delete rights.
- `audit_events` is append-only for the application role.
- Commit explicitly after successful writes. Let errors roll transactions back.
- Use compile-checked `sqlx::query!`/`query_as!` macros for ordinary SQL.
  Runtime `sqlx::query` is acceptable only for genuinely dynamic or PostgreSQL
  utility statements that cannot be prepared; document why and ensure caller
  input is bound or server-quoted.
- Test authorization and isolation at the database boundary, not only through
  route-handler mocks.

## Migrations and SQLx Metadata

Migrations live in `crates/checkbook-postgres/migrations` and are embedded into
the binary.

- Add a new monotonically numbered migration for every schema change.
- Never edit, rename, reorder, or delete an already applied migration. Readiness
  verifies migration count, versions, success flags, and checksums; changing
  history makes deployed databases unready.
- Write forward-only, deterministic PostgreSQL 18 SQL. Include indexes,
  constraints, grants, RLS policies, and role implications in the same review.
- Validate migration from an empty database, not only an upgraded developer DB.
- Keep migration and role bootstrap separate. The admin role migrates; the
  restricted app role serves traffic.

SQLx macros compile in CI from committed `.sqlx` metadata with
`SQLX_OFFLINE=true`. After adding or changing a compile-checked query:

```sh
export DATABASE_URL="$ADMIN_DATABASE_URL"
cargo sqlx prepare --workspace
git status --short .sqlx
cargo sqlx prepare --workspace --check
```

The database at `DATABASE_URL` must already have the current migrations. Commit
all intended metadata additions/removals and review them like generated code.
Do not hand-edit `.sqlx/*.json`, delete metadata to hide drift, or convert a
static query to runtime SQL merely to avoid regenerating metadata.

## API and Contract Rules

- Keep routes grouped by domain in `crates/checkbook-api/src` and mirror their
  persistence code in the corresponding PostgreSQL module.
- Use typed request/response DTOs and the existing `ApiError` mapping. Preserve
  the standard JSON error shape `{ "detail": "..." }`.
- Protected routes must use the common authentication/authorization boundary.
  Add permission checks through application policy, not ad hoc role strings.
- Keep public and private listeners separate. The private data-load API requires
  all three admin settings, a token of at least 32 characters, and a controlled
  staging root. It must not be exposed through the public proxy.
- Development authentication is forbidden in production and must listen on a
  different address from the public API.
- Update Utoipa annotations, operation IDs, router registration, and contract
  tests together.

An endpoint change usually requires reviewing all of:

```text
crates/checkbook-api/src/lib.rs
crates/checkbook-api/src/<domain>.rs
crates/checkbook-api/src/dto.rs
crates/checkbook-api/tests/*_contract.rs
tests/contract/openapi-paths.json
frontend/src/api/<domain>.ts
frontend/src/contracts/<domain>.ts
frontend/src/features or frontend/src/pages
```

`openapi_contract.rs` compares reviewed paths, generated OpenAPI operation IDs,
and methods exported by the modular frontend API clients. If API modules are
reorganized, update the test's source list while preserving the comparison. Do
not replace that guard with a weaker assertion. `createInvoiceTemplate` is an
intentional server operation without a public frontend client method and is
explicitly accounted for by the test.

## Frontend Architecture

The frontend is organized around transport contracts, domain API modules,
feature hooks/models, reusable components, and route pages.

- Keep `frontend/src/lib/api.ts` as the small compatibility facade that composes
  domain clients from `frontend/src/api`. Add endpoint implementations to the
  matching domain module, not to the facade.
- Put transport-only types in `frontend/src/contracts/<domain>.ts`; keep
  `frontend/src/types.ts` as a compatibility barrel. Use `import type` when the
  import has no runtime value.
- TanStack Query owns server state. Put reusable query keys, queries, mutations,
  cache updates, and invalidations in `frontend/src/features/<feature>`.
- Keep temporary form state, open/closed state, and ephemeral interaction state
  local. Do not duplicate fetched server data into component state unless an
  editable draft requires it.
- Route pages should compose features and layout. Extract repeated or complex
  behavior instead of growing page components or `App.tsx`.
- Reusable components should have explicit props, stable accessibility behavior,
  and no hidden dependency on a particular page. Reuse `Modal`, `SectionPanel`,
  `EmptyState`, `AsyncState`, `Button`, `FormField`, and `MetricGrid` before
  creating parallel markup.
- Prefer a feature hook/model when behavior is reusable; prefer a presentational
  component when only rendering is reusable. Avoid components that mix unrelated
  fetching, mutation, navigation, and presentation concerns.
- Use Lucide icons through `lucide-react`. Icon-only buttons need an accessible
  name and a tooltip/title when the meaning is not obvious.
- Preserve keyboard navigation, focus trapping/restoration, Escape handling,
  loading/error/empty states, and disabled/busy semantics.
- Keep route definitions centralized in `frontend/src/app/routes.ts` and update
  route tests when navigation changes.
- Avoid `any`, unchecked casts, duplicated API shapes, and non-null assertions
  unless an invariant is demonstrably enforced at the same boundary.

### Frontend styling

Use the existing styling layers consistently:

1. `styles/tokens.css` owns global colors, typography defaults, and reusable
   design tokens.
2. `index.css` owns imports, resets, document defaults, and app-shell primitives.
3. `styles/primitives.css` owns small shared semantic primitives.
4. `styles/features/*.css` owns feature-specific selectors.
5. `App.css` contains legacy/app-wide styles; do not grow it for new feature
   work. Move touched feature blocks to their feature stylesheet when practical.

Additional rules:

- Reuse CSS custom properties rather than duplicating color literals, shadows,
  radii, spacing, or state colors. Add a token only when it is genuinely shared.
- Use semantic class names consistent with the existing block/element/modifier
  style. Avoid large one-off inline style objects.
- Do not introduce CSS modules, CSS-in-JS, another utility framework, or a new
  component library without an explicit architectural decision.
- Keep responsive dimensions stable with grid/flex constraints, `min-width: 0`,
  and tested mobile/desktop breakpoints. Dynamic content must not shift fixed
  controls or overflow its parent.
- Check light/dark assumptions against the actual tokens. Do not hardcode a
  one-off color that only works in one surface context.
- Keep accessibility states visible: focus, hover, active, disabled, busy,
  validation, and error.
- If a selector is reused across unrelated features, promote it to a primitive;
  if it is feature-specific, keep it out of global files.

## Testing Strategy

Tests should scale with risk. Start targeted and broaden before completion.

### Rust fast checks

```sh
cargo fmt --all -- --check
cargo check-all
cargo test -p checkbook-domain
cargo test -p <changed-crate> --all-targets
```

Run Clippy after code settles:

```sh
cargo clippy-all
```

### PostgreSQL-backed checks

Prepare a migrated database and export all test variables:

```sh
export ADMIN_DATABASE_URL=postgresql://checkbook_admin:checkbook@localhost:25432/checkbook
export TEST_DATABASE_URL=postgresql://checkbook_app:checkbook-app@localhost:25432/checkbook
export DB_APP_PASSWORD=checkbook-app
cargo test --workspace --all-targets
```

Many integration tests use this pattern:

```text
TEST_DATABASE_URL missing -> print a skip message -> return success
```

Therefore, confirm the output contains the expected test bodies and no skip
messages before claiming database coverage. `migrate_from_empty` additionally
requires `ADMIN_DATABASE_URL` and creates/drops a temporary database.

### Frontend checks

From `frontend`:

```sh
npm run lint
npm run test
npm run build
npm run test:e2e
```

Use Vitest/Testing Library for models, hooks, reusable controls, and user-visible
component behavior. Use Playwright for routing, shell behavior, responsive
layout, and critical workflows. When UI changes, visually inspect at least one
desktop and one narrow mobile viewport and check the browser console/network log.

### Change-to-check matrix

| Change | Minimum focused verification |
| --- | --- |
| Domain calculation/value | Domain unit tests, workspace format and Clippy |
| Permission/auth policy | Application tests plus API contract/auth tests |
| SQL query/persistence | Changed crate tests with `TEST_DATABASE_URL`, SQLx metadata check |
| Migration/RLS/grants | Empty migration, RLS isolation, maintenance tests, SQLx prepare check |
| API route/DTO | Relevant API contract test and `openapi_contract` |
| Invoice template/rendering | Document tests and invoice API contract |
| Frontend model/hook | Targeted Vitest plus lint/build |
| Shared UI/modal/style | Component tests, lint/build, Playwright, desktop/mobile inspection |
| Dependency/lockfile | Build/tests plus `cargo audit`/`cargo deny` or `npm audit` as applicable |
| Container/startup | Compose or image smoke test and readiness endpoint |

### Full pre-merge verification

The backend CI-equivalent sequence is:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --profile ci -- -D warnings
cargo build --locked -p checkbook --bin checkbook --profile ci
DATABASE_URL="$ADMIN_DATABASE_URL" ./target/ci/checkbook migrate
DATABASE_URL="$ADMIN_DATABASE_URL" ./target/ci/checkbook bootstrap-database
DATABASE_URL="$ADMIN_DATABASE_URL" cargo sqlx prepare --workspace --check
cargo test --workspace --all-targets --locked --profile ci
cargo audit
cargo deny check advisories bans licenses sources
sh infrastructure/scripts/check-no-python-runtime.sh
sh -n infrastructure/scripts/*.sh
```

The frontend CI sequence is currently:

```sh
cd frontend
npm ci
npx eslint src
npm run test
npm run build
npm run test:e2e
```

## Dependencies and Security

- Commit `Cargo.lock` and `frontend/package-lock.json` changes with their manifest
  changes. Use `--locked` in reproducibility checks.
- Prefer the smallest compatible dependency update. Inspect reverse dependency
  trees with `cargo tree -i <crate>` before adding direct pins or overrides.
- Run `cargo audit` and `cargo deny check advisories bans licenses sources` after
  Rust dependency changes. Run `npm audit` after frontend dependency changes.
- Update a vulnerable dependency when a compatible fix exists. Do not add an
  audit ignore for convenience.
- Any unavoidable advisory ignore must document reachability, exposure, upstream
  status, and a review date. Keep `.cargo/audit.toml` and `deny.toml` aligned for
  ignored vulnerabilities where both tools apply.
- The Typst dependency graph is large and has documented transitive exceptions.
  Reassess those comments when updating Typst, `typst-as-lib`, PDF/font, XML, or
  syntax-highlighting dependencies.
- Never log tokens, session values, database URLs with passwords, backup contents,
  private archives, or identity assertions.
- Never commit `.env`, production templates with real values, generated backups,
  data-load staging content, or credentials.

## Backups, Imports, and Data Loads

- Treat archives and imports as untrusted input. Preserve checksum, path,
  reference-integrity, size, and atomicity validation.
- Prevent path traversal and symlink escapes. Keep backup/admin roots explicit and
  canonicalized according to existing helpers.
- Preserve decimal lexemes during archive round trips.
- Data-load commit is an atomic replacement operation scoped to the authorized
  household. Staging, validation, commit, and cleanup must remain distinct.
- The private data-load listener and bearer credential are separate from normal
  user authentication. Never expose this listener through frontend/nginx or the
  Cloudflare public tunnel.

## Containers and Deployment

- Build the API through `infrastructure/docker/Dockerfile`; keep the production
  process non-root and SQLx-offline compatible.
- Keep migration, bootstrap, API, frontend, and tunnel responsibilities in their
  existing Compose services.
- Readiness means the database has the exact embedded migration history and the
  application role has the expected restricted privileges.
- Production must set `APP_ENV=production`, disable development auth, configure
  allowed origins and Cloudflare Access, and keep the admin listener isolated.
- Production deployment must use an out-of-band pinned `DEPLOY_KNOWN_HOSTS`
  value. Never replace it with deployment-time `ssh-keyscan` trust.
- Preserve the pre-migration PostgreSQL dump step and restrictive permissions on
  the remote deployment directory and environment files.
- Changes to Compose, Dockerfiles, CI, or deploy scripts require a shell/config
  review and an appropriate local smoke test. Do not trigger a GitLab deployment
  or run `infrastructure/scripts/deploy.sh` unless explicitly requested.

## Git and Change Hygiene

- Use `rg`/`rg --files` for repository searches.
- Use the existing formatter; do not manually reformat unrelated sections.
- Avoid generated-file churn. Review `.sqlx`, lockfile, and build-output changes.
- Do not commit `target`, `frontend/node_modules`, `frontend/dist`, Playwright
  reports, test results, local IDE files, caches, `.env`, backups, or secrets.
- Do not use destructive Git commands or revert user changes. Do not create a
  commit, amend, rebase, force-push, or deploy unless asked.
- Before finishing, run `git diff --check` and inspect `git diff --stat` plus the
  full diff of every file changed by the task.

## Definition of Done

Before reporting a task complete, verify all applicable items:

- The behavior is implemented at the correct architectural layer.
- Financial, household-time, authorization, RLS, and auth-listener invariants are
  preserved.
- Schema changes use a new migration and committed SQLx metadata is current.
- Backend and frontend API contracts remain aligned.
- Shared frontend primitives and style tokens were reused before adding new
  patterns; touched UI works at desktop and mobile widths.
- Focused regression tests cover the changed behavior.
- Applicable format, lint, type/build, test, audit, and contract checks pass.
- Database tests truly executed rather than skipped for missing environment.
- No unrelated files, secrets, local artifacts, or deployment actions are part
  of the change.
- The final report states what changed, what was verified, and any remaining risk
  or check that was not run.
