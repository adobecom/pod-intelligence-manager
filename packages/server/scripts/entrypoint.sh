#!/bin/sh
# Container entrypoint. Fetches secrets from SSM if PIM_SSM_PATH is set, then
# ensures data directories exist and execs the Node server. tini (PID 1) handles
# signal forwarding so the Node process receives SIGTERM cleanly on docker stop.

set -e

if [ -n "${PIM_SSM_PATH:-}" ]; then
    . /app/packages/server/scripts/fetch-secrets.sh
fi

DB_PATH="${DB_PATH:-/data/pim.db}"
KG_DATA_DIR="${KG_DATA_DIR:-/data/knowledge-graph}"
mkdir -p "$(dirname "$DB_PATH")" "$KG_DATA_DIR"

# Restore the SQLite DB from S3 before the server starts, FAIL-CLOSED. Runs as a
# child process so a restore failure (set -eu in restore-db.sh) propagates here via
# `set -e` and stops boot — a broken or empty DB then never serves traffic or
# registers healthy behind the ALB. Policy (exact key / checksum / integrity /
# manifest gate / fresh-env escape) lives in restore-db.sh.
sh /app/packages/server/scripts/restore-db.sh

# Server runs via tsx (TypeScript runtime). tsx is a dev dep installed in the
# server package's node_modules by pnpm install in the Dockerfile build stage.
exec /app/packages/server/node_modules/.bin/tsx /app/packages/server/src/index.ts
