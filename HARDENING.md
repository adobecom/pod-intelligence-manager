# Hardening Checklist

Remaining work to take AI Council from "works locally" to production-ready. Each section is scoped for one agent session. Items marked [DONE] were completed — they're kept here for context so you understand what's already in place.

---

## Tier 1 — Credibility [DONE]

These were completed and can be used as reference for patterns.

- [x] **Unit tests** — vitest set up in `packages/server`, 35 tests covering `quality-scoring.ts`, `secret-scan.ts`, and `lint.ts`. Pattern: mock `db` via `vi.mock("../../db/connection.js")`, test pure logic in isolation. Config: `packages/server/vitest.config.ts`. Run: `pnpm test`.
- [x] **Request validation** — Zod schemas + `validateBody()` preHandler middleware applied to all POST routes. Middleware at `packages/server/src/middleware/validation.ts`. Each route file defines its own schema at the top and passes `{ preHandler: validateBody(Schema) }` as route options.
- [x] **Health check** — `GET /api/health` at `packages/server/src/index.ts` verifies DB connectivity, returns `{ status, started_at, uptime_seconds, db: { connected, active_pods } }`. Returns 503 if DB is unreachable.

---

## Tier 2 — Production Readiness

### 2a. Global Error Handler
**Scope:** `packages/server/src/index.ts`
**What:** Add a Fastify `setErrorHandler` that catches unhandled throws across all routes. Currently, unhandled errors return raw stack traces to the client.
**How:**
```ts
app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  reply.code(error.statusCode ?? 500).send({
    error: error.message ?? "Internal server error",
  });
});
```
**Watch out for:** Don't swallow validation errors from the Zod middleware — those already send 400 via `reply.send()` before the error handler runs.

### 2b. Auth Middleware Skeleton
**Scope:** New file `packages/server/src/middleware/auth.ts`, wire into `index.ts`
**What:** A pluggable `authenticate` preHandler hook that reads a bearer token from `Authorization` header and attaches `req.user`. For now, implement a "trust all" mode that sets a default user. The seam should make it trivial to swap in Adobe IMS JWT verification later.
**How:** Export a `createAuthHook(mode: "trust" | "ims")` factory. In trust mode, always set `req.user = { id: "anonymous", roles: ["admin"] }`. Register as a global preHandler on the Fastify instance. Protect write routes (POST/PUT/DELETE) only — leave GETs open.
**Spec reference:** SPEC.md mentions Adobe IMS for auth. The IMS verification itself is out of scope — just build the hook shape.

### 2c. CORS Configuration
**Scope:** `packages/server/src/index.ts`
**What:** Install `@fastify/cors` and register it. In dev, allow `localhost:5173`. In production, allow the deployed domain only.
**How:**
```
pnpm add @fastify/cors --filter @council/server
```
```ts
import cors from "@fastify/cors";
app.register(cors, {
  origin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
});
```

### 2d. Rate Limiting
**Scope:** `packages/server/src/index.ts`
**What:** Install `@fastify/rate-limit`. Apply a global 100 req/min limit. Apply a stricter 20 req/min limit to `POST /api/pods/:podId/context-updates` to prevent runaway agents from flooding the ingestion pipeline.
**How:**
```
pnpm add @fastify/rate-limit --filter @council/server
```

---

## Tier 3 — Testing & Demo Polish

### 3a. Expand Test Coverage
**Scope:** `packages/server/src/services/__tests__/`, `packages/server/src/council/agents/__tests__/`
**What:** Add tests for:
- `ingestion.ts` — mock db + broadcast + processUpdate, test Zod validation, secret rejection, quality score attachment
- `pressure.ts` — test pressure recalculation formula
- `merge.ts` + `classifier.ts` — test deterministic classification and merge logic
- `conflict.ts` — test conflict creation with mocked LLM
- `summary.ts` — test living doc regeneration, regen_count increment

**Pattern to follow:** See `quality-scoring.test.ts` for db mocking. See `lint.test.ts` for sequential mock setup.

### 3b. SDK + CLI Tests
**Scope:** `packages/sdk/`, `packages/cli/`
**What:** Add vitest to both packages. The SDK client methods are thin wrappers over fetch — test with mocked fetch. The CLI commands parse args and call SDK methods — test arg parsing and output formatting.
**How:** Same vitest setup pattern as `packages/server/vitest.config.ts`. Copy the config, add vitest to devDependencies.

### 3c. Integration / E2E Tests
**Scope:** New `packages/server/src/__tests__/` directory
**What:** Spin up a real Fastify instance with in-memory SQLite, hit actual endpoints, verify the full pipeline (submit update -> council routes -> living doc regenerated -> WS event).
**How:** Use Fastify's `inject()` method for in-process HTTP testing. Override the db connection to use `:memory:`. This avoids port conflicts and is fast.

### 3d. Infra Package — CDK Stacks
**Scope:** `packages/infra/`
**What:** Define basic CDK stacks for:
- API Gateway (REST + WebSocket)
- Lambda functions (one per route group)
- DynamoDB tables (matching current SQLite schema)
- S3 buckets (living docs, knowledge graph snapshots)
- CloudFront + S3 for UI hosting
**Spec reference:** See the AWS Service Map in CLAUDE.md for the full target architecture.

### 3e. CI/CD Pipeline
**Scope:** `.github/workflows/`
**What:** GitHub Actions workflow:
- On PR: typecheck, test, build
- On merge to main: deploy to staging
**How:** Use `pnpm` + turbo caching for fast CI. The monorepo test command is `pnpm test`.

---

## Notes for Agents

- The project uses **pnpm workspaces** + **turborepo**. Package names: `@council/server`, `@council/shared`, `@council/sdk`, `@council/cli`, `@council/ui`.
- Zod is already a dependency in `@council/server` — no need to install it.
- The DB is SQLite via `better-sqlite3` with WAL mode. Connection at `packages/server/src/db/connection.ts`.
- WebSocket broadcasting: import `broadcast` from `packages/server/src/ws/index.ts`.
- All route files follow the same Fastify plugin pattern: `export default async function xxxRoutes(app: FastifyInstance)`.
- Validation middleware pattern: define Zod schema at top of route file, pass `{ preHandler: validateBody(Schema) }` as route options.
