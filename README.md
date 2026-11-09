# Checkbook

Checkbook is a household finance application with a React frontend and a Rust backend.

Licensed under the [MIT License](LICENSE).

## Public snapshot preparation

See [PUBLICATION.md](PUBLICATION.md) for the exact snapshot file manifest,
exclusions, audit limits, and test-key review before publication.
Do not copy this working directory wholesale: ignored local data
and Git history are not part of the public project.

This sanitized source targets **fresh databases**. Migration 0014 previously
contained a private household-specific repair and has been sanitized for the
history-free public snapshot. Its checksum differs from existing deployments.
Do not deploy this tree against an existing database or rewrite its migration
metadata to bypass readiness checks. Existing deployments must retain their
original private migration files or follow a separately reviewed migration plan.

## Runtime architecture

- React 19, TypeScript, and Vite frontend
- Rust 1.96 modular monolith using Axum and Tokio
- SQLx with PostgreSQL 18 only
- `rust_decimal`/PostgreSQL `NUMERIC` for financial values
- Typst invoice rendering with bundled Noto Sans fonts
- Cloudflare Access JWT or Google ID-token authentication
- Hashed opaque application sessions
- PostgreSQL row-level security for household isolation

There is no Python, SQLite, Redis, TimescaleDB, SQLAlchemy, Alembic, or runtime schema repair.

## Workspace

```text
crates/checkbook-domain       Domain values and financial calculations
crates/checkbook-application  Permissions and application-level policy
crates/checkbook-postgres     Migrations, tenant transactions, persistence
crates/checkbook-documents    Typst invoice documents
crates/checkbook-api          Public API and private data-load API
crates/checkbook              CLI and server process
frontend                      Existing React application
```

## CLI

```text
checkbook migrate
checkbook bootstrap-database
checkbook serve
checkbook seed-development
```

Migrations run as a one-shot deployment job. `serve` never performs schema changes.

## Local development

The simplest local setup uses Compose:

```sh
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
```

Default ports:

- frontend: `13009`
- API: `18000`
- PostgreSQL: `25432`

The local overlay runs migrations, configures the restricted `checkbook_app` database role, seeds development data, then starts the API and frontend.

For direct Rust development:

```sh
export DATABASE_URL=postgresql://checkbook_admin:checkbook@localhost:25432/checkbook
cargo run --bin checkbook -- migrate

export DB_APP_PASSWORD=checkbook-app
cargo run --bin checkbook -- bootstrap-database

export DATABASE_URL=postgresql://checkbook_app:checkbook-app@localhost:25432/checkbook
export DEV_AUTH_ENABLED=true
export LISTEN_ADDRESS=127.0.0.1:8001
export DEV_AUTH_LISTEN_ADDRESS=127.0.0.1:8000
cargo run --bin checkbook -- serve
```

Run the frontend separately with:

```sh
cd frontend
npm ci
npm run dev
```

## US holdings closing prices

Stock accounts can attach an optional US-listed stock or ETF ticker to each
holding (for example, `AAPL`, `VTI`, or `BRK-B`). Open holdings with a ticker
receive the latest completed daily closing price from Yahoo Finance. Sold lots,
manual holdings without tickers, savings accounts, and options are not quoted.

Prices are fetched by the backend and cached in PostgreSQL; no Yahoo account,
API key, or browser-to-Yahoo connection is required. The server needs outbound
HTTPS access to `query1.finance.yahoo.com`. The price date, USD currency, and
stale/unavailable state are shown with the quote. Yahoo's endpoint is unofficial
and can change or rate-limit requests; a failed refresh retains the last
successful cached price rather than substituting zero. Quotes refresh on demand
while the account is viewed, not through a background portfolio job. The current
session's daily bar is excluded until at least 20 minutes after its regular
close, and failed requests use a 30-minute retry backoff.

Market values are informational: they do not overwrite purchase costs, recorded
account valuations, or household-currency totals. No exchange-rate conversion is
performed. A ticker must be configured explicitly; holding names are not treated
as ticker symbols.

## Production configuration

The GitLab deployment jobs require these custom CI/CD variables. Values shared
by both environments may use the `All (default)` scope; values that identify an
environment-specific service should have separate `dev` and `prod` entries.

| Variable | Recommended scope | Purpose |
| --- | --- | --- |
| `DB_PASSWORD` | `dev` and `prod` | PostgreSQL administrative-role password |
| `DB_APP_PASSWORD` | `dev` and `prod` | Restricted `checkbook_app` role password |
| `DEPLOY_HOST` | `All (default)` | SSH host name or IP address |
| `DEPLOY_USER` | `All (default)` | Remote SSH user |
| `DEPLOY_SSH_KEY` | `All (default)` | Complete private key for the deploy user |
| `DEPLOY_KNOWN_HOSTS` | `All (default)` | Complete, verified SSH host-key record |
| `TUNNEL_TOKEN` | `dev` and `prod` | Environment-specific Cloudflare Tunnel token |
| `CLOUDFLARE_ACCESS_TEAM_DOMAIN` | `All (default)` when shared | Cloudflare Access team domain |
| `CLOUDFLARE_ACCESS_AUDIENCE` | `dev` and `prod` | Environment-specific Access application audience |

Mark passwords, private keys, and tokens as protected where the corresponding
branches are protected. A protected variable is unavailable to an unprotected
branch, so either protect development branches or leave the variables needed by
`deploy-dev` unprotected. Host names, Access audience values, and public SSH host
keys are not secrets and do not need masking.

GitLab supplies `CI_REGISTRY`, `CI_REGISTRY_USER`, `CI_REGISTRY_PASSWORD`,
`CI_REGISTRY_IMAGE`, and `CI_COMMIT_SHA`; do not create custom copies of them.
`PROJECT_NAME` is already set to `checkbook` in `.gitlab-ci.yml` and does not need
to be a project variable.

Optional deployment variables are:

- `DEPLOY_BASE_PATH`: base directory before the environment suffix; defaults to
  `/opt/checkbook`. Set `/opt/checkbook`, not `/opt/checkbook/prod`, because CI
  appends `/dev` or `/prod`.
- `DEPLOY_PORT`: SSH port, default `22`.
- `BACKUP_HOST_PATH`: host backup directory; defaults to
  `$DEPLOY_PATH/backups`.
- `DATA_LOAD_HOST_PATH`: host data-load staging directory; defaults to
  `$DEPLOY_PATH/data-loads`.
- `ADMIN_SERVICE_TOKEN`: enables the private data-load API when set and must be
  at least 32 characters.
- `FRONTEND_ORIGIN` and `ALLOWED_ORIGINS`: public origin overrides.
- `GOOGLE_CLIENT_ID`: enables the separate backend Google ID-token endpoint.
  The current frontend signs in through Cloudflare Access and does not require
  this variable.
- `SESSION_HOURS`, `MAINTENANCE_INTERVAL_SECONDS`, and `FRONTEND_HOST_PORT`:
  runtime tuning overrides with defaults in the deployment scripts.

`GOOGLE_DRIVE_CLIENT_SECRET` and `VITE_GOOGLE_DRIVE_CLIENT_ID` are unused legacy
variables. Google Drive integration is not part of the deployed application, so
they should be removed from GitLab.

### SSH host key

`DEPLOY_KNOWN_HOSTS` must contain the full OpenSSH record, not only the server IP
or a fingerprint. For the default SSH port it has this form:

```text
192.0.2.20 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...
```

Obtain the candidate record from a trusted network path:

```sh
ssh-keyscan -t ed25519 192.0.2.20
```

`ssh-keyscan` does not authenticate the server. Compare its fingerprint with the
host key read directly on the deployment server:

```sh
# On the deployment server.
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub

# On the trusted machine used to scan it.
ssh-keyscan -t ed25519 192.0.2.20 | ssh-keygen -lf -
```

Only after the SHA256 fingerprints match, store the complete `ssh-keyscan`
output line as `DEPLOY_KNOWN_HOSTS`. Do not include an abbreviated key or literal
ellipsis. For a non-default port, scan with `ssh-keyscan -p 2222` and use the
resulting `[192.0.2.20]:2222 ssh-ed25519 ...` record. The record host and port
must match `DEPLOY_HOST` and `DEPLOY_PORT` exactly.

Compose derives the required application settings (`DATABASE_URL`,
`APP_ENV=production`, `ALLOWED_ORIGINS`, and `BACKUP_ADMIN_ROOT`) from these CI
variables and deployment defaults.

Development authentication is rejected when `APP_ENV=production`. When enabled
outside production it is served only by the explicitly configured
`DEV_AUTH_LISTEN_ADDRESS`; the normal listener never enables development login.

## Private data-load API

One-time population and controlled bulk repair use a separate listener:

- `POST /api/admin/v1/data-loads`
- `GET /api/admin/v1/data-loads/{id}`
- `POST /api/admin/v1/data-loads/{id}/commit`
- `DELETE /api/admin/v1/data-loads/{id}`
- `GET /api/admin/v1/archive-schema`

Configure it with:

- `ADMIN_LISTEN_ADDRESS`
- `ADMIN_SERVICE_TOKEN` (at least 32 characters)
- `DATA_LOAD_STAGING_ROOT`

The listener requires its own bearer credential, stages checksum-validated archives, enforces idempotency, and atomically replaces household business data on commit. Production Compose exposes it only on loopback; it must not be proxied through nginx or Cloudflare Tunnel.

## Verification

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-targets
cargo audit
cargo deny check advisories bans licenses sources

cd frontend
npm ci
npm run lint
npm run test
npm run build
npm run test:e2e
```

Google Drive and workbook parsing are intentionally absent from the production
application. One-time source conversion is performed outside the deployed
codebase, then loaded through the private versioned archive API.

## Deployment

GitLab CI builds a non-root Rust API image, migrates an empty PostgreSQL database, configures the restricted application role, runs the full PostgreSQL integration suite, builds and tests the frontend, and smoke-tests `/health/ready`.

Each deployment writes a custom-format PostgreSQL dump to
`$DEPLOY_PATH/predeploy-backups` before applying migrations. The deployment host
key must be provisioned out of band in the protected `DEPLOY_KNOWN_HOSTS` CI
variable; deployment does not trust a key discovered from the live network.

See [infrastructure/PROXMOX_CT.md](infrastructure/PROXMOX_CT.md) for the host setup.
