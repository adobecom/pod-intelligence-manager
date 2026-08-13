# PIM Memory v2 HTTP/MCP conformance

**Status:** current verification matrix as of 2026-08-13

**Protocol:** stateless MCP `2026-07-28`

**Canonical transport:** HTTP v2

This document defines the transport-parity boundary and the tests that verify it. It does not claim
that MCP and HTTP use identical framing or status codes: MCP uses JSON-RPC results while HTTP uses
HTTP status plus JSON. Both normalize to the same generated domain contracts and `PimErrorV2`
semantics.

## Current surface

The restricted MCP companion contains exactly eight tools:

| MCP tool | Canonical domain behavior |
| --- | --- |
| `pim_memory_capabilities` | v2 capabilities |
| `pim_memory_binding` | non-secret effective service-token binding |
| `pim_code_memory_search` | exact-resource codebase search |
| `pim_harness_memory_search` | exact-resource harness search |
| `pim_run_receipt_submit` | idempotent codebase or harness receipt |
| `pim_feedback_submit` | supported pack-bound feedback |
| `pim_candidate_status` | bound candidate status |
| `pim_memory_readiness` | bounded resource readiness |

Its only resource templates are:

- `pim-memory://records/{record_id}/versions/{version}`
- `pim-memory://packs/{pack_id}`

Resources are non-enumerable and reauthorized on every read. Candidate review/activation, token and
resource administration, runtime-attestation control, and general record-lifecycle administration
are not MCP operations.

The earlier PIM-managed exposure-policy, release-gate, canary, benchmark, and kill-switch subsystem
was removed. Conformance tests assert representative names from those deleted control categories
remain unavailable through MCP; there is no enabled-canary parity row.

## Required parity

| Boundary | What must match |
| --- | --- |
| Capabilities and binding | Auth-filtered discovery, exact principal/project/plane/resource binding, no secrets |
| Codebase search | Ordered results, match reasons, budgets, omissions, lifecycle filters, immutable pack replay/conflict, and non-enumerating denials |
| Harness search | Exact harness selectors, ordered results, budgets, packs, errors, and zero cross-plane fallback |
| Record and pack resources | Exact versions/pack bytes after fresh authorization; no list surface |
| Receipts | Canonical effects, candidate pointers, idempotent replay, changed-digest conflict, ambiguous-response retry, and transaction rollback |
| Feedback | Exact pack/snapshot binding, replay/conflict behavior, and unsupported-plane closure |
| Candidate status | Exact codebase binding or producer-bound harness lookup without enumeration |
| Readiness | Same bounded state apart from time-of-check fields, with unavailable/denied behavior aligned |
| Security | Private profile, fixed endpoint/audience/resource, modern headers, unknown-field rejection, input-size cap, rate limit, POST-only stateless transport |
| Observability | Bounded outcome/latency dimensions and redacted audit data; never credentials or request bodies |

## Evidence map

| Test file | Coverage |
| --- | --- |
| `packages/mcp-server/test/memory.test.ts` | Adapter discovery, generated validation, delegation, error redaction, resource templates, modern-only protocol, and auth-filtered catalog |
| `packages/server/src/routes/__tests__/memory-mcp.test.ts` | Private token profile, binding isolation, real route/MCP reads and writes, idempotency, revocation, readiness, rate limits, metrics, and audit redaction |
| `packages/server/src/routes/__tests__/memory-v2-code-read-parity.test.ts` | v1/direct-v2/MCP code-read quality, ordering, budgets, lifecycle, aliases, denials, audit effects, and latency envelope |
| `packages/server/src/routes/__tests__/memory-v2-code-write-parity.test.ts` | v1/direct-v2/MCP receipt, feedback, candidate, replay/conflict, and canonical-effect parity |
| `packages/server/src/routes/__tests__/memory-v2-conformance-live.test.ts` | Full codebase/harness × HTTP/MCP matrix through loopback HTTP adapters |
| `packages/sdk/src/__tests__/memory-v2-client.test.ts` | Strict SDK request construction, response parsing, and bounded errors |

Additional v2 route and service suites cover codebase/harness read/write, startup availability,
resource facets, runtime origins, reverification, and atomic writers.

## Verification commands

Run from the repository root:

```sh
pnpm --filter @pim/shared contracts:check
pnpm --filter @pim/mcp-server test

pnpm --filter @pim/server exec vitest run \
  src/routes/__tests__/memory-v2-code-read-parity.test.ts \
  src/routes/__tests__/memory-v2-code-write-parity.test.ts \
  src/routes/__tests__/memory-mcp.test.ts

pnpm --filter @pim/server exec vitest run \
  src/routes/__tests__/memory-v2-conformance-live.test.ts

pnpm --filter @pim/sdk test
```

The live conformance suite opens loopback listeners. An environment that forbids local listener
creation may run the injection-based route suites, but that limitation is not equivalent to live
transport evidence. Run the full matrix in CI or another environment that permits loopback before
using it as release evidence.

## Decision rule

Transport conformance passes only when every required row runs and passes with no boundary or
canonical-effect divergence. A skipped/unavailable required row is not a pass. Consumer-specific
memory-value or prompt-influence evaluation is separate from transport conformance and belongs to
the consumer, not to a hidden MCP experiment arm.
