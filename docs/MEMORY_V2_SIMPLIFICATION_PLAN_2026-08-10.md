# Memory v2 launch plan: finish a harness-neutral PIM, deploy it, then prove Fiesta influence

**Date:** 2026-08-10 (revision 6; removes the standalone backup/baseline slice, folds a disposable production-copy rehearsal into Slice 1, and captures the authoritative backup manifest only after writers stop in Slice 7)
**Branch:** `podFix` (working tree is not yet organized into reviewable commits)
**Basis:** [Memory v2 full branch review](./MEMORY_V2_BRANCH_REVIEW_2026-08-10.md), direct verification against the working tree and production database, and the decisions recorded below
**Status:** implementation plan
**Supersedes:** revisions 3-5 of this document, and the shadow, exposure, benchmark, and HTTP-only guidance in [PIM-to-Fiesta implementation handoff](./PIM_TO_FIESTA_IMPLEMENTATION_HANDOFF.md)

## 0. Operating constraints and launch order

These constraints drive every simplification below:

- The Adobecom and Milo data must not be lost. Everything else, including downtime, is negotiable.
- No current product consumes canonical memory. `get_agent_session_context` is a Pod/context feature: it calls `/api/knowledge/relevant` and reads the legacy knowledge graph, not `memory_records` or the v1/v2 memory search APIs. It is tested only as a Pod regression boundary.
- Skill-conflict routes and `skill_catalog_*` tables are live PIM functionality outside the memory surface. Like every other feature, they may break or go down temporarily during development and the deployment window; they must work when Slice 7 verifies the launch. Only losing the Adobecom/Milo data is unacceptable.
- Legacy records that are active at deploy are trusted by an explicit cutover decision. The migration must not pretend they were newly evidence-verified, and reverification must not retire them.
- PIM ships both HTTPS and MCP over the same application/service core. The adapters may differ only in transport concerns; neither owns business rules.
- Fiesta is the first real harness consumer, not the owner of the PIM contract. Before Fiesta work starts, the v2 contract and PIM runtime must be harness-neutral: onboarding another conforming harness requires resource registration, credentials, a consumer adapter, and conformance tests, not PIM server code, schema changes, or migrations.
- Finish the known PIM cleanup, dead-code removal, producer repair, transport parity, and endpoint verification before starting Fiesta. Do not defer a PIM refactor merely to reduce short-term regression risk; use the slice demos and the shared conformance table to make the refactor safe.
- After PIM is deployed, build the smallest real Fiesta integration, test it against deployed PIM through both transports, and prove that an approved memory changes a Fiesta run.
- Keep process weight low. Tests are written inside the slice that needs them. There is no upfront acceptance-test program, endpoint-characterization pass, or pre-built conformance matrix, and no standing guardrails beyond four small artifacts: the off-instance backup, the count-manifest comparison, the deploy digest check, and the Fiesta-identifier source guard.

## 1. Production reality (verified 2026-08-10, read-only SSM inspection)

| Fact | Evidence |
| --- | --- |
| Prod schema is migrations **001-011**; migrations 012-018 are untracked files that have never shipped anywhere non-disposable | `schema_migrations` on `/data/pim.db`; `main` stops at 011; no staging environment exists; local `.data/pim.db` is at 001-015 |
| The v1 legacy cutover **already ran in prod** on 2026-08-07: authority `canonical`, `legacy_writes_frozen=1`, `knowledge_nodes=0` | `memory_authority_transitions` revisions 1-2 |
| Pod-archival learning ingestion is **already broken in prod** (frozen-writer fence in `addLearningsToGraph`) and nobody has noticed | fence at `knowledge-graph.ts:499`; no related log lines in 72h |
| The data to preserve: **164 active `memory_records`, all Milo** (`adobecom/milo`); Milo candidates (420 pending, 37 auto-promoted); legacy import items (Milo 1,527, Adobecom 1,292, EMC 306); 677 `project_memory_candidates` + ~4,100 project-search chunks; 81 `skill_catalog_*` entries | per-org counts from prod DB |
| Every v1 experiment/governance table is **empty**: prompt policies, release-gate decisions, review signals, attestations, evidence, erasure, outbox all 0 | prod table counts |
| **0 harness principal bindings**, 1 repo-bound token, 4 service tokens | prod table counts; F2's boot-crash scenario cannot trigger on current data |
| The systemd unit pins the image **by digest**; pull+restart without digest verification is a known no-op footgun | `docker inspect` config-image vs running image |

Consequences: there is no rollback-compatibility audience for the experiment/exposure schema and no consumer that a brief outage can hurt. The hard deployment requirement is small: take a verified backup, rehearse the migrations against a copy of the production database, deploy once, compare the important Adobecom/Milo counts, and call the real endpoints.

## 2. Final design decisions

### 2.1 Remove shadow/exposure behavior, including the empty v1 machinery

- Delete the v2 exposure, evaluation-arm, canary, benchmark-adjudication, prompt/routing eligibility, and kill-switch machinery.
- Delete `memory-release-gates.ts`, its route, and the empty v1 prompt-canary/release-gate machinery.
- Do not weaken tenant, resource, lifecycle, review, or applicability checks. A v2 item is usable only when it is active, trusted, authorized for the exact resource, applicable to the current scope, and not revoked, expired, or quarantined.
- Migrations 012-018 have never shipped, so rewrite them into the schema PIM actually needs. Do not preserve inert exposure columns or operations merely because they exist in the working tree. Migrations 001-011 remain immutable.
- Replace the unshipped exposure migration 018 with an experiment-cleanup migration that removes the empty shipped v1 experiment tables, indexes, and triggers. Preflight aborts if the production tables are unexpectedly non-empty.
- Preserve the 272 stored v1 receipt responses for exact idempotent replay. New v1 executions do not calculate or write arm/shadow fields; old stored payloads may still contain historical fields and replay unchanged. Historical storage compatibility is not active shadow mode.
- Keep one Fiesta memory on/off setting for operational rollback. It controls use of memory, not a second decision system.

### 2.2 Support HTTPS and MCP as equal thin adapters for consumer operations

- One application/service core owns authentication context, authorization, resource resolution, search, detail, retrieval packs, receipts, decisions, readiness, and errors.
- HTTPS and MCP translate their input/output envelopes into that core. MCP must be updated with the simplified schema; it cannot stay unchanged after removal of `MemoryEvaluationArmV2`, `evaluation_arm`, and exposure snapshots.
- Add the missing production-safe MCP credential issuance/configuration path and report `mcp_surface.production_enabled: true` only when it is actually usable.
- Generate both adapters from the same harness-neutral contract roots where possible and run the same consumer-operation conformance matrix through each. Each consumer harness owns one local memory interface and may select a transport per run/configuration. Reviewer/admin mutation can remain HTTPS-only; ordinary harness credentials never receive that authority. Fiesta implements this interface as the first real consumer in Slice 8.

This is not two memory platforms. The incremental cost is transport authentication, translation, and parity tests; the data model and behavior remain single-source.

### 2.3 Represent cutover trust honestly; keep reverification simple

- Migration 017 records a small trust basis: `legacy_cutover` or `evidence_verified`.
- Records active at deploy become `trusted` with `trust_basis = legacy_cutover`. Store the cutover decision time separately; do not overwrite source freshness or claim a new evidence-verification timestamp.
- New activations use `evidence_verified` and retain their actual evidence time.
- Replace the current worker/policy coupling with one global `MEMORY_V2_REVERIFICATION_ENABLED` switch, default `false`. Disabled is a healthy, intentional state (`worker_status: disabled`), not degraded readiness and not a reason to suppress trusted records.
- `legacy_cutover` records are not automatically enrolled when the worker is enabled; they remain trusted until an explicit lifecycle/reviewer action changes them. For enrolled `evidence_verified` records, provider `unavailable` or timeout leaves the prior trust state unchanged and schedules a retry. Only explicit contradiction, revocation, expiry, quarantine, or a completed negative verification can remove their eligibility.
- Bound all provider calls. A provider cannot keep a request or worker task open indefinitely.

### 2.4 Authenticate and authorize once per request

- At the start of each HTTPS request or MCP tool call, verify the credential once and build an immutable authorization snapshot for that request.
- Authorize that snapshot once against the exact organization, project, resource binding, plane, and operation. Pass the already-authorized resource context into the service core; do not repeat token proof, eight-table re-proof, or binding lookup deeper in the call.
- Revoking a credential blocks the next request. It does not cancel a request that already passed authorization and is in flight. This is the agreed consistency boundary.
- Keep canonical binding rows and least-privilege operations. Remove migration-era operation arrays or companion rows when they duplicate the same authority.

### 2.5 Make receipts match real harness runtime outcomes

This is runtime behavior, not test-only accommodation:

- A terminal harness run can legitimately produce no new memory candidate, so harness receipts accept `candidates: []`.
- The initial v2 platform contract permits at most one distilled lesson per terminal run (`0..1`). This is a universal PIM simplicity and review-bound invariant, not a Fiesta-specific assumption. A harness that observes several possible lessons selects its highest-value candidate before submission; changing this bound later requires an explicit contract revision.
- A run can report feedback about a memory it retrieved even when it proposes no candidate. Accept bounded `retrieval_feedback`, validate each reference against the exact v2 pack/record/version, and persist native v2 feedback bindings.
- The shared receipt core takes the already-authorized `{ plane, resourceRowId }` context explicitly. It must not infer harness authorization from `candidates[0]`, fabricate a candidate, or discard feedback while adapting to v1 storage.
- `request_changes` is removed from the first v2 decision contract. The supported reviewer decisions are `approve | reject`.

### 2.6 What remains intentionally

- candidate -> validation/review -> activation;
- exact organization/project/resource authorization;
- immutable record versions and retrieval packs;
- writer-owned transactions and request-digest idempotency;
- retention, revocation, expiry, quarantine, and erasure;
- v1 `org` plane for internal canonical producer intake;
- v2 public `codebase` and `harness` planes. Unreachable public v2 `content`/`org` plumbing is removed.

### 2.7 Keep PIM harness-neutral; make Fiesta an adapter

- `harness_id`, harness/workflow/adapter versions, configuration identity, model identity, and tool identity are opaque consumer-supplied selectors authenticated against an exact PIM harness resource. PIM never branches on a known harness name.
- Replace the active v2 `FiestaCodeEvidenceV2` / `fiesta.code-evidence.v2` contract with a PIM-owned `CodeEvidenceManifestV2` / `pim.memory-code-evidence.v2` contract. V2 generated types, SDKs, HTTP, and MCP use only the generic name. Historical stored v1 payloads may retain Fiesta-shaped bytes solely for exact replay, which happens before new-request parsing; a narrowly isolated v1 compatibility boundary may recognize the legacy shape but may not leak it into the service core or define new v2 intake.
- Remove `MEMORY_FIESTA_REPOSITORY_ID`, `verifiedFiestaMerge`, `verified_fiesta_merge_required`, `fiesta_merge_*`, and equivalent consumer-specific decisions from active PIM paths. Codebase lessons resolve verified code evidence through their authenticated repository resource and provider attestations. Harness-plane lessons use generic runtime evidence and authorized review.
- Validation follows the declared generic strategy. Failure-derived lessons require an exact stable failure fingerprint. Successful-run lessons may use applicable runtime-attestation or authorized-review evidence and must not be rejected merely because their failure fingerprint is null.
- PIM fixtures and conformance tests use at least two neutral identities such as `example-harness-a` and `example-harness-b`, including cross-harness denial. Fiesta-specific fixtures belong to the Fiesta adapter slice (Slice 8), not the PIM core contract.
- Do not implement a plugin framework or registry of harness-specific behavior. The extension seam is the frozen contract plus exact resource registration, not server-side callbacks.

## 3. Branch-review corrections

| Finding | Verified status and action |
| --- | --- |
| F1 | Confirmed. Catch the unguarded v2 startup chain; a v2 failure must not prevent `app.listen()`. Use one small `ready | unavailable` state with a reason, not a new orchestration framework. |
| F2 | Confirmed in code, but cannot trigger on current prod data (0 harness bindings). Fix the strict-equality projector and calculate allowed operations in one canonical function. |
| F3 | Replace fabricated “verified at deploy” state with the explicit `legacy_cutover` trust basis in §2.3. |
| F4 | Keep the offline fence only until the one deliberate production migration. It gates the unshipped canonical-authority backfill migrations while CI auto-deploys `main`; delete it immediately after the cutover. Existing migrations are already transactional and checksummed. |
| F5 | Preserve stored v1 receipt replay: replay lookup happens before validation that applies only to a new request. `candidates: []` and optional repository remain valid. |
| F6 | Projection already runs in the mint transaction. Map `MemoryV2ResourceError` to a typed route error and prevent drifted memory companions from blocking minting of unrelated tokens. |
| F7 | Deduplicate harness claims by semantic scope and normalized claim, excluding run/receipt/candidate IDs. Land with the `memory-decisions.ts:147` version-convergence fix. |
| F8 | Admission is exercised through activation in live tests. Legacy cutover trust and new evidence-backed activation follow §2.3. |
| F9 | Remove the whole-body Luhn scanner. Retain secret-field rejection, size limits, and bounded-content checks. |
| F10 | Fix non-JSON error parsing in both SDK clients (`memory-v2-client.ts` and `memory-client.ts`). |
| F11 | Follow §2.4: one credential verification and one exact-resource authorization snapshot per request, with no mid-request revocation recheck. |

Additional verified corrections:

- `get_agent_session_context` calls `/api/knowledge/relevant`; it is not proof that v1 memory search returns Milo records. Test these separately.
- The current MCP adapter imports exposure-era shared types, so exposure deletion must update MCP code and generated contracts in the same change.
- Current readiness requires an active reverification policy and an unpaused worker. Rewrite that behavior so an intentionally disabled worker is healthy and trusted cutover records stay eligible.
- The harness write path currently rejects feedback, requires exactly one candidate, reads `candidate[0]`, and normalizes v1 feedback to `[]`. Replace that runtime path per §2.5.
- The otherwise-generic v2 resource and applicability model still inherits Fiesta-owned code-evidence names, while the legacy activation path contains Fiesta-specific environment, blocker, and provenance fields. Native harness intake also hard-requires a failure fingerprint even though the contract models successful runtime outcomes and non-failure subkinds. Correct these seams under §2.7 before freezing v2.
- Because migrations 012-018 are unshipped, edit them rather than carrying dead exposure columns forever. Reset disposable local/test databases.

## 4. Implementation slices

Revision 4 organized this work horizontally: one concern per phase, applied across every endpoint at once. These slices are vertical. Each ends with behavior that runs end-to-end against a real server, and each has explicit stop lines so guardrail and refactor work cannot grow past its purpose.

Ordering: Slices 1-5 are sequential; receipts (Slice 3) deliberately land before the authorization refactor (Slice 4) so the full harness loop is proven on the existing authorization code first, then authorization is unified underneath a working path. Slice 6 forks after Slice 1 and can run in parallel with Slices 3-5; it must land before Slice 7. Slices 7-9 are sequential.

Downtime during any slice is acceptable for every feature, including Pod context and skill conflicts. The hard constraints are only that the Adobecom/Milo data survives and that everything in scope works when Slice 7 verifies the launch.

Testing discipline, stated once instead of as per-phase gates: each slice writes the tests for the behavior it changes, inside the slice. Existing suites plus the Slice 7 verification are the regression net; add a test to code you did not change only when you are about to change it and it has none. The shared conformance table starts in Slice 3 with real assertions only (no expected-red placeholders) and gains rows as slices land; it is complete in Slice 5. The uncommitted working tree is organized by landing each slice as its own commit or small PR; there is no separate upfront commit-splitting pass.

### Slice 1: Shrink the surface in one pass

Deletions, the unshipped-schema rewrite, and the harness-neutral renames of §2.7 land together, because the renames and the deletions both force a full regeneration cycle and doing them separately churns every generated file twice.

Before changing code, take one transactionally consistent SQLite backup of production `/data/pim.db` for rehearsal, verify `PRAGMA integrity_check`, move it off-instance, and make a disposable working copy. Do not raw-copy a live WAL database and do not create an early count manifest. This setup is part of Slice 1, not its own commit, PR, or retained launch artifact; production is not mutated.

Delete outright:

- `services/memory-v2-exposure.ts`, `routes/memory-v2-exposure.ts`, `services/memory-v2-exposure-constants.ts`, and `services/memory-v2-benchmark.ts`;
- benchmark adjudication and kill-switch scripts plus their package entries;
- unused `resolveMemoryV2ReviewSignal`;
- `services/memory-release-gates.ts`, its route, and v1 prompt-canary/release-gate runtime code;
- generated Python contract output and its self-only smoke test;
- exposure/benchmark-only tests and unreachable generated types.

Then:

1. Rewrite unshipped migrations 012-017 to contain only the final resource, facet, pack, feedback, origin, and trust/reverification schema, including the `trust_basis` column from §2.3. Remove exposure operations, snapshot columns, prompt/routing fields, and their triggers/indexes at the source. Seed records active at deploy as trusted with `trust_basis = legacy_cutover` without falsifying evidence timestamps.
2. Replace unshipped `018-memory-v2-exposure.ts` with `018-memory-experiment-cleanup.ts`. It removes the verified-empty `memory_prompt_policies` and `memory_release_gate_decisions` tables plus their triggers/indexes after a preflight emptiness assertion; it does not remove receipt, review, evidence, outbox, erasure, or lifecycle data.
3. Inventory case-insensitive `fiesta` references in active server services, routes, middleware, migrations, v2 schemas, generated roots, SDK, and MCP. Classify each as active PIM coupling, an example to neutralize, or historical v1 replay compatibility.
4. Replace the v2 Fiesta code-evidence type and schema identifier with the PIM-owned generic form from §2.7 at the generator roots, and remove `MEMORY_FIESTA_REPOSITORY_ID`, consumer-specific merge lookup, environment configuration, blockers, messages, and provenance from active intake and activation. Preserve old stored v1 response bytes for replay without letting their shape leak into the new v2 request path. Use neutral examples in v2 fixtures.
5. Rewire v2 resource, read, write, reconciliation, readiness, route, capability, SDK, and MCP consumers so everything compiles against the simplified harness-neutral contract. Behavior repairs belong to Slices 2-4; this slice only deletes, renames, and rewires.
6. Preserve only the storage needed to replay historical v1 receipts; remove active arm selection and release decisions.
7. Regenerate every checked-in target from the schema. Run generation twice and require no diff on the second run. Never hand-edit generated output.
8. Add the source-level guard from §2.7: one grep-level test that fails if active v2 production code or contract roots introduce a Fiesta identifier or branch on a literal harness ID, excluding explicitly named historical v1 replay files and the later Fiesta consumer integration. A small check, not a framework.

Stop lines: no behavior changes beyond what compiling requires, no refactoring of surviving code while deleting, and MCP parity waits for Slice 4. The unshipped migrations stay editable until the Slice 7 rehearsal, so a later slice may amend them; this slice does not have to anticipate every future need.

**Exit:** no runtime or schema decision depends on a shadow arm, exposure, canary, benchmark, prompt gate, routing gate, or consumer-specific harness rule; fresh and prod-copy databases migrate cleanly through the new 018; the server boots; all 164 active Milo records are trusted under `legacy_cutover`; stored v1 receipt replay is green; the source guard is green.

### Slice 2: Small startup catch and honest trust at runtime

1. Catch the unguarded v2 startup chain (F1): one process-level availability value, `ready | unavailable`, with a bounded reason and timestamp. V2 routes return a typed 503 when unavailable; v1, Pod/context, skill-conflict, and other routes continue, and v2 migration/reconciliation/admission failures never block `app.listen()`. This is a try/catch and one flag, not a health subsystem; it exists because Pod features share the process, not to avoid downtime during development.
2. Implement the single disabled-by-default `MEMORY_V2_REVERIFICATION_ENABLED` switch from §2.3. Disabled is healthy (`worker_status: disabled`), not degraded readiness, and never suppresses trusted records.
3. Wire `legacy_cutover` versus `evidence_verified` into readiness and search/admission eligibility together, then test provider timeout/unavailable and explicit negative outcomes. Bound all provider calls.

**Exit:** a deliberately broken v2 migration, reconciliation, or worker cannot take down PIM; all 164 active Milo records remain trusted and eligible with the worker disabled.

### Slice 3: One harness, the full loop, over HTTPS

Against a real local server, on the existing authorization code, `example-harness-a` completes the entire consumer lifecycle over HTTPS: mint a credential, search the exact resource, submit receipts, receive a reviewer approval, retrieve the activated record, and lose access on revocation.

1. Implement generic zero-or-one candidate receipts and native bounded feedback per §2.5. Replay of stored rows happens before new-request validation, and the shared receipt core takes the already-authorized `{ plane, resourceRowId }` context explicitly.
2. Make harness validation strategy-driven per §2.7: stable failure fingerprints are mandatory only for failure-derived claims; runtime evidence from successful runs and authorized review remain valid for non-failure claims. Evidence, scope, tenant, resource, and review checks stay fail-closed. Keep the universal `0..1` candidate invariant in PIM; any more restrictive selection lives in each consumer adapter.
3. Implement semantic claim dedup with the decision projection/version-convergence fix (`memory-decisions.ts:147`) so an approval can converge on an existing record at version greater than one.
4. Remove `request_changes` from the v2 enum and all generated targets. Remove the Luhn scanner while retaining focused secret and payload-bound checks. Fix non-JSON error parsing in both SDK clients.
5. Start the shared conformance scenario, parameterized over `example-harness-a` and `example-harness-b`, covering what this slice makes real: issuance, exact-resource search, zero/one-candidate receipts, feedback-only receipts, replay, approval/activation, convergence, retrieval, revocation-on-next-request, and proof that A cannot read or write B. Transport and consolidation rows arrive with Slices 4 and 5.

Stop lines: no authorization refactor (fix only what blocks the loop), no MCP work, and no read/write core extraction; duplication is tolerated for one more slice.

**Exit:** the scripted lifecycle passes over HTTPS for both neutral fixtures, including cross-harness denial and one successful-run plus one failure-derived lesson.

### Slice 4: One authorization pass and the second transport

1. Implement the one-request authorization snapshot from §2.4 and pass already-authorized resource context through read/write services. Delete duplicate re-proof and binding lookups. Keep one canonical operation projector (F2) and typed mint errors (F6).
2. Finish the production MCP issuer/configuration path; advertise `mcp_surface.production_enabled: true` only when its credential and routes are usable.
3. Make HTTPS and MCP call the same core, normalize error codes, idempotency, lifecycle filters, and response models, and run the Slice 3 lifecycle script through MCP.
4. Extend the conformance table with the transport dimension and the denial matrix: revocation between requests, expiry, cross-org, cross-project, wrong plane, wrong repository/harness, cross-harness isolation, operation denial, and an allowed in-flight request over both transports.

Stop lines: reviewer/admin mutation stays HTTPS-only, so no MCP review tools. No transport abstraction beyond two thin adapters calling one core. No mid-request revocation.

**Exit:** an org admin can mint least-privilege credentials for any registered harness resource, every HTTPS request/MCP call performs exactly one authentication/authorization pass, and the same lifecycle passes through both transports.

### Slice 5: Consolidate reads and writes; prune dead surface

1. Extract one plane-neutral write core for idempotency, request digests, scope, pack/claim insertion, receipt persistence, and feedback; keep thin codebase/harness validation adapters.
2. Extract one plane-neutral read core for resource resolution, lifecycle/trust/applicability filtering, pack construction, replay, and detail/search behavior; keep thin codebase/harness response adapters.
3. Complete the table-driven conformance suite (two planes, two transports, two fixtures) and replace hand-maintained duplicated parity cases with it.
4. Delete replaced read/write implementations, unreachable helpers, public v2 `content`/`org` branches, stale schema exports, and generated types not reachable from a supported operation root.

Stop lines: extract only duplication the conformance suite actually executes on both sides; the slice's diff should be net-negative; no plugin system, plane registry, or generalized framework; stop when each business rule exists once, not when the code is abstractly pure.

**Exit:** each business rule exists once, adapters contain only real plane/transport differences, the known dead/generated surface is gone, and onboarding a new harness requires no PIM code, schema, or migration change before Fiesta begins.

### Slice 6: Repair or retire every frozen legacy producer (parallel after Slice 1)

Complete [Route Pod Learnings into Canonical Memory](./PLAN_POD_LEARNINGS_TO_CANONICAL_MEMORY.md) as part of this launch rather than leaving it as a post-Fiesta backlog. This slice touches the v1 org plane and legacy writers, so it can run alongside Slices 3-5 once the Slice 1 schema settles; it must land before Slice 7:

1. Pod archival and agent run/session rollups submit through the existing in-process canonical v1 receipt service when legacy writes are frozen; never dual-write and never call PIM over HTTP from itself.
2. Keep v1 `org` candidates as the internal representation. This does not expose a public v2 org plane. Candidates remain pending validation/review and never auto-activate.
3. Resolve the document's tenancy question now: use the real project when present; otherwise use one stable, reserved per-org system project for internal org-memory intake. Creation is idempotent and auditable.
4. Reroute ad-hoc knowledge submission to the same intake. Retire project/agent promotion paths superseded by canonical validation. Disable scheduled synthesis and dev seeding under frozen authority unless they use the canonical intake.
5. Inventory all callers of legacy graph/candidate writers and prove no production path can reach a frozen writer. Update the Pod plan, architecture docs, and job/event wording to distinguish “candidate submitted” from “memory active.”

**Exit:** Pod archival completes, rollups do not hit SQL fences, selected learnings arrive as canonical pending candidates, and no normal production path writes to a frozen memory store.

### Slice 7: Verify and deploy as one gate

Verification is the exit gate of the deployment slice, not a separate phase. First run the full matrix against a real server and database (the production copy), not only service-unit mocks:

| Capability | HTTPS | MCP | Required assertion |
| --- | --- | --- | --- |
| capabilities/readiness | yes | yes | same availability, planes, operations, worker-disabled semantics |
| exact resource binding | yes | yes | cross-tenant/project/resource and cross-harness denials match |
| search/detail/pack | yes | yes | same active record/version and lifecycle/trust filters |
| receipt/status | yes | yes | zero/one candidate, feedback, replay, idempotency |
| reviewer decision | admin HTTPS | not exposed | approve/reject, convergence, activation; ordinary harness credentials cannot review |
| revocation | yes | yes | next request denied; already-authorized request may finish |

Also verify separately, as end-state feature health rather than continuous availability during development:

- `/api/v1/memory/search` returns preserved Milo canonical records.
- `get_agent_session_context` still works through `/api/knowledge/relevant`; this is Pod regression health, not v1 memory evidence.
- Pod archival and agent rollups produce pending canonical candidates without frozen-writer errors.
- Skill-conflict routes still operate.
- Both neutral harness fixtures pass the same supported lifecycle without a literal harness-ID branch, including one successful-run lesson and one failure-derived lesson.
- Fresh-database, prod-copy migration, server, shared-contract, SDK, MCP, and generated-artifact suites are green.

Passing this matrix means all known PIM work in this plan is complete, both public transports pass the same deployed-server contract, and any conforming harness can depend on the frozen contract revision. Only then open the deployment window.

Downtime during the window needs no extra ceremony; the backup, the digest check, and the manifest comparison are the only safety artifacts, because they protect the only non-negotiable (the data).

1. Before the window, run the final migration/startup rehearsal on a fresh disposable copy of the Slice 1 production backup.
2. Stop PIM/writers. Checkpoint SQLite, create one off-instance backup with checksum, run `PRAGMA integrity_check`, capture the authoritative count manifest from that verified backup, and retain the backup and manifest.
3. Set `PIM_MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION`, deploy once, and verify that the running image digest changed (the digest-pinned systemd unit makes an unverified pull-and-restart a silent no-op).
4. Run migrations/startup, then compare the important Adobecom/Milo record, candidate/import, project-memory, and skill-catalog counts with the authoritative Slice 7 manifest. No active record may be retired by migration.
5. Using dedicated neutral harness smoke fixtures, call the production HTTPS and MCP smoke subset: readiness/capabilities, v1 Milo search, exact-resource v2 search, receipt -> approve -> activate -> retrieve, cross-harness denial, Pod context, Pod archival, skill conflict, and revocation-on-next-request.
6. Remove the temporary 012/013 fence in the immediate cleanup commit.

There is no shadow period, traffic canary, multi-day stabilization gate, exhaustive legacy characterization, or second schema release. If rehearsal, integrity, counts, digest, or smoke checks fail, stop and use the retained backup rather than layering fixes onto production.

**Exit:** production serves one approved harness memory through HTTPS and MCP, the protected data counts are intact, and every feature in scope (Pod context, archival, skill conflicts, v1 search) works.

### Slice 8: Fiesta as the first real harness adapter through both transports

Update the Fiesta handoff/design docs to remove shadow, exposure, and four-arm benchmark requirements, state explicitly that Fiesta is a consumer of the harness-neutral PIM contract, and pin Fiesta to the deployed contract revision. Fiesta integration must not require a PIM server code change, schema change, or migration. Then build the smallest complete slice:

1. **Interface and clients:** one Fiesta-owned implementation of the generic consumer memory interface, with HTTPS and MCP adapters, request IDs, idempotency keys, bounded timeouts, and typed errors. Run the same integration scenario once per adapter.
2. **Trusted scope:** derive organization/project/harness/configuration from trusted Fiesta runtime state, never model output; require exact resource match; ordinary workflow credentials cannot approve candidates.
3. **Retrieval/composition:** search once for the exact harness scope; validate pack, lifecycle, version, trust, and applicability; render selected memories into one bounded labeled context block; record exact record IDs/versions used.
4. **Receipts/resume:** persist the exact terminal receipt body and idempotency key before delivery; retry unchanged; support zero/one candidate and feedback. A PIM outage skips memory and queues the receipt without blocking the workflow.
5. **Control:** `off | on`, transport, endpoint, credential reference, timeouts, and bounded budgets. No Fiesta-side ranking, lifecycle, authorization, or governance system.

**Exit:** the Fiesta workflow passes against deployed PIM through both adapters and completes unharmed with memory off or PIM unavailable, with no Fiesta-specific branch or schema added to PIM.

### Slice 9: Prove real Fiesta influence

1. Baseline a real Fiesta workflow with memory off and capture prompt/actions.
2. Submit and approve a uniquely identifiable lesson for that exact workflow.
3. Run with memory on and assert that exact record/version appears in model input and causes the expected observable action, ending in a terminal receipt.
4. Repeat the retrieval/receipt path through the other transport.
5. Revoke the lesson and prove it is no longer composed.
6. Make PIM unavailable and prove Fiesta completes and retains its receipt for retry.
7. Retain one bounded trace linking activation -> pack -> prompt -> action -> receipt.

**Exit:** there is inspectable evidence that a governed PIM memory changed a real Fiesta execution.

## 5. Explicitly out of scope

- Broader statistical quality/impact evaluation across many Fiesta runs. That requires real consumer traffic and follows the deterministic influence proof.
- Public v2 `content` or `org` planes and any additional consumer-specific planes. Add one only when a concrete consumer requires it.
- A plugin framework, server-side harness registry, or support for arbitrary consumer-specific evidence semantics. Conforming harnesses use the frozen generic contract; a genuinely new semantic requirement earns an explicit future contract revision.
- Mid-request credential revocation/cancellation. Revocation applies to the next request by design.
- A generalized plane framework, separate ranking service, or second governance system.

Read-path consolidation, write-path consolidation, MCP production support, reverification semantics, frozen-producer repair, and generated/dead-code pruning are **not deferred**. They are PIM completion gates before Fiesta.

## 6. Verification cadence

Each slice runs the tests for what it changed; slices that touch generated code also run contract generation twice and require no diff. The full pre-deployment battery runs once, as the gate inside Slice 7: migrations on fresh and production-copy databases; v1 search/replay regressions; Pod/context and frozen-producer integrations; server, shared-contract, MCP, and SDK suites; the two-neutral-harness isolation/lifecycle suite; the active-v2 Fiesta-identifier guard; and the HTTPS/MCP conformance matrix. After deployment, use only the bounded production smoke subset in Slice 7.

Each slice lands as a reviewable commit or small PR. A slice is not complete when unit tests alone pass; its exit behavior must work through the public endpoint or MCP tool where applicable.

## 7. Final definition of done

- Shadow, exposure, canary, benchmark, prompt/release gates, and their dead schema/code/generated artifacts are gone.
- The active v2 PIM contract, service core, transports, SDK, migrations, and generated roots are harness-neutral: no Fiesta-owned schema, literal harness-ID branch, consumer-specific environment variable, blocker, or provenance field remains. Historical v1 response bytes may replay unchanged.
- `example-harness-a` and `example-harness-b` pass the same credential -> search -> receipt/feedback -> review/activation -> retrieval -> revocation lifecycle, including cross-harness denial and both successful-run and failure-derived evidence.
- Onboarding another conforming harness requires only exact resource registration, least-privilege credentials, a consumer-owned adapter, and conformance; it requires no PIM server code, schema, or migration change.
- Unshipped migrations contain the final design; shipped migrations and stored receipt replay remain valid.
- V2 failure cannot crash or block PIM; disabled reverification is healthy; legacy Adobecom/Milo records remain active under honest `legacy_cutover` trust.
- Every request authenticates/authorizes once. HTTPS and MCP are production-usable thin adapters over one core and pass the same conformance matrix.
- Zero/one-candidate receipts, feedback-only receipts, replay, semantic dedup, and convergent activation work at runtime.
- Shared read/write behavior exists once; known frozen writers, dead helpers, duplicated plane branches, and unreachable generated types are gone.
- Pod archival, rollups, canonical memory, session-context regression health, and skill conflicts all pass independently.
- One rehearsed offline deployment preserves the verified production counts and passes bounded real-endpoint smoke tests.
- Fiesta is the first real consumer of the deployed generic contract, uses it through both adapters without PIM changes, persists durable receipts, survives PIM outage, and one traceable approved lesson changes one real workflow.

Anything less leaves PIM unfinished or Fiesta unproven.
