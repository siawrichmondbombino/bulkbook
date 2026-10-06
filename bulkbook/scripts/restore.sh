#!/bin/sh
# Puts a backup file back into an EMPTY Bulkbook database.
#
# Steps:
#  1. Make a new Supabase project (or empty the old one) and run database/schema.sql in its SQL Editor.
#  2. Run this script with the new project's connection string (Session pooler) and the backup file.
#
# Usage:  DATABASE_URL='postgresql://...' sh scripts/restore.sh backups/bulkbook-2026-10-04_120000.dump
#
# Only data is restored. Tables, security rules and functions come from schema.sql, so run that first.
set -eu
: "${DATABASE_URL:?Set DATABASE_URL to the connection string of the database to restore INTO}"
FILE="${1:?Give the backup file name, for example backups/bulkbook-2026-10-04_120000.dump}"
command -v psql >/dev/null 2>&1 || { echo "psql (PostgreSQL client tools) is not installed on this computer."; exit 1; }
# Safety: only restore into a database that has no shop data yet, so nothing is doubled up.
N=$(psql "$DATABASE_URL" -Atc "select (select count(*) from public.receipts) + (select count(*) from public.products) + (select count(*) from public.customers) + (select count(*) from public.profiles)")
[ "$N" = "0" ] || { echo "Stopped: this database already has shop data ($N rows). Restore only into a database where you have just run schema.sql."; exit 1; }
echo "This will add the saved data to the empty database in DATABASE_URL. Press Enter to continue, Ctrl+C to stop."
read -r _
# schema.sql creates one default settings row; the backup brings the real one.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "truncate public.app_settings"
# Restore the tables in a safe order (people and goods first, then customers, receipts, payments), because
# customers and receipts point to the people who made them. Counters (receipt numbers) are restored last.
TOC=$(mktemp); LIST=$(mktemp); trap 'rm -f "$TOC" "$LIST"' EXIT
pg_restore --list "$FILE" > "$TOC"
: > "$LIST"
for t in profiles app_settings products customers receipts receipt_lines payments monthly_archive activity_log; do
  grep -E "TABLE DATA public $t( |$)" "$TOC" >> "$LIST" || true
done
grep "TABLE DATA" "$TOC" | while read -r line; do grep -qxF "$line" "$LIST" || echo "$line" >> "$LIST"; done
grep "SEQUENCE SET" "$TOC" >> "$LIST" || true
pg_restore --data-only --no-owner --no-privileges --exit-on-error --use-list="$LIST" --dbname="$DATABASE_URL" "$FILE"
echo "Restore finished. Sign in and check Receipts, Who owes me and Goods in stock."
echo "Remember to add the owner row (database/first_owner.sql) if the profiles table was not part of the backup you restored."
