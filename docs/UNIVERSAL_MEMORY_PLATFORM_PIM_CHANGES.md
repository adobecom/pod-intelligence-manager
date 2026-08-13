# PIM changes for a universal-ready Fiesta memory platform

> **Superseded design plan.** It predates the final simplification and contains exposure/gate ideas
> that were removed. Use [MEMORY_API.md](./MEMORY_API.md) and
> [PIM_TO_FIESTA_IMPLEMENTATION_HANDOFF.md](./PIM_TO_FIESTA_IMPLEMENTATION_HANDOFF.md).

**Status:** historical proposed implementation plan
**Owner:** PIM platform
**Companion:** [Fiesta changes for universal-ready memory](./UNIVERSAL_MEMORY_PLATFORM_FIESTA_CHANGES.md)
**Implementation slicing:** [vertical slice plan with bounds](./UNIVERSAL_MEMORY_PLATFORM_PIM_SLICES.md)
**Baseline:** the deployed `pim.memory-search.v1` codebase path, canonical record lifecycle,
receipt ledger, and repository-bound authorization remain the reference implementation.

## 1. Executive decision

PIM should become universal-ready without committing to build four production memory products at
once.

The initial v2 implementation commitment is:

1. preserve the current v1 codebase path while Fiesta completes P1/P2;
2. prove codebase parity on the v2 common contract;
3. complete the harness plane end to end, initially without prompt or routing influence;
4. add v2-native exposure/audit state and scheduled truth reverification before harness can earn
   prompt or routing influence;
5. define safe content and organization extension points that report `plane_unavailable`;
6. implement content or organization serving only after a named consumer, authoritative identity
   source, evidence policy, benchmark, and operational owner exist;
7. build the complete safe MCP data-plane adapter alongside the corresponding HTTP slices while
   Fiesta remains on HTTP; require a named MCP-native consumer/owner before production enablement,
   not before implementation and conformance testing.

This is additive, not a rewrite. PIM already has reusable record versions, lifecycle transitions,
candidates, evidence, exact authorization, search packs, receipts, feedback, retention, release
gates, and generated contracts. V2 generalizes their boundary while leaving code-specific
validation and retrieval intact.

The contract may understand four plane names without advertising all four as available. This
distinction turns the architecture into permission to grow rather than a mandate to build every
plane now.

## 2. Product boundary

PIM owns durable, governed learnings:

- bounded claims, constraints, decisions, anti-patterns, and strategies;
- exact applicability and exceptions;
- evidence, approval, lifecycle, versions, and freshness;
- authorization, retrieval, packing, feedback, and governance.

PIM does not become the source of truth for:

- Fiesta checkpoints, conversations, drafts, or live tool state;
- Git repositories and working trees;
- CMS or DAM assets;
- brand, product, terminology, legal, or policy documents;
- workflow orchestration.

Those systems remain authoritative. PIM stores bounded learnings and immutable references to their
authoritative versions.

For future content generation, the authoritative system supplies current brand rules, product
facts, terminology, and policy at run time. PIM may remember what Fiesta learned while applying
those rules, such as rejected patterns, evaluation failures, channel-specific limitations, or
successful corrective strategies. PIM must not recreate a second brand graph.

## 3. Ownership hierarchy and plane meaning

Every memory record is organization-owned and normally project-bound, regardless of plane:

```text
organization
  -> project
    -> plane
      -> bound resource
        -> record and immutable versions
```

The `org` plane is not the tenant boundary. It is a future plane for explicitly governed policy
that may apply across workflows. Codebase, harness, and future content records are still owned and
isolated by organization and project.

The contract recognizes four plane names, but the initial availability differs:

| Plane | What it remembers | Primary resource | Initial v2 commitment |
|---|---|---|---|
| `codebase` | repository implementation constraints, decisions, and test strategies | canonical repository | production parity with v1 |
| `harness` | how Fiesta should execute workflows: recovery, verification order, compatibility, and escalation | harness/workflow | complete governed loop; shadow before any influence |
| `content` | future run-derived lessons about generated output, evaluations, channels, and tooling | canonical content space | contract-ready seam only; unavailable |
| `org` | future reviewed policy and shared operating constraints | policy domain | contract-ready seam only; unavailable |

Harness memory is durable operational know-how, not a checkpoint or transcript. Examples include a
safe recovery after a tool timeout, a required verification order, a configuration incompatibility,
a known failure fingerprint, or a human-approval requirement. A lesson about repository code stays
in `codebase`; a lesson about how Fiesta runs the task belongs in `harness`.

`repository_id` and `base_sha` are valid only in codebase applicability. Harness uses
harness/workflow/adapter versions and configuration digests. Future content uses authoritative
source revisions. Future organization policy uses policy revisions and effective time.

## 4. Non-negotiable invariants

1. Authentication establishes the maximum organization, project, plane, operation, and resource
   boundary. Request data may narrow it but never widen it.
2. Every search requests exactly one plane. Empty or failed retrieval never falls back to another
   plane.
3. Authorization and applicability filters run before relevance scoring.
4. Codebase keeps its repository/SHA selectors, evidence policy, ranker behavior, and regression
   suite; it is not reduced to a generic lowest-common-denominator record.
5. A candidate is not an active record. Run completion, model confidence, or popularity is not
   activation evidence.
6. Prompt eligibility and routing influence are separate, stricter states than activation.
7. Large authoritative artifacts remain in their source systems; PIM stores bounded learnings,
   digests, and immutable references.
8. Existing v1 semantics and token scopes are never silently widened.
9. Unknown or unavailable planes, applicability variants, selectors, evidence types, and fields
   fail closed.
10. Credentials, hidden reasoning, unbounded transcripts, and disallowed personal or licensed data
    are rejected before persistence.
11. Counts never manufacture authority. Retries, reruns, summaries, tool echoes, descendants of
    one root origin, and multiple roots controlled by one producer/corroboration domain count as
    one independent authority.
12. V1 harness records and retrieval packs remain permanently shadow. Any earned harness prompt or
    routing influence is a v2-only policy decision with a v2 audit pack.
13. Read-time freshness filtering is not a substitute for scheduled reverification of records that
    may influence prompts or routing.
14. Every new canonical object or record version and its required immutable v2 facet are created in
    one database transaction. V1 and v2 adapters call the same canonical writer; asynchronous
    projection is never the normal consistency mechanism.
15. Reverification that contradicts, withdraws, or expires a canonical claim retires it through the
    shared canonical lifecycle as well as v2 exposure state. No active v1 reader may continue to
    serve a claim that v2 has retired.

## 5. Stable v2 contract and provisional extensions

Freeze these common v2 decisions:

- plane discriminants: `codebase`, `harness`, `content`, and `org`;
- one plane and one matching applicability variant per search;
- common record, pack, receipt, feedback, and candidate envelopes;
- organization/project/plane/resource authorization order;
- typed scope snapshots and plane-specific version anchors;
- capability negotiation and deterministic unavailable-plane behavior;
- no cross-plane fallback or mixed-plane retrieval pack.

Also freeze before the first consumer implementation:

- record, candidate, receipt, and feedback facet schemas;
- harness-only root-origin and derivation-handle schemas, including server-owned producer and
  corroboration-domain binding fields;
- the complete safe MCP tool/resource schemas and the distinction between canonical HTTP,
  MCP-exposed data-plane operations, and excluded control-plane operations.

Freeze codebase and harness applicability as production v2 schemas. Keep detailed content and org
applicability schemas explicitly provisional, for example `v2alpha1`, until a real provider and
consumer validate their identity and selector model. Their plane names and extension mechanism are
stable; speculative provider fields are not promised forever.

V2 capabilities must distinguish known planes from available operations. The initial release
advertises only implemented codebase/harness operations: search/detail/pack, receipt/candidate,
feedback where scoped, readiness, and exposure/audit reads; it distinguishes canonical HTTP from
the restricted MCP data-plane surface and never advertises MCP control-plane mutation. A
well-formed content or org attempt receives a bounded `plane_unavailable` error and creates no
record, pack, receipt, or authorization side effect.

## 6. Canonical resource registry

Add a provider-neutral resource registry with:

- immutable PIM resource-row ID;
- organization and project;
- plane and resource type;
- canonical resource ID and display label;
- immutable provider resource ID where applicable;
- explicit aliases and rename/transfer history;
- validity interval, classification, retention reference, and audit fields.

The initial implementation registers only:

- `repository` resources;
- `harness` resources.

The schema may reserve `content_space` and `policy_domain`, but PIM must reject registration and
token binding for them until their planes pass the admission gate. Repository and harness data are
projected or backfilled without deleting or rewriting v1 authority. Fuzzy resource matching is
never authorization.

At initial cutover, PIM performs one stopped-writer, reconciled backfill from the newly populated
canonical v1 store. Thereafter, repository creation, harness binding, and service-token resource
binding use shared canonical registration services that write the existing authority row and its
v2 registry/binding companion in the same transaction. This is not CDC, an asynchronous projection
job, or a second authority. If an old path cannot participate in the transaction, it remains closed
until it can.

## 7. Service-token authorization

Existing scopes keep their meanings:

- `memory:search` remains repository-bound codebase search;
- `memory:receipt:write` remains codebase receipt intake, including bounded candidate proposals
  carried by the receipt;
- `memory:candidate:read` remains repository-bound candidate-status access;
- `memory:feedback:write` remains repository/pack-bound feedback intake;
- `memory:harness:search` remains exact project/principal/harness-bound search;
- `memory:harness:receipt:write` remains exact project/principal/harness-bound receipt intake,
  including bounded harness candidates and evidence handles;
- `memory:harness:candidate:read` is the one new exact least-privilege scope for non-enumerating
  harness candidate status; it is not implied by receipt or review permission;
- `memory:harness:review` remains exact project/principal/harness-bound review.

`memory:harness:*` is not a provisionable scope and must not appear in contracts, configuration,
token issuance, authorization checks, or tests.

The full MCP data-plane commitment adds `memory:harness:candidate:read` before the FU2 schema
freeze rather than overloading `memory:harness:receipt:write` or exposing
`memory:harness:review`. It is never retroactively added to an existing token; production issuance
requires the exact harness resource binding and MCP-E approval.

Do not reinterpret those scopes to include new planes. Internally they resolve through one
primitive:

```text
principal + operation + plane + project + resource_row_id -> allow | deny
```

Names such as `memory:content:search` and `memory:org:search` may be reserved in the design, but
PIM must not provision or honor them until the corresponding plane is implemented and admitted.
The existing Fiesta code token is not widened.

Service-token resource bindings remain immutable. Organization and project come from
authentication. For one authorized resource, v2 may infer the resource; with multiple resources,
the request supplies an exact selector that must match a binding.

Expose non-secret binding introspection so Fiesta can compare the effective binding with its
independently resolved runtime context. Never expose token material or resources outside the
principal.

## 8. Versioned API and common record model

Keep `/api/v1/memory` stable while v2 is dark-launched. The proposed common v2 surface remains:

- `GET /api/v2/memory/capabilities`;
- `GET /api/v2/memory/binding`;
- `POST /api/v2/memory/search`;
- `GET /api/v2/memory/readiness` for bounded reverification/worker health;
- immutable record detail/history;
- idempotent run receipts;
- candidate status and decisions;
- feedback;
- plane-specific attestation;
- per-plane/resource prompt policy and release gates.

A v2 response echoes the effective tenant, plane, resource binding, request ID, and immutable
retrieval-pack ID. Fiesta may use v1 for code until v2 parity passes; it must never encode harness,
content, or org data into v1 code extensions.

The v1 harness endpoint and its existing storage columns remain permanent-shadow compatibility
surfaces. V2 computes harness prompt and routing eligibility from additive v2 exposure state and
writes v2 retrieval packs; it never tries to set the v1 harness `prompt_eligible` column.

**Restricted MCP data-plane adapter.** HTTP v2 remains the canonical service contract and Fiesta's
initial integration transport; moving Fiesta to MCP would add no memory semantics or measured
outcome value. PIM nevertheless commits to build and conformance-test the complete safe MCP data
plane alongside HTTP so a future MCP-native coding or harness agent does not require a transport
retrofit. No qualifying MCP-native production pilot is currently committed. That absence blocks
production credential issuance and enablement, but no longer blocks implementation, staging tests,
or transport conformance. **MCP-E production enablement** requires one concrete host/team, product
and operational owners, bound resources, workflow, threat model, expected usage, and success
measure.

The adapter targets the stateless
[MCP 2026-07-28 protocol](https://blog.modelcontextprotocol.io/posts/2026-07-28/), using the current
split TypeScript server SDK rather than copying the repository's legacy session-based hosted-MCP
transport. It may reuse the hosted route's token-verification, request-size, logging, redaction,
rate-limit, and audit patterns, but not its initialization/session assumptions or loopback client.
Protocol discovery (`server/discover`, `tools/list`, and `resources/list`) is filtered for the
authenticated principal on every request; the domain-level `pim_memory_capabilities` result
describes PIM planes and operations and does not replace protocol discovery. Record and pack
resources use private cache scope with a TTL no longer than their authorization, freshness, or pack
expiry. Names, URIs, pack IDs, and record handles are identifiers, never capabilities, so every
read is reauthorized.

**MCP-A machine-auth checkpoint** must run early and prove that the existing PIM service-token
format and verifier can authenticate an exact repository- or harness-bound principal at a
dedicated `/mcp/memory` Streamable HTTP endpoint; validate token audience/resource indicators and
exact least-privilege scopes; call shared memory application services directly without loopback
HTTP or bearer-token passthrough; and pass modern-SDK, required-header, discovery,
negative-authorization, body-limit, redaction, private-cache, and audit tests. The checkpoint makes
an explicit choice between the standard
[MCP OAuth client-credentials extension](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials)
and a deliberately private PIM service-token profile. The latter can serve controlled internal
clients but must not be represented as portable OAuth/MCP machine authentication. If the checkpoint
reveals a new identity-provider, credential-format, token-issuance, browser-session, or proxy
project, rebaseline the MCP track explicitly; do not weaken the boundary or delay the canonical
HTTP release silently. The release is not MCP-complete until the checkpoint and the full companion
conformance suite pass.

The safe MCP data plane includes capabilities, non-secret effective binding, plane-specific search,
immutable authorized record/pack detail, idempotent run receipts, pack-bound feedback, candidate
proposal/status, harness receipts carrying bounded evidence handles and candidates, bounded
readiness, and read-only exposure/audit envelopes. Candidate proposals travel within governed
receipts; submitted evidence handles are untrusted references that PIM resolves under its existing
evidence policy, not direct authority claims. Every write requires a stable caller idempotency key:
same key plus same digest returns the original result, while the same key plus a different digest
fails with a conflict. After an ambiguous timeout the client retries the same MCP operation and key
and never switches transport.

This surface uses the same generated v2 schemas, application services, exact scopes, resource
bindings, validation, ranking, lifecycle, and audit effects as HTTP. There are no MCP-only scopes
or authorization semantics. If the standard client-credentials profile issues a dedicated
audience-bound access token, it resolves to the same service principal, exact resource bindings,
and existing memory scopes. Candidate review/decision, activation, direct attestation adjudication,
exposure-policy mutation, release-gate mutation, token/resource administration, and kill-switch
mutation remain HTTP/internal control-plane operations. The adapter never exposes the broad
interactive PIM MCP catalog, reads storage directly, or lets caller-supplied organization/project
values override authenticated authority.

All implemented planes share a common envelope:

- record ID and immutable version;
- organization, project, plane, and resource binding;
- kind, bounded summary/details/rationale;
- typed applicability, compatibility, and exceptions;
- validation strategy and evidence handles;
- freshness, lifecycle, prompt eligibility, and transition summary;
- recorded time and classification.

Initial non-code subkinds should stay narrow: `workflow_strategy`, `failure_pattern`,
`verification_sequence`, `tool_constraint`, and `escalation_requirement`. Migration `008` keeps
the legacy storage-level kind CHECK, so additive migration `013` stores these as strict v2 facet
metadata with this frozen broad-kind mapping: `workflow_strategy -> decision`,
`failure_pattern -> anti_pattern`, `verification_sequence -> test_strategy`, and
`tool_constraint | escalation_requirement -> constraint`. The v2 subtype remains in the facet, so
the mapping loses no contract information; an unmappable subtype fails closed. Migrations `012`
and `013` do not rebuild the canonical record table merely to widen a kind enum. `fact`,
`style_rule`, and `terminology` are not an invitation to import a brand graph; any future
authoritative-content ingestion needs a separate approved use case and freshness contract.

## 9. Validation, activation, and retrieval

The shared validator dispatches over strict plane policies:

| Plane | Initial validation | Acceptable activation evidence |
|---|---|---|
| Codebase | repository anchors, ancestry, tests | verified merge/test or authorized review |
| Harness | stable failure fingerprint, compatible workflow/configuration | independently verified runtime or authorized review; repeated outcomes open review only until origin quorum is implemented |
| Content, future | source revision plus output/evaluation context | verified evaluation or authorized review; repeated outcomes cannot elevate authority by count alone |
| Org, future | owner, audience, revision, effective interval | policy-owner approval or authoritative publication |

The initial new evidence work is workflow/runtime attestation. CMS, DAM, content-owner, and policy
resolvers are deferred with their planes.

Every resolver records immutable origin ID, digest, provider identity, occurrence time,
verification time, and source authority. A provider outage leaves a candidate pending; it never
lowers the evidence requirement.

Evidence is bound at write time to an authenticated producer principal, root origin, authority
domain, and derivation parents. PIM, not Fiesta payload text, determines the effective origin and
authority and assigns the stable `corroboration_domain_id`. A policy-defined corroboration quorum
counts distinct approved corroboration domains, not receipt, run, event, or caller-supplied origin
IDs. Retries, reruns by one producer principal, summaries, trusted tool echoes, derived artifacts
sharing one root, and multiple roots controlled by one domain count once. A repeated-outcome review
signal requires independent producer runs bound to distinct approved corroboration domains; repeats
from one producer do not create that signal. Until a Sybil-resistant origin-quorum policy and
adversarial tests exist, even qualifying repeated outcomes may open review but cannot activate a
record or grant prompt/routing influence.

This requirement follows the origin-bound, Sybil-resistant threat model described in
[TMA-NM](https://arxiv.org/abs/2606.24322); PIM enforces the control structurally rather than asking
a model to judge whether observations look independent.

Retrieval always hard-filters in this order:

1. authenticated organization;
2. authenticated project;
3. operation scope;
4. exact resource binding;
5. available plane and matching applicability;
6. lifecycle/effective time and classification;
7. consumer compatibility and selector applicability;
8. freshness and expiry.

Only then may PIM rank results. Code keeps repository/SHA/path/symbol/task-class features. Harness
adds workflow/configuration/stage/model/tool features. Future planes add selectors only when their
schemas are admitted. Search packs persist the exact request digest, effective binding, selected
versions, ranker/policy versions, budget, eligibility, and expiry.

### Scheduled reverification and freshness

PIM owns the scheduled truth-reverification loop for canonical memory. Every record eligible for
prompt or routing influence has a resolver policy, `last_verified_at`, `next_reverify_at`, maximum
age or expiry, and bounded failure behavior. The worker rechecks the authoritative evidence or
runtime attestation and records an immutable decision. A verified outcome advances freshness using
an expected state/record version so a stale worker cannot overwrite a newer decision. A
contradicted, withdrawn, or expired outcome invokes the existing canonical lifecycle service and,
in the same transaction, changes the canonical record from `active` to the policy-defined
non-active status and removes v2 prompt/routing eligibility. Grace exhaustion similarly transitions
the canonical record to `stale` unless a stricter policy requires revocation. The worker never
writes the v1 `prompt_eligible` column; existing v1 lifecycle filters stop serving the non-active
record. Provider outages never renew freshness silently; they leave the record pending or fail it
closed after the declared grace period.

Read-time lifecycle and freshness filters remain a second line of defense. U3 cannot begin until
the scheduler, stale transition, source-revocation path, retry/dead-letter behavior, metrics, and
kill-switch interaction have been exercised in shadow.

### Delivery and synthesis boundary

The initial release serves memory through the live v2 API. Rendering an active set into
repository-native instruction files, `AGENTS.md`, or skills is deliberately deferred. Such files
must be generated, reviewable derived artifacts carrying record/version IDs and a manifest digest;
they must never become a second memory authority and must be regenerated or removed after
revocation. Any proposal must earn use through the value/enablement pattern in
[the graph retrieval review](./FIESTA_MEMORY_GRAPH_ARCHITECTURE_REVIEW.md#8-how-graph-retrieval-should-earn-production-use)
and name its repository owner before implementation.

Legacy scheduled graph synthesis or "dreaming" remains governed by
[the architecture overview](./ARCHITECTURE_OVERVIEW.md) and
[the canonical-memory producer plan](./PLAN_POD_LEARNINGS_TO_CANONICAL_MEMORY.md); it is not a
substitute for the canonical scheduled reverification loop defined here.

## 10. Receipts, feedback, and candidates

V2 replaces mandatory repository correlation with a typed `scope_snapshot` union:

- codebase: repository and base SHA;
- harness: harness/workflow/adapter/configuration versions;
- future content: content space and authoritative source revisions;
- future org: policy domain and effective revision.

A receipt may reference several independent packs, but every feedback item must match its pack's
plane, resource, record version, and scope-snapshot digest. Cross-pack and cross-resource feedback
is rejected.

Codebase and harness candidates use strict applicability and bounded evidence with stable client
IDs and idempotent intake. Harness activation makes a verified record searchable in harness shadow;
it does not make the record prompt-visible or routing-influential.

The idempotency claim and its canonical request digest are committed with the receipt, feedback, or
candidate effect in one transaction. A replay with the same key and digest returns the original
result; the same key with a different digest conflicts. No adapter may acknowledge a write before
both its canonical row and required facet exist.

## 11. Content boundary and future admission

The first content implementation, if admitted, must focus on run-derived learning:

- rejected output patterns and verified reasons;
- recurring evaluation failures;
- channel, locale, template, publishing, or tooling limitations;
- corrective strategies that repeatedly passed evaluation.

At generation time, Fiesta fetches current brand voice, terminology, product facts, approved
claims, legal rules, and policy from their authoritative systems. PIM stores references needed to
explain and revalidate a lesson, not a durable mirror of those source documents or generated drafts.

A lesson about output suitability belongs in future `content`; a lesson about orchestration,
retries, tool order, or recovery belongs in `harness`; a mandatory enterprise rule belongs in the
future `org` plane or its authoritative policy system.

## 12. Per-plane evaluation and enablement gates

Every plane must earn production use through the pattern in
[How graph retrieval should earn production use](./FIESTA_MEMORY_GRAPH_ARCHITECTURE_REVIEW.md#8-how-graph-retrieval-should-earn-production-use),
adapted to that plane.

Before observing results, declare:

- a representative benchmark with positive cases, negative controls, stale/inactive cases, and
  cross-tenant/project/resource traps;
- variants: normal-budget no-memory baseline; no-memory control with the same total inference-token
  and permitted actor-step budget as the memory arm; shadow retrieval with no behavioral influence;
  and a deterministic memory canary;
- thresholds for retrieval relevance, task success/rework, harmful or distracting context,
  latency, token displacement, and cost;
- repetition count, model/configuration strata, variance reporting, confidence intervals, and the
  decision rule for inconclusive results;
- the rollback owner and tested kill switch.

The budget-matched arm follows the control proposed in
[the budget-constrained agent-memory study](https://arxiv.org/abs/2606.15017): memory must beat a
vanilla agent allowed to spend the same total inference budget, not merely a cheaper baseline.

At minimum, production influence requires:

- zero authorization, cross-resource, or inactive-lifecycle exposures;
- credible improvement on the plane's intended task subset;
- no material regression on ordinary work;
- acceptable latency, cost, and PIM-outage behavior;
- improved agent outcomes or relevance, not merely more returned memories;
- successful canary rollback and receipt-loss verification.

Activation, prompt exposure, and routing influence are separate gates. Codebase success does not
approve harness, and harness success does not approve content or org. A failed gate leaves the
plane in shadow without blocking Fiesta work.

## 13. Data protection and retention

All implemented planes inherit credential/PII/hidden-reasoning rejection, bounded payloads,
retention, legal hold, erasure tombstones, and immutable prompt-exposure audit.

Future content work additionally requires classification, allowed-source/destination policy,
licensing and usage-right references, source withdrawal handling, and bounded excerpts. These
controls are admission prerequisites, not infrastructure to build speculatively.

## 14. Storage and deployment

Migrations `001` through `011` remain immutable. At plan freeze, the working `012` through `018`
files are unregistered and unapplied; verify that fact against every target migration ledger before
renumbering or running them. The initial additive order is:

1. `012`: repository/harness resource rows, aliases, and immutable service-token resource bindings;
2. `013`: record, candidate, receipt, and feedback facets;
3. `014`: v2-native retrieval-pack and pack-item ledgers;
4. `015`: typed scope snapshots and feedback bindings;
5. `016`: runtime evidence, root-origin, derivation, and corroboration-domain state;
6. `017`: scheduled reverification policy, state, decisions, jobs, and attempts;
7. `018`: v2 exposure policy, gate, canary, and kill-switch state.

Migration `013` and the shared canonical write primitives land in U0 before the first v2 read or
write route opens. Plane-specific backfill reconciliation remains an exit gate for the slice that
first serves that plane or object type, but schema availability and atomic maintenance are not
postponed to that slice.

Migration `008` deliberately enforces permanent-shadow harness behavior in the v1 tables: harness
records cannot set the legacy `prompt_eligible` field, and harness retrieval packs cannot contain
prompt items. SQLite cannot relax those table CHECKs in place without following its
[generalized table-rebuild procedure](https://www.sqlite.org/lang_altertable.html). Migrations `012`
through `018` therefore must not drop, rename, rebuild, add columns to, change CHECKs on, or disable
foreign keys around the three tables rebuilt by `008`: `memory_records`,
`memory_retrieval_packs`, and `memory_applicability_indexes`. `memory_record_versions` was created
by `001`, not rebuilt by `008`; it also remains unchanged in this release because it is canonical
version authority. This is a schema prohibition, not a ban on normal lifecycle transitions through
the existing record service. V1 code prompt behavior and v1 harness shadow behavior continue
unchanged.

The existing record/version tables remain the single canonical claim authority. Additive v2 facet
rows hold typed metadata and exact resource association; additive v2 exposure state is the sole
authority for v2 prompt/routing eligibility; additive v2 packs are immutable audit artifacts. All
core-record and v2-facet writes commit atomically, and v2 fails closed if either side is absent or
does not reconcile. This is a version boundary, not a dual-write competing memory store.

At plan freeze, v1 has only just received the migrated knowledge-graph data and has no production
consumer traffic. Treat that as a cutover precondition to verify, not a timeless assumption. With
writers stopped, backfill the current store once, reject rather than guess any ambiguous subtype,
and reconcile one-to-one identity, row counts, foreign keys, digests, and active pointers before
opening v2. No CDC, asynchronous projection worker, or online dual-write period is required.

After the cutover, every surviving v1 and new v2 intake adapter calls one transaction-owning
canonical service that creates the core record/candidate/receipt/feedback row, its required facet,
idempotency state, and outbox effect together. Repository registration, harness binding, and token
binding follow the same rule for their resource companions. Injected failure of any companion write
must roll back the entire operation. If an unused v1 writer cannot use the shared service, keep it
closed rather than permit facetless rows.

Any future consolidation that removes the migration `008` CHECKs is a separate offline migration,
not hidden inside `012` through `018`. It requires stopped writers, a verified backup and restore
rehearsal, capacity checks, exact table/index/trigger inventory, transactional copy, row-count and
digest reconciliation, `foreign_key_check`, `integrity_check`, rollback criteria, and a measured
maintenance window before approval.

Do not add content provider state, content records, policy-domain temporal tables, or their scopes
in the initial migrations.

Deploy v2 dark alongside v1. The deployment modes are `disabled` (no v2 calls), `contract_only`
(capabilities and binding only), `shadow` (retrieval/audit without behavioral influence), `canary`
(deterministic bounded influence), and `active` (gate-approved influence). Move through them in that
order. No destructive data conversion, big-bang cutover, or existing-token widening is required.

## 15. Observability

Metrics and audit events use bounded plane, resource type, operation, evaluation arm, outcome,
reason-code, contract-version, and transport dimensions. `transport` is the fixed enum
`direct_http | mcp`; it is never an evaluation arm or an eligibility input. Never use raw queries,
prompts, content, brands, campaigns, tenant/repository IDs, endpoint URLs, or token-derived values
as metric dimensions.

Initial measures include:

- boundary denials and attempted cross-resource access;
- search success/empty/error for codebase and harness;
- candidate verification and activation outcomes;
- stale/inactive exposure rate;
- scheduled-reverification due/attempt/success/failure/dead-letter age and source-withdrawal lag;
- distinct root-origin quorum counts and collapsed duplicate-origin observations;
- prompt-visible and actually used records;
- helpful, harmful, conflicting, and unresolved feedback;
- PIM-outage blocked-execution and lost-receipt counts;
- request count, success/error/timeout, authorization denial, latency, retry/idempotency conflict,
  and parity mismatch by bounded transport;
- task-quality lift, rework, latency, token displacement, and cost by plane.

## 16. Implementation map

| Area | Initial required direction |
|---|---|
| Contracts | add server-owned v2 common schema, stable codebase/harness applicability, provisional content/org extensions, and generated clients |
| Capabilities | distinguish known planes from available operations and return deterministic unavailable-plane behavior |
| Authorization | generic plane/resource checks for repository and harness without widening v1 scopes |
| Resource identity | one-time reconciled backfill, then atomic canonical registration of repository/harness authority and its generic resource companion |
| Search/detail | achieve codebase v2 parity; complete harness immutable detail and hard-filtered search |
| Validation/evidence | retain code proof; add bounded runtime attestation plus authenticated root-origin/derivation policy for harness |
| Receipts/candidates | add typed codebase/harness snapshots and generic idempotent correlation |
| Freshness | add scheduled truth reverification, canonical lifecycle retirement, source withdrawal, stale transition, and fail-closed influence removal |
| Policy/gates | independent codebase/harness activation, prompt, routing, canary, budget-matched evaluation, and kill-switch state |
| Storage | land all additive facets and shared atomic writers before v2 serving; never rebuild v1 tables in the initial release |
| SDK | strict generated v2 client with v1 code fallback until parity |
| MCP data plane | build the stateless MCP 2026-07-28 safe data plane over shared services; auth-filter discovery/resources, use private caching, and never expose governance/admin mutation or make Fiesta depend on MCP |

The likely starting files remain the v1 contract and generators, memory capabilities, service-token
authorization, repository registry, harness bindings/search, record/detail, receipts, candidates,
activation, prompt policy, release gates, SDK, and migrations.

## 17. Build commitment and planning guardrail

This plan separates architectural readiness from production support.

| Scope | Commitment | Rough planning range |
|---|---|---|
| Current Fiesta P1/P2 | finish and preserve as compatibility baseline | days, barring a new contract defect |
| V2 codebase parity plus harness end to end | initial committed release, including v2 exposure audit and scheduled reverification | about 4–8 calendar weeks with PIM and Fiesta work in parallel |
| Content-ready contract/interface seam | included, disabled, and unavailable | roughly 1–2 engineer-weeks across both sides within the foundation work |
| Safe MCP data-plane parity | committed companion delivery across U0-U3; production enablement still requires a named pilot/owner | included in the updated slice estimates; explicitly rebaseline if the machine-auth checkpoint discovers a new identity project |
| Real production content plane | separately approved future project | roughly 4–8+ additional weeks, depending on provider identity and governance |
| Organization-policy plane | not estimated until a named demand and policy owner exist | deferred |

These are planning ranges, not delivery commitments. External provider APIs, classification,
licensing, evaluation ownership, and approval latency can dominate future content work.
The facet cutover should remain lightweight while the no-traffic precondition holds. The 4–8 week
initial-release range includes the safe MCP companion only if MCP-A confirms that the existing token
verifier can be adapted to the modern stateless MCP server without a separate identity project.
Hosted-MCP security patterns are reusable; its legacy transport/session implementation is not an
estimate assumption. A newly discovered identity project requires an explicit MCP rebaseline rather
than reduced authorization or conformance coverage.

## 18. Delivery phases

### U0: universal-ready contract skeleton

- Freeze the common envelope, plane names, resource-binding model, availability matrix, and typed
  scope-snapshot mechanism.
- Freeze codebase/harness applicability; mark content/org details provisional.
- Freeze record/candidate/receipt/feedback facets and harness-only root-origin/derivation handles;
  add all facet tables and the shared transaction-owning canonical write primitives before serving
  any v2 read or write.
- Add capabilities, binding introspection, the one-time repository/harness registry backfill,
  ongoing atomic registration, and negative controls.
- Freeze the complete safe MCP tool/resource schemas; implement modern protocol discovery,
  capabilities plus authenticated binding, and pass the machine-auth checkpoint. Keep production
  credentials disabled until a concrete MCP-native pilot and owner are admitted.
- Freeze the additive v2 facet/exposure/pack boundary, exact harness scope strings, root-origin
  semantics, and v1 permanent-shadow compatibility rule.
- Keep v2 behavior dark and content/org unavailable.

**Exit:** generated HTTP clients and restricted MCP capabilities/binding negotiate v2, MCP-A
passes, unavailable planes fail deterministically, backfills reconcile, injected companion-write
failure rolls back the canonical write, and no v1 behavior or existing credential permission
changes.

### U1: codebase on v2

- Implement codebase search, immutable detail, receipts, feedback, and policy on v2.
- Add MCP code search/detail/pack, receipt-with-candidate, feedback, and candidate-status parity
  over the same services and exact scopes.
- Run the existing v1 quality, security, idempotency, latency, and outage suites against both paths.
- Keep v1 as the fallback.

**Exit:** HTTP v2 and the MCP code data plane meet or exceed v1 behavior with no authorization,
quality, idempotency, audit, failure-semantics, or latency regression.

### U2: harness governed loop in shadow

- Reuse existing harness bindings and shadow search through the common v2 machinery.
- Add immutable detail, typed receipts, candidates, runtime evidence, and governed activation.
- Add MCP harness search, receipt/evidence-handle/candidate intake, candidate status, and readiness
  parity without exposing review or activation.
- Bind evidence to authenticated root origins; collapse retries/derivations from one origin and
  keep repeated-outcome corroboration review-only.
- Run scheduled reverification, stale transitions, source withdrawal, and dead-letter handling in
  observe-only/shadow mode.
- For codebase and harness, prove that contradiction, withdrawal, expiry, or grace exhaustion uses
  the canonical lifecycle service so v1 and v2 readers both stop serving the retired version.
- Keep prompt exposure and routing influence off.

**Exit:** one Fiesta HTTP workflow and one staged MCP producer fixture submit and re-retrieve an
equivalent governed harness lesson while harness prompt/routing influence remains disabled;
canonical retirement may only remove a record proven unsafe or stale. MCP exposes no review or
activation operation.

### U3: harness earns production influence

- Predeclare the harness benchmark, variants, metrics, thresholds, and rollback owner.
- Compare a normal-budget no-memory baseline; a no-memory control with the same total
  inference-token and permitted actor-step budget as the memory arm; shadow; and deterministic
  canary across predeclared repeated runs and confidence rules.
- Require healthy scheduled reverification and prove expiry, contradiction, provider-outage,
  source-withdrawal, and kill-switch drills.
- Enable prompt or routing influence only through v2 exposure policy and v2 audit packs as
  separately approved gates; v1 harness remains permanent shadow.
- Return the resulting exposure/audit envelope through MCP reads without exposing policy or gate
  mutation, and finish transport conformance separately from the four-arm memory-value benchmark.

**Exit:** harness passes its gate and kill-switch drill, or remains permanently shadow; separately,
the complete safe MCP data plane passes transport conformance with MCP-E still closed unless a
named production pilot has been approved.

## 19. Deferred plane admission phases

### C0: content admission decision

Requires a named consumer and owner, canonical content-space provider identity, retention and
classification decisions, licensing policy, evidence resolver, adjudicated benchmark, and measured
value hypothesis. Without all of these, content stays unavailable.

### C1: run-derived content shadow

Register one real content space and retrieve only provenance-complete run-derived lessons. Fetch
brand/product/terminology/policy context live from its authoritative system. No prompt exposure,
authoritative-document import, or prior-draft retrieval.

### C2: content candidates and canary

Add evaluated candidates, verified evidence, receipts, and a deterministic canary only after C1
passes its predeclared gate.

### O0: organization-policy admission

Requires a named policy owner, authoritative revision/effective-time source, cross-project demand,
and bitemporal tests. It is not part of the initial release.

## 20. Initial-release acceptance criteria

The initial universal-ready release is complete when:

- codebase v2 reaches parity while v1 and Fiesta P1/P2 remain operational;
- harness has an organization/project/resource-bound end-to-end governed loop;
- all records remain isolated by organization, project, plane, and exact resource;
- repository ID and base SHA exist only in codebase context;
- harness activation cannot imply prompt or routing influence;
- repeated runs, multiple roots, or derived artifacts controlled by one corroboration domain
  cannot satisfy independent corroboration by count;
- every prompt/routing-relevant codebase or harness record has a healthy scheduled reverification
  policy and a contradicted, withdrawn, expired, or grace-exhausted record is retired through the
  canonical lifecycle so no v1 or v2 active read continues to serve it;
- migrations `012` through `018` leave the three migration-`008` rebuilt tables and CHECK
  constraints intact, and every v2 facet/exposure/pack backfill reconciles with canonical records;
- no v2 route opens until the required facet backfill is complete, every surviving v1 writer
  creates its v2 facet atomically, and a missing or ambiguous facet fails v2 closed;
- content and org are recognized but unavailable and cannot create storage or authorization effects;
- migration does not implicitly widen any credential; only explicit token issuance may add the
  exact new scopes and bindings;
- no empty or failed search falls back across planes;
- every enabled influence has predeclared benchmark evidence and a tested kill switch;
- every influence benchmark includes a budget-matched no-memory control and predeclared variance
  treatment;
- PIM outages do not block Fiesta work or lose acknowledged/queued receipts;
- Fiesta completes the release over canonical HTTP without an MCP client dependency;
- the MCP companion exposes the complete safe data plane with a passing machine-auth checkpoint,
  HTTP-equivalent authorization/results/audit effects, idempotent ambiguous-write behavior, and
  bounded transport metrics on the stateless 2026-07-28 protocol;
- production MCP credentials and enablement remain off until a concrete pilot and owner are named.

PIM must not claim content or organization memory support until the corresponding deferred phase
passes its own acceptance gate.

## 21. Explicit non-goals for the initial release

- building a PIM-owned brand, product, terminology, or policy graph;
- importing complete CMS/DAM assets, authoritative brand documents, drafts, or transcripts;
- enabling production content or organization search merely because their plane names exist;
- enabling every Fiesta workflow at once;
- cross-plane semantic fallback or mixed-plane packs;
- self-activation based on confidence or one successful run;
- treating multiple run IDs, root IDs, or descendants controlled by one corroboration domain as
  independent corroboration;
- rebuilding `memory_records`, `memory_retrieval_packs`, or
  `memory_applicability_indexes` as part of the initial v2 release;
- materializing canonical memory into repository instruction files or skills during the initial
  API release;
- enabling production MCP credentials without a named MCP-native pilot/owner and a passing
  machine-auth checkpoint;
- exposing MCP review/decision, activation, direct attestation adjudication, exposure-policy,
  release-gate, token/resource administration, kill-switch, broad interactive PIM, or
  direct-storage tools;
- copying the legacy hosted-MCP session transport into `/mcp/memory`;
- creating MCP-owned memory semantics, a new identity-provider project, credential passthrough, or
  caller-selected tenant authority;
- generic unrestricted metadata;
- removing v1 before v2 codebase parity and migration proof;
- adding a graph or vector database without measured need.
