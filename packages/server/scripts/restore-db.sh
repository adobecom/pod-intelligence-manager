#!/bin/sh
# Restore the SQLite DB from S3 on a fresh volume, FAIL-CLOSED. Called by
# entrypoint.sh before the server starts.
#
# Why: new ASG instances get an empty /data. Nothing else reads the hourly backups
# back, and the knowledge-graph restore is driven by orgs read from THIS DB, so an
# unrestored DB means an empty PIM. This repopulates /data/pim.db and, when a
# restore is expected, refuses to let the server start empty so a broken restore
# never serves traffic or registers healthy behind the ALB (health can't 200 if the
# process never starts).
#
# Env:
#   DB_PATH                  default /data/pim.db
#   PIM_BACKUPS_BUCKET       S3 bucket holding backups/ (required to restore)
#   AWS_REGION               default us-west-2
#   PIM_REQUIRE_RESTORE      "true" => stateful host: refuse to start empty
#   PIM_RESTORE_KEY          exact S3 key to restore (e.g.
#                            backups/hourly/pim-core-...sql.gz); default: newest
#                            .sql.gz object anywhere under backups/
#   PIM_RESTORE_SHA256       if set, the downloaded object must match this sha256
#   PIM_RESTORE_MANIFEST_KEY if set, S3 key of a "table=count" manifest the restored
#                            DB must match exactly (else fail-closed)
set -eu

DB_PATH="${DB_PATH:-/data/pim.db}"
BUCKET="${PIM_BACKUPS_BUCKET:-}"
REGION="${AWS_REGION:-us-west-2}"
REQUIRE="${PIM_REQUIRE_RESTORE:-false}"

log()  { echo "[restore] $*"; }
die()  { echo "[restore][FATAL] $*" >&2; exit 1; }
# Fail-closed only when a restore is expected; otherwise allow a clean first-boot.
soft() { if [ "$REQUIRE" = "true" ]; then die "$1 (PIM_REQUIRE_RESTORE=true)"; fi; log "$1; starting with a fresh DB"; exit 0; }
count_orgs() { sqlite3 "$1" "SELECT count(*) FROM orgs" 2>/dev/null || echo 0; }

# Restore into a sibling file so a failed import or validation can never leave a
# populated DB_PATH that a systemd retry would mistake for a completed restore.
# Keeping the staging file beside DB_PATH also makes the final rename atomic.
STAGED_DB="${DB_PATH}.restore"
REBUILD_MARKER="${DB_PATH}.project-search-rebuild-required"
WORK_DIR=""
GUNZIP_PID=""
cleanup() {
    if [ -n "$GUNZIP_PID" ]; then
        kill "$GUNZIP_PID" 2>/dev/null || true
        wait "$GUNZIP_PID" 2>/dev/null || true
    fi
    if [ -n "$WORK_DIR" ]; then
        rm -f "$WORK_DIR/restore.sql.gz" "$WORK_DIR/restore.sql.gz.sha256" \
            "$WORK_DIR/manifest.txt" "$WORK_DIR/objects.txt" "$WORK_DIR/restore.pipe"
        rmdir "$WORK_DIR" 2>/dev/null || true
    fi
    if [ -n "${STAGED_DB:-}" ]; then
        rm -f "$STAGED_DB" "${STAGED_DB}-wal" "${STAGED_DB}-shm"
    fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

# Idempotent: never touch an already-populated volume.
existing=$(count_orgs "$DB_PATH")
if [ "${existing:-0}" -gt 0 ] 2>/dev/null; then
    log "DB already populated ($existing orgs); skipping restore"
    exit 0
fi

[ -n "$BUCKET" ] || soft "PIM_BACKUPS_BUCKET unset"
WORK_DIR=$(mktemp -d /tmp/pim-restore.XXXXXX) || die "temporary directory creation failed"
ARCHIVE="$WORK_DIR/restore.sql.gz"
CHECKSUM_FILE="$WORK_DIR/restore.sql.gz.sha256"
MANIFEST_FILE="$WORK_DIR/manifest.txt"
OBJECTS_FILE="$WORK_DIR/objects.txt"
FIFO="$WORK_DIR/restore.pipe"

# Resolve the key: exact if pinned, otherwise compare object LastModified values
# recursively. Tier prefixes make a plain lexical key comparison incorrect.
if [ -n "${PIM_RESTORE_KEY:-}" ]; then
    KEY="$PIM_RESTORE_KEY"
    log "using pinned key $KEY"
else
    if ! aws s3 ls "s3://$BUCKET/backups/" --recursive --region "$REGION" > "$OBJECTS_FILE"; then
        soft "backup listing failed under s3://$BUCKET/backups/"
    fi
    KEY=$(awk '$4 ~ /\.sql\.gz$/ { print $1, $2, $4 }' "$OBJECTS_FILE" \
        | sort -k1,2 | tail -n1 | awk '{ print $3 }')
    [ -n "$KEY" ] || soft "no backup under s3://$BUCKET/backups/"
    log "resolved latest key $KEY"
fi

case "$KEY" in
    */pim-core-*.sql.gz|pim-core-*.sql.gz) CORE_RESTORE="true" ;;
    *) CORE_RESTORE="false" ;;
esac

aws s3 cp "s3://$BUCKET/$KEY" "$ARCHIVE" --region "$REGION" --quiet \
    || die "download failed: s3://$BUCKET/$KEY"

# New core backups always publish a checksum sidecar. A caller-provided checksum
# still takes precedence for a pinned, operator-verified migration backup.
EXPECTED_SHA="${PIM_RESTORE_SHA256:-}"
if [ -z "$EXPECTED_SHA" ]; then
    if aws s3 cp "s3://$BUCKET/$KEY.sha256" "$CHECKSUM_FILE" --region "$REGION" --quiet 2>/dev/null; then
        EXPECTED_SHA=$(awk 'NR == 1 { print $1 }' "$CHECKSUM_FILE")
    elif [ "$CORE_RESTORE" = "true" ]; then
        die "checksum sidecar missing: s3://$BUCKET/$KEY.sha256"
    else
        log "legacy backup has no checksum sidecar; relying on gzip + SQLite integrity checks"
    fi
fi

if [ -n "$EXPECTED_SHA" ]; then
    case "$EXPECTED_SHA" in *[!0-9A-Fa-f]*) die "invalid sha256 value" ;; esac
    [ "${#EXPECTED_SHA}" -eq 64 ] || die "invalid sha256 length"
    EXPECTED_SHA=$(printf '%s' "$EXPECTED_SHA" | tr 'A-F' 'a-f')
    got=$(sha256sum "$ARCHIVE" | cut -d' ' -f1)
    [ "$got" = "$EXPECTED_SHA" ] || die "checksum mismatch: got=$got want=$EXPECTED_SHA"
    log "checksum verified"
fi

gzip -t "$ARCHIVE" || die "compressed archive validation failed"
rm -f "$STAGED_DB" "${STAGED_DB}-wal" "${STAGED_DB}-shm"
mkfifo "$FIFO" || die "restore pipe creation failed"
gzip -dc "$ARCHIVE" > "$FIFO" &
GUNZIP_PID=$!
if ! sqlite3 -bail "$STAGED_DB" < "$FIFO"; then
    wait "$GUNZIP_PID" 2>/dev/null || true
    GUNZIP_PID=""
    die "sqlite import failed"
fi
if ! wait "$GUNZIP_PID"; then
    GUNZIP_PID=""
    die "decompression failed"
fi
GUNZIP_PID=""
rm -f "$FIFO"

ic=$(sqlite3 "$STAGED_DB" "PRAGMA integrity_check" 2>/dev/null || echo error)
[ "$ic" = "ok" ] || die "integrity_check failed: $ic"

orgs=$(count_orgs "$STAGED_DB")
[ "${orgs:-0}" -gt 0 ] 2>/dev/null || die "restored DB has 0 orgs"
log "restored orgs=$orgs, integrity ok"

# Optional manifest gate: restored counts must EXACTLY match the pre-shutdown
# manifest (lines "table=count"). Fail-closed on any mismatch.
if [ -n "${PIM_RESTORE_MANIFEST_KEY:-}" ]; then
    aws s3 cp "s3://$BUCKET/$PIM_RESTORE_MANIFEST_KEY" "$MANIFEST_FILE" --region "$REGION" --quiet \
        || die "manifest download failed: $PIM_RESTORE_MANIFEST_KEY"
    while IFS='=' read -r tbl want; do
        [ -n "${tbl:-}" ] || continue
        case "$tbl" in \#*) continue ;; esac
        case "$tbl" in *[!A-Za-z0-9_]*) die "manifest contains invalid table name: $tbl" ;; esac
        got=$(sqlite3 "$STAGED_DB" "SELECT count(*) FROM \"$tbl\"" 2>/dev/null || echo ERR)
        [ "$got" = "$want" ] || die "manifest mismatch: $tbl got=$got want=$want"
    done < "$MANIFEST_FILE"
    rm -f "$MANIFEST_FILE"
    log "manifest gate passed"
fi

# All gates passed. Remove stale SQLite sidecars from an empty/failed predecessor,
# then atomically publish the validated DB. Clear STAGED_DB so the EXIT trap does
# not remove the file after it has become DB_PATH.
rm -f "${DB_PATH}-wal" "${DB_PATH}-shm"
if [ "$CORE_RESTORE" = "true" ]; then
    # Core dumps deliberately omit the rebuildable project_search_* tables.
    # createTables() recreates their schema and server startup consumes this
    # marker to rebuild lexical/graph rows from authoritative evidence/context.
    touch "$REBUILD_MARKER" || die "failed to create project-search rebuild marker"
fi
mv -f "$STAGED_DB" "$DB_PATH" || die "failed to publish validated DB"
STAGED_DB=""
if [ "$CORE_RESTORE" = "true" ]; then
    log "restore complete (validated core DB published; project-search rebuild requested)"
else
    log "restore complete (validated DB published atomically)"
fi
