# Hardening Checklist

Remaining work to take AI Council from "works locally" to production-ready. Each section is scoped for one agent session. Items marked [DONE] were completed — they're kept here for context so you understand what's already in place.

---

## Tier 1 — Credibility [DONE]

These were completed and can be used as reference for patterns.

- [x] **Unit tests** — vitest set up in `packages/server`, 35 tests covering `quality-scoring.ts`, `secret-scan.ts`, and `lint.ts`. Pattern: mock `db` via `vi.mock("../../db/connection.js")`, test pure logic in isolation. Config: `packages/server/vitest.config.ts`. Run: `pnpm test`.
- [x] **Request validation** — Zod schemas + `validateBody()` preHandler middleware applied to all POST routes. Middleware at `packages/server/src/middleware/validation.ts`. Each route file defines its own schema at the top and passes `{ preHandler: validateBody(Schema) }` as route options.
- [x] **Health check** — `GET /api/health` at `packages/server/src/index.ts` verifies DB connectivity, returns `{ status, started_at, uptime_seconds, db: { connected, active_pods } }`. Returns 503 if DB is unreachable.

---

## Tier 2 — Production Readiness [DONE]

- [x] **Global error handler** — `app.setErrorHandler` in `packages/server/src/index.ts`. Catches unhandled throws, logs via request.log.error, returns structured `{ error }` without stack traces. 5xx hides message, 4xx exposes it. Guards against double-send via `reply.sent` check. Zod validation errors (from `validateBody`) send 400 directly and never reach the handler.
- [x] **Auth middleware skeleton** — `packages/server/src/middleware/auth.ts` exports `createAuthHook(mode: "trust" | "ims")`. Trust mode sets `req.user = { id: "anonymous", roles: ["admin"] }`. IMS mode checks `Authorization: Bearer` header (IMS JWT verification is TODO). Registered as global `onRequest` hook gated on `POST/PUT/DELETE/PATCH` methods. GETs remain open. Controlled via `AUTH_MODE` env var.
- [x] **CORS configuration** — `@fastify/cors` registered in `index.ts`. Origin from `CORS_ORIGIN` env var, defaults to `http://localhost:5173`.
- [x] **Rate limiting** — `@fastify/rate-limit` registered in `index.ts`. Global 100 req/min. Route-level 20 req/min on `POST /api/pods/:podId/context-updates` via `config.rateLimit` in `packages/server/src/routes/context-updates.ts`.

---

## Tier 3 — Testing & Demo Polish [DONE]

- [x] **Expanded test coverage (3a)** — 6 new test files, 63 new tests:
  - `services/__tests__/ingestion.test.ts` (10 tests) — Zod validation, pod lookup, secret rejection, quality scoring, DB write, WS broadcast, council processing
  - `services/__tests__/pressure.test.ts` (7 tests) — formula: base per conflict (0.15 blocking, 0.08 non-blocking) + age bonus (capped 0.1), clamp to [0,1], table updates
  - `council/__tests__/classifier.test.ts` (8 tests) — additive/overlapping/contradictory classification, keyword overlap threshold (3+), pressure gate (>0.6)
  - `council/agents/__tests__/merge.test.ts` (8 tests) — deterministic merge, LLM merge with auto_merge/merge_with_note/escalate_conflict, fallback on error/null
  - `council/agents/__tests__/conflict.test.ts` (7 tests) — null when no conflicting update, deterministic summary, id format, DB transaction, broadcast x2, Slack notifications
  - `council/agents/__tests__/summary.test.ts` (12 tests) — not-found pod, markdown sections (health, milestone, conflicts, decisions, context stream, tunnels, knowledge), DB upsert, broadcast
- [x] **SDK + CLI tests (3b)** — vitest added to both packages with configs. `packages/sdk/src/__tests__/client.test.ts` (11 tests) mocks `globalThis.fetch`, tests all CouncilClient methods. `packages/cli/src/__tests__/commands.test.ts` (7 tests) tests command registration and required options.
- [x] **Integration tests (3c)** — `packages/server/src/__tests__/integration.test.ts` (11 tests). Uses Fastify `inject()` with in-memory SQLite via `vi.hoisted()`. Tests: pod CRUD, context-update ingestion, validation rejection, living doc generation, conflict list, overlapping classification.
- [x] **CDK stacks (3d)** — `packages/infra/lib/council-stack.ts`. Defines: 7 DynamoDB tables with GSIs, 3 S3 buckets (versioned living-docs + knowledge-graph, static UI), 6 Lambda functions, REST + WebSocket API Gateways, CloudFront distribution (SPA + API), EventBridge scheduled rules (escalation 5min, lint 2hr).
- [x] **CI/CD pipeline (3e)** — `.github/workflows/ci.yml`. On PR: typecheck → test → build. On merge to main: deploy staging via CDK with OIDC AWS credentials.

---

## Notes for Agents

- The project uses **pnpm workspaces** + **turborepo**. Package names: `@council/server`, `@council/shared`, `@council/sdk`, `@council/cli`, `@council/ui`.
- Zod is already a dependency in `@council/server` — no need to install it.
- The DB is SQLite via `better-sqlite3` with WAL mode. Connection at `packages/server/src/db/connection.ts`.
- WebSocket broadcasting: import `broadcast` from `packages/server/src/ws/index.ts`.
- All route files follow the same Fastify plugin pattern: `export default async function xxxRoutes(app: FastifyInstance)`.
- Validation middleware pattern: define Zod schema at top of route file, pass `{ preHandler: validateBody(Schema) }` as route options.
