# syntax=docker/dockerfile:1.7
# Build context = repo root. Build with:
#   docker build --platform linux/amd64 -f packages/server/Dockerfile -t pim-server .
#
# This project runs the server via tsx (TypeScript runtime), while workspace
# dependencies @pim/shared and @pim/mcp-server publish compiled files from dist.
# The build context intentionally excludes dist, so rebuild both after install.

# ---------- Build / install stage ----------
FROM --platform=linux/amd64 node:22-alpine AS build

WORKDIR /repo

# Build toolchain for pnpm (optional native deps). The server uses Node.js built-in SQLite (`node:sqlite`).
RUN apk add --no-cache python3 make g++ libc6-compat

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @pim/shared build
RUN pnpm --filter @pim/mcp-server build

# ---------- Runtime stage ----------
FROM --platform=linux/amd64 node:22-alpine AS runtime

WORKDIR /app

# sqlite CLI for backup.sh, aws-cli for SSM parameter fetch, tini for PID-1 signal handling
RUN apk add --no-cache sqlite aws-cli ca-certificates tini libc6-compat

COPY --from=build /repo /app

RUN chmod +x /app/packages/server/scripts/*.sh

ENV NODE_ENV=production \
    PORT=4000 \
    DB_PATH=/data/pim.db \
    KG_DATA_DIR=/data/knowledge-graph

WORKDIR /app/packages/server

EXPOSE 4000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/packages/server/scripts/entrypoint.sh"]
