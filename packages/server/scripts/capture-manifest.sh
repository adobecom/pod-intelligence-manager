#!/bin/sh
# Capture a data manifest from a SQLite DB for pre/post-migration verification.
#
# Emits one "table=count" line per table (consumed by restore-db.sh's manifest
# gate — an EXACT match is required) plus "# ..." comment lines for human review
# (the gate skips lines starting with #).
#
# Run it against the VERIFIED backup loaded into a temp DB (so the manifest matches
# exactly what will be restored), and again against the restored DB after cutover;
# the two must be identical (the app is stopped, so there is no legitimate growth).
#
# Usage: capture-manifest.sh [db_path]   # prints manifest to stdout
set -eu
DB="${1:-${DB_PATH:-/data/pim.db}}"

# Per-table counts (drive the gate).
sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name" \
  | while read -r t; do
      [ -n "$t" ] || continue
      echo "$t=$(sqlite3 "$DB" "SELECT count(*) FROM \"$t\"")"
    done

# Human-review context (ignored by the gate).
echo "# captured=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "# sqlite=$(sqlite3 "$DB" 'SELECT sqlite_version()')"
echo "# org_ids=$(sqlite3 "$DB" 'SELECT group_concat(org_id) FROM orgs' 2>/dev/null || echo '?')"

# Best-effort max timestamps (column names vary; '?' if absent).
for pair in "pods:updated_at" "conflicts:created_at" "context_updates:created_at" "knowledge_nodes:created_at"; do
    tbl=${pair%%:*}; col=${pair##*:}
    echo "# max_${tbl}_${col}=$(sqlite3 "$DB" "SELECT max(\"$col\") FROM \"$tbl\"" 2>/dev/null || echo '?')"
done
