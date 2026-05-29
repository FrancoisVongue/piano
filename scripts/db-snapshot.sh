#!/bin/bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
SNAPSHOT_DIR="$REPO_ROOT/db/snapshots"
mkdir -p "$SNAPSHOT_DIR"

COMPOSE_FILE="$REPO_ROOT/docker-compose.dev.yml"
DB_NAME="piano_dev"
DB_USER="postgres"

# Safe-by-default snapshots: schema + non-sensitive metadata only. Set
# PIANO_DBDUMP_INCLUDE_USER_DATA=1 for local-only snapshots that keep
# user-created canvases, notes, actions, runs, and workflows.
SENSITIVE_TABLES=(
  User
  UserApiKey
  Session
  Account
  Verification
  MachineApiToken
  Secret
  Daemon
  DaemonPairingCode
)

USER_CONTENT_TABLES=(
  Arrangement
  Note
  NoteVersion
  Edge
  Run
  Action
  Unifier
  MachineTemplate
  Workflow
)

if [ "${PIANO_DBDUMP_INCLUDE_USER_DATA:-0}" = "1" ]; then
  EXCLUDE_TABLES=("${SENSITIVE_TABLES[@]}")
else
  EXCLUDE_TABLES=("${SENSITIVE_TABLES[@]}" "${USER_CONTENT_TABLES[@]}")
fi

EXCLUDE_ARGS=""
for t in "${EXCLUDE_TABLES[@]}"; do
  EXCLUDE_ARGS="$EXCLUDE_ARGS --exclude-table-data=public.\"$t\""
done

# Use commit hash if available, otherwise timestamp
if git diff --quiet HEAD 2>/dev/null; then
  LABEL="$(git rev-parse --short HEAD)"
else
  LABEL="$(git rev-parse --short HEAD 2>/dev/null || echo 'no-commit')-dirty"
fi

# Allow overriding the filename via first argument
FILENAME="${1:-$LABEL}.sql"
FILEPATH="$SNAPSHOT_DIR/$FILENAME"

echo "Dumping $DB_NAME (excluding table data: ${EXCLUDE_TABLES[*]})..."

docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U "$DB_USER" "$DB_NAME" \
    --clean --if-exists \
    $EXCLUDE_ARGS \
  > "$FILEPATH"

SIZE=$(du -h "$FILEPATH" | cut -f1)
echo "✅ Snapshot saved: $FILEPATH ($SIZE)"
