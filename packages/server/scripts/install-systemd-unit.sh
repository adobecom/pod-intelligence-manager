#!/bin/sh
set -eu

: "${PIM_DEPLOY_IMAGE:?PIM_DEPLOY_IMAGE is required}"
: "${PIM_DEPLOY_AWS_REGION:?PIM_DEPLOY_AWS_REGION is required}"
: "${PIM_DEPLOY_KG_BUCKET:?PIM_DEPLOY_KG_BUCKET is required}"
: "${PIM_DEPLOY_BACKUPS_BUCKET:?PIM_DEPLOY_BACKUPS_BUCKET is required}"
: "${PIM_DEPLOY_LOG_GROUP:?PIM_DEPLOY_LOG_GROUP is required}"
: "${PIM_DEPLOY_MEMORY_CUTOVER:?PIM_DEPLOY_MEMORY_CUTOVER is required}"

case "$PIM_DEPLOY_IMAGE" in
  [0-9]*.dkr.ecr.*.amazonaws.com/*@sha256:*) ;;
  *) echo "PIM_DEPLOY_IMAGE must be an immutable ECR digest reference" >&2; exit 1 ;;
esac
IMAGE_DIGEST=${PIM_DEPLOY_IMAGE##*@sha256:}
[ "${#IMAGE_DIGEST}" -eq 64 ] || { echo "PIM_DEPLOY_IMAGE digest must contain 64 hex characters" >&2; exit 1; }
case "$IMAGE_DIGEST" in *[!0-9a-f]*) echo "PIM_DEPLOY_IMAGE digest must be lowercase hex" >&2; exit 1 ;; esac
case "$PIM_DEPLOY_AWS_REGION" in *[!a-z0-9-]*|'') echo "Invalid AWS region" >&2; exit 1 ;; esac
case "$PIM_DEPLOY_KG_BUCKET" in *[!a-z0-9.-]*|'') echo "Invalid KG bucket" >&2; exit 1 ;; esac
case "$PIM_DEPLOY_BACKUPS_BUCKET" in *[!a-z0-9.-]*|'') echo "Invalid backups bucket" >&2; exit 1 ;; esac
case "$PIM_DEPLOY_LOG_GROUP" in *[!A-Za-z0-9_./#-]*|'') echo "Invalid log group" >&2; exit 1 ;; esac
case "$PIM_DEPLOY_MEMORY_CUTOVER" in true|false) ;; *) echo "Invalid cutover state" >&2; exit 1 ;; esac

UNIT_DIR=${PIM_DEPLOY_SYSTEMD_DIR:-/host-systemd}
case "$UNIT_DIR" in /*) ;; *) echo "Systemd target directory must be absolute" >&2; exit 1 ;; esac
[ ! -L "$UNIT_DIR" ] || { echo "Refusing a symlinked systemd target directory" >&2; exit 1; }
UNIT_PATH="$UNIT_DIR/pim-server.service"
[ -d "$UNIT_DIR" ] || { echo "Host systemd directory is not mounted" >&2; exit 1; }
[ ! -L "$UNIT_PATH" ] || { echo "Refusing to replace a symlinked unit" >&2; exit 1; }
UNIT_TMP=$(mktemp "$UNIT_DIR/.pim-server.service.XXXXXX")
trap 'rm -f "$UNIT_TMP"' EXIT

KG_MOUNT_MODE=rw
AUTHORITY_REQUIRED=0
if [ "$PIM_DEPLOY_MEMORY_CUTOVER" = true ]; then
  KG_MOUNT_MODE=ro
  AUTHORITY_REQUIRED=1
fi

cat > "$UNIT_TMP" <<EOF
[Unit]
Description=PIM Server
Requires=docker.service
After=docker.service
RequiresMountsFor=/data

[Service]
Restart=always
RestartSec=5
TimeoutStopSec=30
ExecStartPre=-/usr/bin/docker stop pim-server
ExecStartPre=-/usr/bin/docker rm pim-server
ExecStart=/usr/bin/docker run --rm --name pim-server -p 4000:4000 \\
  -v /data:/data \\
  -v /data/knowledge-graph:/data/knowledge-graph:$KG_MOUNT_MODE \\
  -e PIM_SSM_PATH=/pim/ \\
  -e AWS_REGION=$PIM_DEPLOY_AWS_REGION \\
  -e KG_S3_BUCKET=$PIM_DEPLOY_KG_BUCKET \\
  -e KG_S3_PREFIX=knowledge-graph \\
  -e PIM_BACKUPS_BUCKET=$PIM_DEPLOY_BACKUPS_BUCKET \\
  -e PIM_REQUIRE_RESTORE=true \\
  -e DB_PATH=/data/pim.db \\
  -e KG_DATA_DIR=/data/knowledge-graph \\
  -e PIM_MEMORY_REQUIRE_CANONICAL_AUTHORITY=$AUTHORITY_REQUIRED \\
  -e CORS_ORIGIN=* \\
  --log-driver=awslogs \\
  --log-opt awslogs-region=$PIM_DEPLOY_AWS_REGION \\
  --log-opt awslogs-group=$PIM_DEPLOY_LOG_GROUP \\
  --log-opt awslogs-create-group=true \\
  $PIM_DEPLOY_IMAGE
ExecStop=/usr/bin/docker stop pim-server

[Install]
WantedBy=multi-user.target
EOF

chmod 0644 "$UNIT_TMP"
mv "$UNIT_TMP" "$UNIT_PATH"
trap - EXIT
