#!/bin/sh
set -eu

for path in backend database alembic.ini requirements.txt pyproject.toml uv.lock; do
  if [ -e "$path" ]; then
    echo "Retired Python runtime artifact remains: $path" >&2
    exit 1
  fi
done

if [ -e crates/checkbook-import ] \
  || grep -R -n -E '(^|[[:space:]])(calamine|roxmltree)[[:space:]]*=' \
    --include='Cargo.toml' Cargo.toml crates 2>/dev/null; then
  echo "Retired workbook parser remains in the production Rust workspace." >&2
  exit 1
fi

if grep -R -n -E 'excel_import|ExcelImport' \
  --include='*.rs' --include='*.sql' crates 2>/dev/null; then
  echo "Legacy workbook-import data-source markers remain." >&2
  exit 1
fi

# Only inspect tracked files. Build/dependency caches must not count as "the
# repository": CI sets CARGO_HOME=$CI_PROJECT_DIR/.cargo-ci, and crates such as
# unicode-*, encoding_rs, and the Typst stack ship .py codegen scripts that would
# otherwise produce false positives.
# data-import/ is intentionally excluded: it holds local data-conversion tooling
# (convert_checkbook.py) that is not part of the runtime backend.
python_files=$(git ls-files -- '*.py' '*.pyc' 2>/dev/null | grep -v '^data-import/' || true)
if [ -n "$python_files" ]; then
  echo "Runtime Python source or bytecode remains in the repository:" >&2
  printf '%s\n' "$python_files" >&2
  exit 1
fi

deploy_config_files=$(git ls-files -- '*Dockerfile*' '*.yml' '*.yaml' 2>/dev/null || true)
if [ -n "$deploy_config_files" ] \
  && printf '%s\n' "$deploy_config_files" | tr '\n' '\0' \
     | xargs -0 grep -n -E 'FROM[[:space:]]+python|uvicorn|alembic|sqlalchemy|timescale|redis:' 2>/dev/null; then
  echo "Retired runtime technology remains in deployment configuration." >&2
  exit 1
fi
