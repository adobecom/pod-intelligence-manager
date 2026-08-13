# PIM universal memory platform: what we built

**Status:** current plain-language overview as of 2026-08-13

## The short version

PIM is now a governed memory platform for software and AI workflows. It can remember useful
lessons about a codebase or about how a harness runs work, find the right lessons later, and show
why each result was selected. It does this without letting an AI model decide what it is allowed to
read, write, approve, or activate.

The existing migrated v1 data is still supported. We did **not** deprecate it or move it into a
separate, disconnected v2 database. The canonical v1 records remain in place, and v2 adds typed
facets, resource bindings, immutable ledgers, and strict adapters around them. Records that can be
represented safely are available through the v2 APIs as well as their existing v1 paths. Ambiguous
or incompatible migrated data remains available to its legacy reader but is quarantined from v2
instead of being guessed or silently changed.

## What the platform remembers

The first release supports two memory planes:

| Plane | What it remembers | Current support |
| --- | --- | --- |
| Codebase | Repository-specific lessons tied to an exact repository and code revision | Search, immutable detail/history, receipts, feedback, candidates, review/activation, and scheduled reverification |
| Harness | Lessons about workflows, tools, models, configurations, failure recovery, and execution constraints | Search, immutable detail/history, receipts with runtime evidence, candidates, authorized activation, and reverification |

Unavailable planes fail with a bounded error and create no records, packs, or authorization side
effects. There is no fallback from one plane to another.

## The main features

### Safe, exact search

- A search is always for one organization, project, plane, and exact repository or harness.
- Authorization and applicability filters run before ranking.
- Results include ordered match reasons, token counts, omission counts, and an immutable retrieval
  pack that can be audited or read again.
- Reusing the same request ID with the same request returns the original pack. Reusing it with
  different content is rejected.
- A missing or inconsistent facet fails closed. The system never guesses a record type or crosses
  into another resource to find a substitute.

### A governed write and activation lifecycle

New memory does not become active merely because a model proposed it.

1. A producer submits an idempotent run receipt with bounded candidate proposals and evidence.
2. PIM verifies the producer, resource, evidence handles, runtime origins, and immutable scope.
3. The candidate remains pending and is not searchable as an active record.
4. An authorized reviewer can approve or reject it through the canonical HTTP control plane.
5. Activation creates the canonical record and all required v2 companions in one transaction.

The restricted MCP interface can submit safe receipts and read producer-bound candidate status. It
cannot review, approve, activate, adjudicate attestations, administer credentials, or mutate record
lifecycle controls.

### Evidence and corroboration

- Code evidence remains tied to the repository, base revision, stored attestation, and authorized
  source.
- Native harness evidence preserves root origins, derivations, producer identity, run identity,
  configuration scope, and candidate links.
- Retries, summaries, descendants of one root, and multiple claims controlled by the same source
  do not manufacture independent corroboration.
- Distinct verified sources may open a review signal, but they never auto-approve or auto-activate
  a candidate.

### Feedback without weakening migrated data

Existing v1 feedback remains in its original ledger. New v2 feedback uses a source-qualified v2
ledger so colliding raw IDs cannot be confused with migrated rows. Operational metrics, traces,
review signals, outbox jobs, retention, and erasure understand both sources. This separation keeps
the old data supported while preventing new v2 semantics from being forced into a legacy table
that cannot represent them safely.

### Scheduled reverification

Eligible active records receive a resolver policy and per-version state.
Workers periodically recheck the authoritative GitHub or runtime evidence and:

- keep verified records fresh;
- mark unavailable checks pending without inventing success;
- retire contradicted, withdrawn, stale, or expired records through the same canonical lifecycle;
- remove retired records from both v1 and v2 active search while preserving authorized immutable
  history;
- use leases, compare-and-swap state, retry bounds, rollback, and dead-letter observability so a
  stale worker cannot commit over newer truth.

Readiness is available over HTTP and restricted MCP with only bounded counts, timestamps, and
status. It does not expose raw evidence, job bodies, secrets, or internal identities.

### Consumer-owned influence

PIM returns authorized, lifecycle-eligible memory and records exactly what it returned in an
immutable pack. It does not contain the earlier PIM-managed exposure-policy, release-gate, canary,
four-arm benchmark, or kill-switch subsystem; that machinery was intentionally removed during
simplification.

A consumer such as Fiesta owns how an eligible result is composed into its bounded context, how
memory-on/off value is measured, and how its own feature is disabled. The consumer must preserve
PIM's record/version/pack provenance, stay within the authenticated resource binding and token
budget, submit terminal receipts/feedback, and never create a second lifecycle or authorization
authority. Credential containment uses exact service-token revocation; canonical record review and
activation remain HTTP control-plane operations.

## How clients use it

### Canonical HTTP v2

HTTP v2 is the source-of-truth interface. The strict SDK supports capabilities, binding, code and
harness search, immutable record/history and pack reads, receipts, feedback where supported,
candidate status and decisions, and readiness.

Responses are parsed against generated schemas. Unknown fields, wrong versions, oversize values,
authority fields supplied by callers, unsafe secrets, and malformed selectors fail closed.

### Restricted MCP companion

The private, stateless MCP companion exposes exactly eight safe tools:

- `pim_memory_capabilities`
- `pim_memory_binding`
- `pim_code_memory_search`
- `pim_harness_memory_search`
- `pim_run_receipt_submit`
- `pim_feedback_submit` for codebase feedback
- `pim_candidate_status`
- `pim_memory_readiness`

It also exposes two reauthorized resource templates: one exact immutable record version and one
immutable retrieval pack. Discovery is filtered for the current credential on every request.

MCP calls the same in-process services as HTTP; it owns no storage, ranking, authorization, or
fallback behavior. Operators issue MCP credentials through the same scoped service-token workflow
as HTTP consumers; rollout ownership and approval remain deployment concerns rather than MCP
protocol behavior.

## Security and operational guarantees

- Service credentials establish the maximum tenant, project, plane, operation, and exact resource.
  Request data can only narrow that authority.
- Private responses use no-store caching and authorization-aware variation.
- IDs are never treated as authority and are reauthorized on every read.
- Sensitive values, hidden reasoning, unbounded transcripts, credentials, and disallowed personal
  data are rejected before persistence and redacted from errors and logs.
- Metrics use bounded dimensions such as plane, operation, outcome, and transport;
  tenant, record, token, and resource IDs remain fields rather than metric dimensions.
- HTTP and MCP are tested for equivalent domain results, errors, idempotency, audit effects,
  authorization, failure semantics, and bounded latency.
- Governance plans cover the v1 and v2 ledgers, legal holds, retention, redaction, and project or
  organization erasure. A post-review mutation makes a deletion plan stale instead of deleting a
  different graph than the one reviewed.

## What remains intentionally out of scope

- The current capability document advertises only the implemented `codebase` and `harness` planes;
  callers must not assume additional plane names or providers.
- PIM does not store large authoritative artifacts; it stores bounded lessons, digests, and
  immutable references.
- Models cannot directly review or activate memory through MCP.
- The platform does not silently widen old token scopes or reinterpret ambiguous migrated rows.
- Consumer prompt/routing behavior is not a PIM control-plane feature. Each consumer must validate
  and own its bounded use of eligible memory.

## Migration answer in one sentence

V2 is an additive, governed interface over the supported canonical memory estate: migrated v1 data
continues to work, safely representable records gain v2 access, and only genuinely new semantics
use separate source-qualified companion ledgers.

## Detailed integration evidence

- [PIM_TO_FIESTA_IMPLEMENTATION_HANDOFF.md](./PIM_TO_FIESTA_IMPLEMENTATION_HANDOFF.md) defines the
  current consumer boundary and rollout work.
- [MEMORY_V2_HTTP_MCP_CONFORMANCE_REPORT.md](./MEMORY_V2_HTTP_MCP_CONFORMANCE_REPORT.md) records the
  current HTTP/MCP parity boundary and test commands.
