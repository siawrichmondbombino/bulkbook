#!/bin/sh
# Runs every automated test. Needs: Node 20+, `npm install`, and a local PostgreSQL 15+ you can create databases in.
# Set PGHOST / PGPORT / PGUSER if the defaults (localhost, 5432, postgres) do not fit.
set -e
cd "$(dirname "$0")/.."
export PGUSER="${PGUSER:-postgres}" PGDATABASE=bulkbook_test
fresh() {
  psql -q -d postgres -c "drop database if exists bulkbook_test" -c "create database bulkbook_test"
  psql -q -v ON_ERROR_STOP=1 -d bulkbook_test -f tests/supabase_stub.sql -f database/schema.sql
}
echo "== 1/3 database: security rules and money logic"; fresh; node tests/sql.test.cjs | tail -3
echo "== 2/3 server (Worker) with simulated Clerk and Supabase"; node tests/worker.test.mjs 2>/dev/null | tail -3
echo "== 3/3 whole app in a simulated browser against the real database rules"; fresh; node tests/e2e.test.cjs | tail -4
echo "All test groups finished."
