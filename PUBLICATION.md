# Clean public snapshot

## Scope and outstanding decisions

This preparation covers current source files, not Git history. Do not publish a
recursive copy of this working directory. Ignored directories contain local
PostgreSQL databases, scratch SQL, browser artifacts, probe scripts and an old
archive that itself contains private imports. Ignoring a file does not erase it.

The project is licensed under the [MIT License](LICENSE), matching `Cargo.toml`.
The owner has chosen to permit open reuse and redistribution. Retain the bundled
Noto font license and any other upstream notices for third-party material.

Before publication the owner must:

- Confirm that the intentionally public RSA fixture was never used outside tests.
  See `crates/checkbook-api/tests/fixtures/README.md`. Current references and its
  introduction support test-only use, but historical external reuse cannot be
  established from the repository.
- Review the generated file manifest and scan the final export immediately before
  uploading. No audit can guarantee absence of secrets or personal information.

## Fresh database boundary

Migration `0014_expense_source_links.sql` formerly contained a private,
household-specific alias repair. It is removed from this history-free source,
and the related runtime special case is removed. Generic source linking remains.
This changes an applied migration checksum deliberately for the fresh public
project. **Do not deploy this tree to an existing database**, alter its recorded
migration checksums, or replace a production migration history with this one.
Keep existing deployments on their original private history until a separate,
reviewed transition plan is prepared. No database was changed by this cleanup.

## Exact include list

From the repository root, generate the concrete, one-path-per-line list:

```sh
node infrastructure/scripts/public-snapshot.mjs
```

That list is the inclusion manifest: existing tracked files plus nonignored new
files, with explicit private/generated exclusions. It includes current working
tree edits, not the last committed versions. Review additions before export.
For a history-free export to a **new, nonexistent** destination:

```sh
node infrastructure/scripts/public-snapshot.mjs public-snapshot
```

The exporter refuses symlinks and existing destinations. The result contains
`SNAPSHOT-MANIFEST.txt` with every included repository file. It never copies
`.git`, including history, remotes, author metadata or stashes. Do not use
`git archive HEAD`: that would export old private files and omit this cleanup.

Included groups are the reviewed root documentation and manifests, generic
`.env.example` and `.env.production.template`, `.cargo`, `.sqlx`, application
crates including migrations and tests, frontend source/assets/lockfile,
infrastructure, contract fixtures, and these publication tools. The one RSA
fixture is deliberately retained and documented, not globally exempted from
future secret review. The empty local data directory is unnecessary.

## Explicit exclusions

Never include any of the following, even if copied outside their original folder:

- `data-import/**`: removed workbook, CV, converted JSON, summaries, text dumps
  and household-specific Python converter. Generic application import and the
  validated private archive API remain; prepare source conversions externally.
- Any Toyota CSV or other household/vehicle/bank export, spreadsheet, CV, backup,
  dataset, account statement, staging archive or private conversion output.
  No standalone Toyota CSV was found in the current reviewed non-build paths;
  do not assume it is safe if it reappears.
- `.git/**`, `.agents/**`, `.dsh-pg/**`, `tmp/**`, `temp/**`, `target/**`,
  `private-data/**`, `data/**`, `exports/**`, `backups/**`, `.deploy/**`.
- `frontend/node_modules/**`, `frontend/dist/**`, `frontend/test-results/**`,
  `frontend/playwright-report/**`, package caches, logs, screenshots and reports.
- Actual `.env`/`.env.*` files except the two reviewed examples; environment
  overrides, SSH keys, production secrets, certificates/private keys other than
  the documented RSA test fixture, SQL dumps and compressed archives.
- Generated `public-snapshot/**` or other exports nested in a later export.

The exporter is a guardrail, not a content classifier: new tracked or nonignored
source-like files still require human review. Broad ignore rules reduce accidental
addition of private data, but cannot protect already tracked files or arbitrary
copies. Keep private artifacts outside the project when possible.

## Recorded validation

- Secretlint 13.1.0 with recommended rules scanned all 900 manifest files,
  explicitly including hidden configuration. It reported only the disposable
  local-development database URL in `.env.example` and the documented public RSA
  fixture. Findings were inspected with secrets masked; no global suppressions
  were added. Gitleaks was attempted first but its release download returned 504.
- Snapshot exporter regression tests: 2 passed (manifest boundaries, current
  working-tree copying, no Git metadata, refusal to overwrite destinations).
- Backup/schema-upgrade unit tests: 11 passed; document rendering tests: 2 passed.
  Rust formatting and `git diff --check` passed.
- Infrastructure shell syntax, no-Python-runtime guard, YAML parsing and explicit
  security-invariant checks passed. Docker and shellcheck were unavailable.
- Existing utility-color UI changes were preserved. Their previously completed
  validation was 575 frontend tests, lint, production build, and two responsive
  Playwright checks; this publication cleanup did not change those UI files.

No fresh PostgreSQL migration, database integration suite, full workspace Clippy,
or container smoke test was executed for this cleanup. In particular, unit tests
are not evidence that the sanitized migration ran against an empty database.
Run those checks with a disposable PostgreSQL 18 instance before release.

## Audit and validation limits

The review inventories tracked, untracked and ignored paths, checks candidate
source/config/docs and retained binary types, and excludes local databases,
archives and generated dependencies/build trees as units. It does not certify
all bytes of those excluded trees; some build paths are permission-restricted.
Do not publish them. The old scratch archive may retain deleted private files.
Git objects/stashes also retain old data and are deliberately excluded, not
rewritten. Public vendor endpoints, example-domain identities, local disposable
credentials and upstream license authors are not private deployment secrets.

Infrastructure examples use documentation addresses and generic paths; production
dev-auth prohibitions, pinned SSH host trust, restricted database role, explicit
migration/bootstrap, pre-migration backup and private admin isolation remain.
Docker/container smoke tests require Docker and a disposable database; they were
not run in this environment. No production service, secret or database was
modified, deployed or rotated. Any real credential discovered in excluded local
material must be evaluated privately for rotation; exclusion is not revocation.
