#!/bin/bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SNAPSHOT_DIR="$REPO_ROOT/db/snapshots"
COMPOSE_FILE="$REPO_ROOT/docker-compose.dev.yml"
DB_NAME="piano_dev"
DB_USER="postgres"

FILE="${1:?Usage: db-restore.sh <snapshot-name|path>}"

# Resolve path: allow just a name (without .sql) or full path
if [ -f "$FILE" ]; then
  FILEPATH="$FILE"
elif [ -f "$SNAPSHOT_DIR/$FILE" ]; then
  FILEPATH="$SNAPSHOT_DIR/$FILE"
elif [ -f "$SNAPSHOT_DIR/$FILE.sql" ]; then
  FILEPATH="$SNAPSHOT_DIR/$FILE.sql"
else
  echo "❌ Snapshot not found: $FILE"
  echo "Available snapshots:"
  ls -1 "$SNAPSHOT_DIR"/*.sql 2>/dev/null || echo "  (none)"
  exit 1
fi

# Safety: auto-backup current state before restoring
BACKUP_FILE="$SNAPSHOT_DIR/pre-restore-backup.sql"
echo "Backing up current DB to $BACKUP_FILE..."
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U "$DB_USER" "$DB_NAME" --clean --if-exists \
  > "$BACKUP_FILE"
echo "  ↳ Backup saved ($(du -h "$BACKUP_FILE" | cut -f1))"

echo "Restoring from $FILEPATH..."
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  psql -U "$DB_USER" "$DB_NAME" -v ON_ERROR_STOP=0 \
  < "$FILEPATH"

echo "✅ Restored from: $(basename "$FILEPATH")"
echo "   If something went wrong, recover with: just dbload pre-restore-backup"
