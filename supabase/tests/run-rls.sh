#!/usr/bin/env bash
# Runs the migrations and the row-level security tests on a scratch Postgres.
# Usage: PGHOST=/tmp/pgt PGPORT=5544 PGUSER=postgres supabase/tests/run-rls.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DB=rls_test_$$
psql -v ON_ERROR_STOP=1 -qc "create database $DB" postgres
trap 'psql -qc "drop database $DB" postgres' EXIT
export PGDATABASE=$DB
psql -v ON_ERROR_STOP=1 -q -f tests/stub.sql
for f in migrations/*.sql; do psql -v ON_ERROR_STOP=1 -q -f "$f"; done
psql -v ON_ERROR_STOP=1 -q -c "grant select,insert,update,delete on all tables in schema public to authenticated; grant usage on all sequences in schema public to authenticated"
psql -v ON_ERROR_STOP=1 -f tests/rls.sql
