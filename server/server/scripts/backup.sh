#!/usr/bin/env bash
# Dumps the database and encrypts the dump with a passphrase — inventory
# and order data is business-critical, and manual backup habits (like the
# Tally process this system replaces) tend to lapse.
#
# This script does the dump+encrypt step only. Actually running it on a
# schedule (cron, a hosting platform's scheduled jobs, etc.) and shipping
# the output somewhere other than this machine (S3, another server — "at
# least one backup copy separate from the primary environment") is a
# deployment decision, not something this script can decide on its own.
#
# Usage:
#   BACKUP_ENCRYPTION_PASSPHRASE="..." ./scripts/backup.sh [output-dir]
#
# Restore:
#   openssl enc -d -aes-256-cbc -pbkdf2 -pass pass:"$BACKUP_ENCRYPTION_PASSPHRASE" \
#     -in backup-2026-07-12T12-00-00.db.enc -out restored.db
set -euo pipefail

OUT_DIR="${1:-./backups}"
TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%S)"
mkdir -p "$OUT_DIR"

if [ -z "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]; then
  echo "Error: BACKUP_ENCRYPTION_PASSPHRASE must be set." >&2
  exit 1
fi

DATABASE_URL="${DATABASE_URL:-$(grep -E '^DATABASE_URL=' .env 2>/dev/null | cut -d= -f2- | tr -d '"')}"
if [ -z "$DATABASE_URL" ]; then
  echo "Error: DATABASE_URL not set and not found in .env" >&2
  exit 1
fi

RAW_DUMP="$OUT_DIR/backup-$TIMESTAMP.raw"

if [[ "$DATABASE_URL" == file:* ]]; then
  # Prisma resolves a relative "file:./x" path relative to prisma/schema.prisma's
  # directory, not the process's cwd — match that convention here.
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REL_PATH="${DATABASE_URL#file:}"
  REL_PATH="${REL_PATH#./}"
  DB_PATH="$SCRIPT_DIR/../prisma/$REL_PATH"
  echo "Dumping SQLite database at $DB_PATH..."
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_PATH" ".backup '$RAW_DUMP'"
  else
    echo "Warning: sqlite3 CLI not found, falling back to a plain file copy (safe only if nothing is writing to the DB right now)." >&2
    cp "$DB_PATH" "$RAW_DUMP"
  fi
elif [[ "$DATABASE_URL" == postgres* ]]; then
  echo "Dumping Postgres database..."
  pg_dump "$DATABASE_URL" > "$RAW_DUMP"
else
  echo "Error: unrecognized DATABASE_URL scheme" >&2
  exit 1
fi

ENCRYPTED="$OUT_DIR/backup-$TIMESTAMP.enc"
openssl enc -aes-256-cbc -pbkdf2 -salt -pass "pass:$BACKUP_ENCRYPTION_PASSPHRASE" -in "$RAW_DUMP" -out "$ENCRYPTED"
rm -f "$RAW_DUMP"

echo "Encrypted backup written to $ENCRYPTED"
echo "Copy this file somewhere other than this machine — a local backup is not a real backup."
