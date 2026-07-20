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
#   PIM_RESTORE_KEY          exact S3 key to restore (e.g. backups/pim-...sql.gz);
#                            default: lexically-greatest key under backups/
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
cleanup() {
    rm -f /tmp/restore.sql.gz /tmp/restore.sql /tmp/manifest.txt
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

# Resolve the key: exact if pinned, else the lexically-greatest (== chronological).
if [ -n "${PIM_RESTORE_KEY:-}" ]; then
    KEY="$PIM_RESTORE_KEY"
    log "using pinned key $KEY"
else
    name=$(aws s3 ls "s3://$BUCKET/backups/" --region "$REGION" \
        | tr -s ' ' | cut -d' ' -f4 | grep -E '\.sql\.gz$' | sort | tail -n1 || true)
    [ -n "$name" ] || soft "no backup under s3://$BUCKET/backups/"
    KEY="backups/$name"
    log "resolved latest key $KEY"
fi

aws s3 cp "s3://$BUCKET/$KEY" /tmp/restore.sql.gz --region "$REGION" --quiet \
    || die "download failed: s3://$BUCKET/$KEY"

if [ -n "${PIM_RESTORE_SHA256:-}" ]; then
    got=$(sha256sum /tmp/restore.sql.gz | cut -d' ' -f1)
    [ "$got" = "$PIM_RESTORE_SHA256" ] || die "checksum mismatch: got=$got want=$PIM_RESTORE_SHA256"
    log "checksum verified"
fi

gunzip -f /tmp/restore.sql.gz || die "gunzip failed"
rm -f "$STAGED_DB" "${STAGED_DB}-wal" "${STAGED_DB}-shm"
sqlite3 -bail "$STAGED_DB" < /tmp/restore.sql || die "sqlite import failed"

ic=$(sqlite3 "$STAGED_DB" "PRAGMA integrity_check" 2>/dev/null || echo error)
[ "$ic" = "ok" ] || die "integrity_check failed: $ic"

orgs=$(count_orgs "$STAGED_DB")
[ "${orgs:-0}" -gt 0 ] 2>/dev/null || die "restored DB has 0 orgs"
log "restored orgs=$orgs, integrity ok"

# Optional manifest gate: restored counts must EXACTLY match the pre-shutdown
# manifest (lines "table=count"). Fail-closed on any mismatch.
if [ -n "${PIM_RESTORE_MANIFEST_KEY:-}" ]; then
    aws s3 cp "s3://$BUCKET/$PIM_RESTORE_MANIFEST_KEY" /tmp/manifest.txt --region "$REGION" --quiet \
        || die "manifest download failed: $PIM_RESTORE_MANIFEST_KEY"
    while IFS='=' read -r tbl want; do
        [ -n "${tbl:-}" ] || continue
        case "$tbl" in \#*) continue ;; esac
        got=$(sqlite3 "$STAGED_DB" "SELECT count(*) FROM \"$tbl\"" 2>/dev/null || echo ERR)
        [ "$got" = "$want" ] || die "manifest mismatch: $tbl got=$got want=$want"
    done < /tmp/manifest.txt
    rm -f /tmp/manifest.txt
    log "manifest gate passed"
fi

# All gates passed. Remove stale SQLite sidecars from an empty/failed predecessor,
# then atomically publish the validated DB. Clear STAGED_DB so the EXIT trap does
# not remove the file after it has become DB_PATH.
rm -f "${DB_PATH}-wal" "${DB_PATH}-shm"
mv -f "$STAGED_DB" "$DB_PATH" || die "failed to publish validated DB"
STAGED_DB=""
log "restore complete (validated DB published atomically)"
