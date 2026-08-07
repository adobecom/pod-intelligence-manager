#!/bin/sh
# Create a portable logical backup of authoritative PIM data.
#
# Project-search documents, chunks, embeddings, FTS rows, and graph-index rows
# are derived from evidence/context and are intentionally omitted. EBS recovery
# points retain the complete volume for fast restores; this smaller SQL backup is
# the automatic cross-instance fallback and the long-retention portable copy.
#
# The script is invoked hourly. It always writes the hourly tier, and reuses the
# same verified archive for the daily/weekly tiers at UTC boundaries. S3
# lifecycle rules own retention for each prefix.
#
# Required env:
#   PIM_BACKUPS_BUCKET   target S3 bucket
# Optional env:
#   DB_PATH              default /data/pim.db
#   AWS_REGION           default us-west-2

set -eu

BUCKET="${PIM_BACKUPS_BUCKET:?PIM_BACKUPS_BUCKET env var is required}"
DB_SRC="${DB_PATH:-/data/pim.db}"
REGION="${AWS_REGION:-us-west-2}"
LOCK_DIR="${PIM_BACKUP_LOCK_DIR:-/tmp/pim-backup.lock}"
LOCK_HELD="false"
WORK_DIR=""
GZIP_PID=""

log() { echo "[backup] $*"; }
die() { echo "[backup][FATAL] $*" >&2; exit 1; }

release_lock() {
  [ "$LOCK_HELD" = "true" ] || return 0
  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null || true
  LOCK_HELD="false"
}

cleanup() {
  if [ -n "$GZIP_PID" ]; then
    kill "$GZIP_PID" 2>/dev/null || true
    wait "$GZIP_PID" 2>/dev/null || true
  fi
  if [ -n "$WORK_DIR" ]; then
    rm -f "$WORK_DIR/archive.sql.gz" "$WORK_DIR/archive.sql.gz.sha256" "$WORK_DIR/dump.pipe"
    rmdir "$WORK_DIR" 2>/dev/null || true
  fi
  release_lock
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# Cron can start a second run if a large backup takes more than an hour. Keep a
# PID lock, recover only a lock whose owner is no longer running, and otherwise
# let the active backup finish.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  old_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
  case "$old_pid" in
    ''|*[!0-9]*) old_pid="" ;;
  esac
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    log "another backup is still running (pid=$old_pid); skipping"
    exit 0
  fi
  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null || die "stale backup lock cannot be cleared"
  mkdir "$LOCK_DIR" || die "backup lock cannot be acquired"
fi
LOCK_HELD="true"
printf '%s\n' "$$" > "$LOCK_DIR/pid"

[ -f "$DB_SRC" ] || die "database not found: $DB_SRC"
org_count=$(sqlite3 -readonly "$DB_SRC" "SELECT count(*) FROM orgs" 2>/dev/null || echo 0)
[ "${org_count:-0}" -gt 0 ] 2>/dev/null || die "database has no organizations"

# SQLite's .dump accepts multiple object patterns, but naming a table does not
# automatically include separately-created indexes or triggers for that table.
# Include those schema objects explicitly so composite foreign-key parents and
# append-only guards survive a logical restore. Database-owned identifiers are
# constrained here before they are interpolated into the dot command.
authoritative_objects_sql="
  WITH authoritative_tables AS (
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table'
      AND name NOT GLOB 'sqlite_*'
      AND name NOT GLOB 'project_search_*'
  )
  SELECT schema_object.name
  FROM sqlite_schema AS schema_object
  WHERE (
      schema_object.type = 'table'
      AND schema_object.name IN (SELECT name FROM authoritative_tables)
    ) OR (
      schema_object.type IN ('index', 'trigger')
      AND schema_object.sql IS NOT NULL
      AND schema_object.tbl_name IN (SELECT name FROM authoritative_tables)
    )
  ORDER BY schema_object.name"

bad_object=$(sqlite3 -readonly "$DB_SRC" \
  "SELECT name FROM ($authoritative_objects_sql)
   WHERE name GLOB '*[^A-Za-z0-9_]*'
   LIMIT 1")
[ -z "$bad_object" ] || die "unsupported schema object name in backup set: $bad_object"

objects=$(sqlite3 -readonly "$DB_SRC" "$authoritative_objects_sql")
[ -n "$objects" ] || die "no authoritative tables found"
# Preserve AUTOINCREMENT high-water marks along with the selected tables.
objects=$(printf '%s\nsqlite_sequence\n' "$objects" | tr '\n' ' ')

WORK_DIR=$(mktemp -d /tmp/pim-backup.XXXXXX) || die "temporary directory creation failed"
ARCHIVE="$WORK_DIR/archive.sql.gz"
SHA_FILE="$WORK_DIR/archive.sql.gz.sha256"
FIFO="$WORK_DIR/dump.pipe"
mkfifo "$FIFO" || die "dump pipe creation failed"

log "streaming authoritative data from $DB_SRC"
gzip -c < "$FIFO" > "$ARCHIVE" &
GZIP_PID=$!
if ! sqlite3 -readonly "$DB_SRC" ".dump $objects" > "$FIFO"; then
  wait "$GZIP_PID" 2>/dev/null || true
  GZIP_PID=""
  die "sqlite dump failed"
fi
if ! wait "$GZIP_PID"; then
  GZIP_PID=""
  die "compression failed"
fi
GZIP_PID=""
rm -f "$FIFO"

gzip -t "$ARCHIVE" || die "compressed archive validation failed"
sha=$(sha256sum "$ARCHIVE" | cut -d' ' -f1)
printf '%s\n' "$sha" > "$SHA_FILE"

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
UTC_HOUR=$(date -u +%H)
UTC_WEEKDAY=$(date -u +%u)

upload_tier() {
  tier="$1"
  key="backups/$tier/pim-core-$TIMESTAMP.sql.gz"
  # Publish the checksum first. The SQL object is uploaded last so latest-key
  # discovery can never select a partially published backup pair.
  aws s3 cp "$SHA_FILE" "s3://$BUCKET/$key.sha256" --region "$REGION" --quiet
  aws s3 cp "$ARCHIVE" "s3://$BUCKET/$key" --region "$REGION" --quiet
  log "uploaded s3://$BUCKET/$key"
}

upload_tier hourly
if [ "$UTC_HOUR" = "00" ]; then
  upload_tier daily
  if [ "$UTC_WEEKDAY" = "7" ]; then
    upload_tier weekly
  fi
fi

log "complete (orgs=$org_count, compressed_bytes=$(wc -c < "$ARCHIVE" | tr -d ' '))"
