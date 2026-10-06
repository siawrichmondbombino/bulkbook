#!/bin/sh
# Saves a full copy of the shop's data (goods, customers, receipts, payments, settings) to a file on THIS computer.
# Why: the Supabase free plan has no downloadable backups (Supabase's own documentation says so).
#
# Needs: PostgreSQL client tools (pg_dump, pg_restore) installed on your computer.
# Get the connection string in Supabase: Connect button, then "Session pooler". Put your database password in it.
#
# Usage:
#   DATABASE_URL='postgresql://postgres.xxxx:PASSWORD@aws-0-xx.pooler.supabase.com:5432/postgres' sh scripts/backup.sh
#   (optional: a folder name as the first argument, and KEEP=30 for how many files to keep)
#
# Keep the files somewhere safe (a USB drive or another computer). They contain customer names and phone numbers.
set -eu
: "${DATABASE_URL:?Set DATABASE_URL to your Supabase connection string (see the comments at the top of this file)}"
DIR="${1:-backups}"
KEEP="${KEEP:-30}"
mkdir -p "$DIR"
FILE="$DIR/bulkbook-$(date +%Y-%m-%d_%H%M%S).dump"
# Only the shop's own tables (schema "public"). Logins live in Clerk, not here.
pg_dump --format=custom --no-owner --no-privileges --schema=public --file="$FILE" "$DATABASE_URL"
# Make sure the file can be read back. A backup that cannot be read is not a backup.
pg_restore --list "$FILE" >/dev/null
echo "Saved $FILE ($(du -h "$FILE" | cut -f1))"
# Keep only the newest $KEEP files.
ls -1t "$DIR"/bulkbook-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do rm -f "$old"; done
