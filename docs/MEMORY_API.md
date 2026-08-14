# PIM canonical memory API

**Status:** current implemented surface as of 2026-08-13

PIM exposes a v1 compatibility API and a strict v2 API over one canonical SQLite memory estate.
HTTP v2 is the source-of-truth transport for new consumers. The restricted MCP companion delegates
to the same services and does not own separate storage, ranking, authorization, or lifecycle rules.

Generated JSON Schemas in `packages/shared/contracts` and the parsers/types generated from them are
the wire-contract source of truth.

## Supported planes

| Plane | Status | Exact resource |
| --- | --- | --- |
| `codebase` | available | canonical GitHub repository plus code applicability |
| `harness` | available | canonical harness, principal, and configuration applicability |

Content and organization planes are not implemented in v2. Unknown/unavailable planes fail closed
and do not fall back to codebase, harness, v1, or the legacy graph.

## V2 HTTP endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v2/memory/capabilities` | Contract revision, planes, operations, schemas, limits, and MCP surface |
| `GET` | `/api/v2/memory/binding` | Non-secret effective binding for the authenticated service principal |
| `GET` | `/api/v2/memory/readiness` | Bounded reverification/worker readiness for one authorized resource |
| `POST` | `/api/v2/memory/search` | Codebase or harness search; creates/replays one immutable retrieval pack |
| `GET` | `/api/v2/memory/records/:record_id?version=N` | One exact immutable record version |
| `GET` | `/api/v2/memory/records/:record_id/history` | Authorized immutable lifecycle history |
| `GET` | `/api/v2/memory/packs/:pack_id` | One exact immutable retrieval pack |
| `PUT` | `/api/v2/memory/run-receipts/:producer_run_id` | Idempotent receipt and bounded candidate submission |
| `POST` | `/api/v2/memory/feedback` | Idempotent codebase pack-bound feedback |
| `GET` | `/api/v2/memory/candidates/:candidate_id` | Bound codebase or producer-bound harness candidate status |
| `POST` | `/api/v2/memory/candidates/:candidate_id/decisions` | Authorized HTTP review/control-plane decision |

Receipt and feedback writes require an `Idempotency-Key`. The same identity and canonical digest
replay the stored result; changed content conflicts. Search request identities have the same
immutable replay rule for packs.

Private responses use `Cache-Control: private, no-store` and `Vary: Authorization` where relevant.
Errors use the generated `pim.error.v2` envelope and avoid enumerating resources across an
authorization boundary.

## V1 compatibility endpoints

The supported v1 surface remains available for migrated and existing callers:

- `GET /api/v1/memory/capabilities`
- `POST /api/v1/memory/search`
- `GET /api/v1/memory/records/:record_id`
- `GET /api/v1/memory/records/:record_id/history`
- `PUT /api/v1/memory/run-receipts/:producer_run_id`
- `GET /api/v1/memory/candidates/:candidate_id`
- `POST /api/v1/memory/attestations/github`
- `POST /api/v1/memory/feedback`
- `POST /api/v1/memory/candidates/:candidate_id/decisions`
- `POST /api/v1/memory/harness/search`

The former prompt-policy, release-gate, benchmark, canary, and kill-switch endpoints were removed
during the Memory v2 simplification. Do not build new consumers against those deleted paths or
retain them in operational runbooks.

## Authorization model

Memory calls use a PIM service token. Server-side token rows bind the credential to an organization
and optional project/pod, permitted scopes, and exact Memory v2 resources/operations.

Common v2 scopes include:

| Scope | Grants within the exact binding |
| --- | --- |
| `memory:search` | codebase search, detail/history, pack, and readiness |
| `memory:receipt:write` | codebase receipt/candidate submission |
| `memory:candidate:read` | codebase candidate status |
| `memory:attest` | separately bounded codebase attestation ingress |
| `memory:feedback:write` | codebase feedback |
| `memory:review` | codebase review/activation decisions |
| `memory:harness:search` | harness search, detail/history, pack, and readiness |
| `memory:harness:receipt:write` | harness receipt/candidate submission |
| `memory:harness:candidate:read` | harness candidate status |
| `memory:harness:review` | harness review/activation decisions |

The token is the upper bound. Organization/project headers, request bodies, path IDs, repository
names, harness IDs, and resource selectors are never accepted as independent authority.

Codebase resolution accepts exact canonical repository identities. Local paths, leaf names, branch
names, fuzzy remotes, and unbound legacy tokens cannot substitute. Harness and codebase bindings
cannot substitute for one another.

## Search and immutable packs

Search applies authorization, exact resource applicability, lifecycle, trust/reverification, and
contract compatibility before ranking. Results include bounded match reasons, token counts,
omission counts, and a `retrieval_pack_id`.

The pack is the immutable record of what was returned. Reading it later reauthorizes the caller;
possessing a pack or record ID is not authority. Record and pack resources are non-enumerable.

## Receipts, candidates, and review

Producers submit a typed receipt with a stable producer run, scope snapshot, resource binding,
artifacts/evidence, and bounded candidate proposals. PIM validates the entire receipt before any
write and commits receipt/candidate/origin companions atomically.

Candidates do not become active merely because a model proposed them. Codebase evidence is bound
to the exact repository and provider facts. Harness evidence preserves root runtime origins,
derivation, producer identity, run identity, and configuration scope. Authorized HTTP reviewers may
approve/reject candidates when structural and evidence gates pass.

## Restricted MCP companion

`POST /mcp/memory` implements stateless MCP protocol version `2026-07-28`. It requires the private
PIM service-token profile and modern protocol headers.

Its complete tool set is:

| Tool | Behavior |
| --- | --- |
| `pim_memory_capabilities` | Auth-filtered v2 capability discovery |
| `pim_memory_binding` | Non-secret effective binding |
| `pim_code_memory_search` | Exact codebase search |
| `pim_harness_memory_search` | Exact harness search |
| `pim_run_receipt_submit` | Codebase or harness receipt submission |
| `pim_feedback_submit` | Supported pack-bound feedback |
| `pim_candidate_status` | Bound candidate status |
| `pim_memory_readiness` | Resource readiness |

Resource templates:

- `pim-memory://records/{record_id}/versions/{version}`
- `pim-memory://packs/{pack_id}`

There is no list operation for records or packs. Discovery is recomputed for the credential.
Candidate review/activation, token/resource administration, and runtime-attestation control are
excluded from MCP.

See [MCP_A_PRIVATE_PIM_SERVICE_TOKEN_PROFILE.md](./MCP_A_PRIVATE_PIM_SERVICE_TOKEN_PROFILE.md).
Transport parity is enforced by the `memory-v2-code-*-parity`, `memory-mcp`, and
`memory-v2-conformance-live` server test suites rather than a separately maintained report.

## SDK

`PimMemoryV2Client` in `@pim/sdk` strictly parses requests and responses and exposes:

- `capabilities()` and `binding()`;
- `readiness()`;
- `searchCode()` and `searchHarness()`;
- `getRecord()`, `getRecordHistory()`, and `getPack()`;
- `putRunReceipt()` and `submitFeedback()`;
- `getCandidate()` and `getHarnessCandidate()`; and
- `decideCandidate()` for HTTP control-plane review.

Contract changes must start at the shared schema/generator roots. Verify them with:

```sh
pnpm --filter @pim/shared contracts:check
pnpm --filter @pim/sdk test
pnpm --filter @pim/mcp-server test
```

## Availability and compatibility

At startup, PIM runs v2 migrations, resource/facet reconciliation, reverification admission, and
validation. If that chain fails, Memory v2 and `/mcp/memory` return a bounded retryable unavailable
error while unrelated PIM routes remain available.

V1 and v2 share canonical records; v2 is not a disconnected database. Safely representable v1
records receive v2 facets. Ambiguous/unmapped legacy data remains preserved but cannot be guessed
into the v2 serving set.
