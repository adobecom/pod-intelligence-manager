# Memory v2 Platform: Full Branch Review

> **Historical branch review.** Findings in this document drove the simplification that removed
> the benchmark/exposure/canary subsystem. See [MEMORY_API.md](./MEMORY_API.md) for the current
> surface and [PIM_TO_FIESTA_IMPLEMENTATION_HANDOFF.md](./PIM_TO_FIESTA_IMPLEMENTATION_HANDOFF.md)
> for the current consumer handoff.

**Scope:** every change on `podFix` (baseline `5161be7`), all uncommitted working-tree work implementing the Universal Memory Platform (slices 0-8).
**Reviewed:** 2026-08-10 | **135** changed paths | **~70k** new lines (~25.5k production TypeScript)

---

## Verdict

**The build quality inside each component is high; the risk sits between components and in what was chosen to be built.** Test suites are near-green (1228/1229 server, 31/31 MCP, SDK green, typecheck clean), transactions are writer-owned, and the governed loop matches the spec faithfully. But eleven confirmed defects survived adversarial verification, and five of them are variants of one structural mistake: a subsystem that is explicitly shadow-only can crash-loop or brick the entire PIM server.

Directionally, the branch executed the spec with discipline, but the spec rejected the repo-native delivery recommendation at the center of the project's own value thesis. The platform currently has **no consumer** (zero in-repo callers; Fiesta integration unbuilt), **no proven value** (the harness influence benchmark was never run on real traffic), and **no supply** (the cutover froze legacy writers but pod archival and agent rollups were never rerouted, so new learnings go nowhere).

Recommended order of work: fix findings F1-F4 (each is a guaranteed or near-guaranteed production outage on the documented deploy path), commit the branch in reviewable slices, reroute the two broken producers, then build the repo-native projection slice. Defer everything else until a consumer demands it.

| Metric | Result |
|---|---|
| Confirmed findings | 11 (0 refuted) |
| Merge blockers | 4 (availability) |
| Server tests | 1228/1229 |
| MCP + SDK tests | green |
| Typecheck | clean |
| Review depth | 32 agents, 31 verified candidates |

---

## Part 1: Correctness (11 confirmed findings)

Every finding below was independently re-verified against the code (31 candidate findings pooled from four finder passes, 26 verifier agents, zero refuted, deduplicated to ten distinct defects; F8 was additionally confirmed by executing the test suite). Ordered most severe first.

### Availability blockers: shadow-only v2 holds the whole server hostage

One policy error repeated four ways. Fail-closed for a shadow feature should close the `/api/v2/memory` surface and mark readiness degraded; on this branch it refuses `app.listen`, taking down pods, the living doc, tunneling, the UI, and the knowledge graph with it.

#### F1 | Critical | correctness
`packages/server/src/index.ts:196` (also `index.ts:213`, `memory-v2-reverification-admission.ts:501`)

**Any memory-v2 companion-data inconsistency is startup-fatal for the entire PIM server, not just the shadow-only v2 surface.**

`index.ts` runs six read-only verifiers at module load (lines 190-199, plus `assertMemoryV2StartupReconciled` at line 213, which throws in `memory-v2-startup-reconciliation.ts:1621`) and `reconcileMemoryV2ReverificationAdmissions` (line 200, which throws when more than 10,000 records need admission). A single drifted row, one FK violation, one digest mismatch, or one facet row lost to a crash between a legacy v1 write and its v2 companion makes the process throw before it binds the socket. On the EC2 host the service crash-loops and **every PIM function goes down**, caused by an inconsistency in a subsystem that influences nothing. There is no env flag, degraded mode, or bypass. This is the previously observed startup-fatal reconciliation defect, still present.

#### F2 | Critical | correctness
`packages/server/src/services/memory-v2-resources.ts:758`

**A strict operations-equality check contradicts migration 012's harness projection, so any pre-cutover harness token crashes every boot after the cutover.**

Migration 012 projects harness token bindings without `runtime_attestation_write` (`012-memory-v2-resources.ts:397-421`), but the runtime mapping includes it for `memory:harness:receipt:write` (`memory-v2-constants.ts:96`). On the next startup, `backfillLegacyMemoryTokenBindings` recomputes operations and compares them to the row migration 012 just wrote via strict JSON equality (lines 751-764); the mismatch throws at module top level. **Any org with one pre-existing harness-scoped service token never boots after the offline cutover.** The reconciler carves out pre-012 tokens (lines 1160-1163) but the projector does not, so the two disagree; the inverse path through `createMemoryHarnessPrincipalBinding` then fails the reconcile carve-out on the following boot via F1.

#### F3 | Critical | correctness
`packages/server/src/services/memory-v2-reverification.ts:1030`

**Boot auto-admits every existing active record into reverification, and the fail-closed worker then silently retires legacy memories when evidence is unavailable.**

`index.ts:200` enrolls all pre-existing active prompt-eligible v1 records at first boot; the 30-second interval worker then re-verifies each against GitHub or runtime attestations. For records whose evidence can no longer be resolved (old merges, missing GitHub credentials on the host, provider outage, all mapped to outcome `unavailable`), once `max_age` (7 days from `last_verified_at`, which legacy records may already exceed) plus the 6-hour grace elapses, the record is transitioned to `stale`. **Reviewed org memories that served v1 search for months silently vanish within hours to days of deploying**, with no operator action and no signal except the missing results.

#### F4 | Critical | correctness
`packages/server/src/db/migrations.ts:43` (also `:35`)

**Migrations 012/013 throw in production unless a cutover env var is set, so a routine redeploy of this build bricks the hosted server at boot.**

An operator does the documented normal deploy (pull image, restart the systemd unit). `runSchemaMigrations()` hits unapplied migration 12, `assertOfflineMemoryV2CutoverConfirmed` throws "Schema migration 12 requires the stopped-writer memory v2 offline cutover", the import of `db/schema.ts` fails, and the entire server (including all v1 and non-memory routes) crash-loops until someone manually sets `PIM_MEMORY_V2_OFFLINE_CUTOVER_CONFIRMATION`. Nothing in the repo's deploy tooling or systemd unit sets it. The fence is intentional per the cutover runbook, but it converts an ordinary deploy of this branch into a full outage, and the known digest-pinned-unit deploy footgun on this host would make the failure harder to diagnose.

### Request-path regressions

#### F5 | High | correctness
`packages/server/src/services/memory-receipts.ts:482` (also `:248`, `:461`)

**The frozen v1 receipt contract is broken: empty-candidate receipts now 400, and the check runs before idempotent replay.**

`receiptCompanionScope` (lines 207-251) demands either a repository binding or a non-empty all-harness candidates array, else throws 400 `schema_invalid`. The frozen v1 contract allows `candidates: []` (no `minItems`; the canonical fixture uses an empty array) and makes `repository` optional; the v1 harness route explicitly forbids `repository`. So an outcome-only run receipt (failed run, no learnings) that previously returned 200 now gets 400. Worse, the scope is computed **before** `findReceipt` replay, so retrying a receipt stored before this change also 400s instead of replaying the stored result; idempotent PUT semantics on the frozen endpoint are broken for existing rows.

#### F6 | High | correctness
`packages/server/src/services/service-tokens.ts:456`

**Service-token minting now atomically depends on the memory-v2 resource projection and fails on any projection drift.**

Old `createServiceToken` committed once the token and binding inserts succeeded. The new internal path calls `projectMemoryV2BindingsForToken` inside the same transaction, projecting every bound repository and harness into `memory_v2_resources`; any projection failure (drifted or missing resource row, alias or scope mismatch on one repository) rolls the whole token back, and the MCP-profile insert's bare catch maps every error to 503. **Admins cannot mint any memory-scoped token**, including legacy-plane consumers, until v2 companion state is manually repaired.

#### F7 | High | correctness
`packages/server/src/services/memory-decisions.ts:129` (also `:208`)

**Approval-time harness claim dedup is skipped for native-v2 receipts, so identical claims from different runs mint duplicate active records.**

Previously, approving a harness candidate whose claim matched an existing active record reused that record or 409ed on content mismatch. Now, for receipts with a `memory_v2_scope_snapshots` row, the claim lookup is bypassed (`!isNativeV2HarnessReceipt`) and the claim digest embeds `native_projection_identity.candidate_id`, so every native approval mints a fresh record even for byte-identical statements. Two runs reporting the same tool constraint yield **two active records with identical claims**: search returns both, double-spending the token budget, and superseding or revoking one leaves its twin active with no path to converge.

#### F8 | Medium | correctness
`packages/server/src/services/memory-v2-harness-write.ts:1062`

**Harness writes never seed reverification state, so readiness for a fresh record fails closed to "degraded"; one test is red because of it.**

Admission lives only in the separate admission service; the harness write path has zero references to it. The uncovered-records query (`memory-v2-reverification.ts:1500-1520`) counts a freshly written record as failed-closed because no state row exists, so readiness reports `degraded` when nothing is wrong. Confirmed by execution: `memory-v2-client-live.test.ts:463` fails expecting `healthy`, the only red test in 1,229. Either admission should run at write time, or the readiness semantics and the test expectation need to be reconciled.

### Lower severity

#### F9 | Medium | cleanup
`packages/server/src/services/memory-v2-input-safety.ts:64`

**The Luhn payment-card scanner false-positives on ordinary 13-19 digit identifiers and rejects the whole write.**

`containsPaymentCardNumber` flags any embedded 13-19 digit run that passes Luhn (roughly 10% of random 13-digit numbers; epoch-millisecond timestamps are 13 digits), and the hash exemption only covers hex. A legitimate receipt containing "completed at 1754870400026" or a numeric CI build ID is rejected with `disallowed_personal_data`: intermittent, content-dependent 4xx failures on valid data, and the receipt is lost.

#### F10 | Low | cleanup
`packages/sdk/src/memory-v2-client.ts:59`

**The SDK calls `response.json()` unconditionally, so non-JSON error bodies throw SyntaxError instead of the typed error.**

When CloudFront or the ALB returns an HTML 502/503/504 or an empty body, `await response.json()` throws before `PimMemoryV2ApiError` is constructed. Consumers that catch the typed error to branch on `statusCode` instead get an unhandled "Unexpected token <" with no status information.

#### F11 | Low | simplification
`packages/server/src/middleware/service-authz.ts:29`

**Every v2 request re-proves the just-verified token with a 5-way join and full scope-set equality.**

Every v2 call already passes `verifyServiceToken` (hash lookup, expiry, revocation, principal checks). `authorizeMemoryV2Resource` then re-runs a 5-table join with `json_each` scope matching plus a sorted scope-array equality against the same immutable token row, then a third query for the resource binding. Token scopes cannot drift after issuance, so the guard protects against nothing; the costs are two extra queries per request on the hot path and a second copy of validity logic that can silently diverge from the verifier (the expiry parse already differs), at which point valid tokens receive misleading `principal_unavailable` denials.

---

## Part 2: Direction

### What the branch gets right

- **Additive facets, not a second store.** v1 canonical records stay the single authority; v2 layers typed facets, resource bindings, and quarantine on top. The offline-cutover discipline (checkpoint, backup, ledger verification, one-shot confirmed apply) is genuinely careful.
- **Shadow before influence.** The harness plane cannot touch prompts or routing without a predeclared, budget-matched benchmark gate (frozen protocol digest, exactly 30 runs per arm per stratum, optional stopping rejected). The gate has correctly not been passed, so both channels are off.
- **Quarantine over guessing.** Ambiguous legacy records get a `subtype_ambiguous` quarantine row, readable by v1 and invisible to v2, instead of an invented subtype.
- **The slice plan held its own tripwires.** Ten "never in this plan" rules (no plugin frameworks, no speculative resolvers, content/org planes frozen at contract seams) were mostly honored, and the origin-quorum was explicitly deferred as over-engineering.

The Aug-2026 industry sweep concluded these specs are ahead of every shipped platform on governance, and the implementation delivers that spec with unusual fidelity: all nine slices built, HTTP/MCP conformance passing with zero boundary divergence.

### The core tension: the code contradicts its own thesis

The value thesis (Aug 1) and the industry alignment sweep (Aug 6) both concluded that the value of a memory platform sits in the curation loop and repo-native delivery, not the store. The alignment doc's own words:

> "A state-of-the-art trust kernel with expensive contribution and an API-only surface becomes the strictest store nobody fills... an API-only surface with no repo-native projection would be criticized as a moat, not a feature."

The spec adopted several thesis recommendations (budget-matched arms, the reverification loop, codebase+harness first) but explicitly rejected the central one: spec section 9 defers rendering memory into instruction files, and section 21 lists repo-native materialization as a non-goal. What shipped is exactly the predicted shape. A minimal canonical write requires a project-bound token, a resource binding, an idempotency key, a client-computed canonical digest, and **36 required leaf fields, plus 27 more per candidate**, roughly a third of them echoes of values the server already knows. The write yields only a pending candidate; activation requires a second artifact (merge verification or a 9-field review decision).

### Three facts that undercut the demand side

- **No consumer.** The entire v2 surface (14 HTTP routes, 8 MCP tools, 16 SDK methods) has zero in-repo callers outside tests. The handoff doc states Fiesta integration "remains to be built." The MCP data plane shipped with no admitted pilot; MCP-E (production enablement) is closed.
- **No proven value.** The harness benchmark release is explicit that its fixtures are synthetic and "not represented as production evidence." The prior Fiesta ablation found approximately zero downstream lift from PIM memory, and that unfiltered recall halved pass rates: precision over recall.
- **No supply.** The cutover froze legacy writers, but two producers were never rerouted: pod archival (`org.ts:472` -> `knowledge-graph.ts:499`) and agent rollups (`agent-memory.ts:2420/2829`). Pod learnings currently go nowhere and the archive job reports an error. The fix plan (`docs/PLAN_POD_LEARNINGS_TO_CANONICAL_MEMORY.md`) is still Status: Proposed, with an unresolved tenancy decision blocking Phase 1.

### Directional recommendation

The store and its governance are done and good; stop investing there. The work that produces value next, in order:

1. Reroute the two broken producers so the platform has supply.
2. Build the repo-native projection slice the thesis sized at about two weeks (PIM opens a PR adding one verified lesson to a repo's agent instructions, and the next agent run avoids the trap).
3. Only then revisit exposure and influence, gated on the real benchmark.

Everything else on this branch can wait for a consumer to demand it.

---

## Part 3: Over-engineering and over-rigor

### The honest accounting

| Bucket | Size | Note |
|---|---|---|
| Untracked new code | 62,861 lines | 91 files |
| of which tests | 24,115 (38%) | includes a 4,154-line MCP suite |
| of which contract artifacts | 13,088 (21%) | 9,434 generated TS + Python; 3,654 hand-written schema/fixtures |
| production TypeScript | ~25,500 | 21 `memory-v2-*` services (18,295 lines), 7 route files (3,082) |
| Modified tracked files | +7,156 / -388 | ~2,600 of it tests |
| New schema | 30 tables | migrations 012-018, 2,972 lines |

### The structural pattern: rigor at the wrong blast radius

The same fail-closed instinct behind F1-F4 recurs at smaller scales: per-request re-proof of an immutable token (F11), four contract parses plus post-insert read-back assertions on a single write, and mid-search re-authorization callbacks from the v1 engine back up into the v2 layer. A canonical write crosses **five named service layers** between route and SQLite; every search is also a write (immutable retrieval-pack rows). Rigor is fine; pointing it at the process and the hot path instead of the feature surface is the pattern to unwind.

### Specific over-engineering, ordered by payoff to fix

- **The 4-file read/write split (5,484 lines).** code-write vs harness-write share 14 identically named private functions; code-read vs harness-read share 15 of 30. There is no shared base module: idempotency claims, scope digests, v1 downcasting, and error classes are each implemented twice, and 40-50% of each file is a plane-suffixed near-duplicate of its sibling. F7 (dedup skipped on one of the two paths) is the predictable cost. Extract a plane-neutral core before a third plane exists.
- **Exposure machinery (2,337 lines + 554 routes + 458 migration)** whose arm logic can only ever produce `shadow` or `canary`, whose three HTTP endpoints have zero callers, and whose kill switch is reachable only through a 90-line CLI drill script. The capabilities endpoint hardcodes `mcp_surface.production_enabled: false` while `index.ts` registers `/mcp/memory` unconditionally.
- **Hand-maintained parity (1,525 lines for 9 cases).** The parity suites fan one operation through v1 HTTP, v2 HTTP, and MCP, then deep-equal hand-written 10-field projections. There is no operation table generating them; each new endpoint means hand-writing builders, normalizers, and SQL effect checks, and nothing fails automatically when a surface drifts except an 8-name tool-list check. Generate parity from a table or accept a thinner suite.
- **Dead weight to delete now:** the Python contract output (its only consumer is its own smoke test), 40 of 125 generated type exports with zero references, `resolveMemoryV2ReviewSignal` (zero references), the 696-line benchmark module inside the production server package (move to a tools package), and the content/org planes carried as enum values through every layer only to be rejected at each.
- **Undocumented configuration:** 10 of 12 env knobs appear nowhere in the docs; `MEMORY_V2_REVERIFICATION_WORKER_PAUSED` is a production kill switch with one read site, zero docs, zero tests. The reverification policy's 7 knobs are only ever set through an injectable test param.
- **Input-safety ceremony (F9):** a Luhn scanner on machine-generated receipt payloads costs real writes and blocks no realistic PAN exposure path.

### What is not over-engineering

- The data-governance growth (+799 lines: 13 erasure helpers) and metrics growth (+498) are the proportional cost of 30 new tables, not gold-plating.
- Writer-owned transactions, idempotency keys with request digests, and the kill-switch compare-and-set discipline are all defensible.
- The docs are honest about their own limits: the unexecuted production cutover, the synthetic benchmark, the sandbox hole in the conformance run, and the deferred origin quorum are all flagged in the artifacts themselves.

---

## Appendix: status, process, and method

### Doc-claimed status vs. reality

| Item | Claimed | Observed |
|---|---|---|
| Slices 0-8 | Implemented and validated | Code present; 11 confirmed defects; 1 red test |
| Slice 1 production cutover | Runbook written | Explicitly not executed in production |
| HTTP/MCP conformance | PASS, zero divergence | One case excluded (sandbox denies listeners); staging rerun advised |
| Harness benchmark | Complete in shadow | Synthetic fixtures only; both influence channels off |
| MCP production enablement (MCP-E) | Closed pending pilot | Consistent; no pilot admitted |
| Pod learnings -> canonical memory | Status: Proposed | Ingestion currently broken (two unrerouted producers) |

### Process risk

All ~70k lines sit as a single uncommitted working tree on a branch named `podFix`. Before touching any finding, commit in reviewable slices (the slice structure already exists in the docs). As it stands, this work is one `git clean` away from vanishing, and incremental review is impossible.

### How this review was run

Three independent streams on 2026-08-10:

1. A workflow-backed correctness review at high effort: four finder passes (correctness angles plus a cleanup/over-engineering pass), 31 candidate findings, 26 independent verifier agents, zero refuted, deduplicated to ten distinct defects.
2. An architecture and proportionality sweep of every changed path (layer map, surface inventory, generated-contracts pipeline, dead-surface audit, contribution-cost walkthrough).
3. A synthesis of all thirteen design docs on the branch against the value thesis and industry alignment research.

Independently, full typechecks and the server, MCP, and SDK test suites were executed; the single red test became F8.
