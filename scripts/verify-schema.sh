#!/usr/bin/env bash
#
# Applies the migrations to a throwaway local Postgres and runs behavioural checks
# against them. Catches schema bugs before they reach the real Supabase project.
#
# Production uses hosted Supabase; this local database exists only for verification.
#
# Requires: brew install postgresql@17
# Usage:    ./scripts/verify-schema.sh

set -euo pipefail

PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
PG_DATA="${PG_DATA:-/opt/homebrew/var/postgresql@17}"
DB="${DB:-pt_verify}"

if [[ ! -x "$PG_BIN/psql" ]]; then
  echo "psql not found at $PG_BIN. Install with: brew install postgresql@17" >&2
  exit 1
fi
export PATH="$PG_BIN:$PATH"

cd "$(dirname "$0")/.."

if ! pg_isready -q; then
  echo "Starting local Postgres..."
  pg_ctl -D "$PG_DATA" -l /tmp/pg17.log start >/dev/null
  for _ in $(seq 1 20); do pg_isready -q && break; sleep 0.5; done
fi

echo "Recreating $DB..."
dropdb --if-exists "$DB"
createdb "$DB"

echo "Applying auth stub..."
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/test/auth_stub.sql

for migration in supabase/migrations/*.sql; do
  echo "Applying $(basename "$migration")..."
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$migration"
done

echo "Running verification..."
# Verification raises on failure, which ON_ERROR_STOP turns into a non-zero exit.
psql -q -v ON_ERROR_STOP=1 -d "$DB" -f supabase/test/verify_schema.sql 2>&1 \
  | grep -E 'PASS|FAIL|ERROR' || true

echo
echo "Schema verified."
