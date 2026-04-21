#!/bin/sh
# Dumps the SQLite database to S3. Run on the EC2 host via cron, hourly.
# The knowledge graph is mirrored to S3 by the app itself via graph-storage
# writethrough when KG_S3_BUCKET is set, so this script covers only the DB.
#
# Required env:
#   PIM_BACKUPS_BUCKET   — target S3 bucket
# Optional env:
#   DB_PATH              — default /data/pim.db
#   AWS_REGION           — default us-west-2

set -eu

BUCKET="${PIM_BACKUPS_BUCKET:?PIM_BACKUPS_BUCKET env var is required}"
DB_SRC="${DB_PATH:-/data/pim.db}"
REGION="${AWS_REGION:-us-west-2}"

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
DUMP_PATH="/tmp/pim-backup-$TIMESTAMP.sql"
S3_KEY="backups/pim-$TIMESTAMP.sql.gz"

echo "[backup] Dumping $DB_SRC"
sqlite3 "$DB_SRC" ".dump" > "$DUMP_PATH"

echo "[backup] Compressing"
gzip "$DUMP_PATH"

echo "[backup] Uploading to s3://$BUCKET/$S3_KEY"
aws s3 cp "$DUMP_PATH.gz" "s3://$BUCKET/$S3_KEY" --region "$REGION"

rm -f "$DUMP_PATH.gz"
echo "[backup] Done"
