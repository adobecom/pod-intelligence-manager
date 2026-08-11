# Plan: Route Pod Learnings into Canonical Memory

**Status:** Implemented on 2026-08-10 as Memory v2 simplification Slice 6
**Scope:** Closure of the post-cutover ingestion gap that previously left Pod archival and agent rollups pointed at frozen legacy memory stores.

## Implementation outcome

This section records the shipped Slice 6 choices and supersedes proposal text below where the later simplification plan changed it:

- `packages/server/src/services/canonical-legacy-intake.ts` is the single adapter for Pod archival, agent run/session rollups, and ad-hoc intake. It contains the only call from these producers to the existing in-process `acceptMemoryRunReceipt` service. There is no self-HTTP call, direct canonical insert, marker receipt, or dual write.
- The universal receipt bound is `0..1`, so the adapter submits one deterministic receipt per selected learning. Selected learnings are ordered by confidence and a normalized immutable source/content digest, independent of extractor array order. Reordered retries replay. Changed content in a stable source slot raises the typed `canonical_legacy_intake_content_conflict`.
- The real project is used when present. Podless/sessionless/ad-hoc output uses one stable reserved project per organization, created lazily and idempotently at first selected output.
- Source material is preserved in bounded candidate extensions and covered by generic immutable `pim://memory-source/...` evidence. No Fiesta-owned evidence or identifier is introduced.
- The v1 `org` plane is allowed only for the reserved internal PIM producer. Its v2 companion is explicitly quarantined as `unsupported_plane`; no public v2 org resource, schema, operation, or route was added.
- Org candidates enter `received / validation_pending`, validate to `pending_review / manual_policy_owner_required`, and cannot take an automatic activation path.
- Pod archive jobs expose additive `selected`, `dropped_low_confidence`, `dropped_unmappable`, and `dropped_over_cap` counters. The `memory_candidates_submitted` event and `candidate_submitted` response explicitly mean pending validation/review, not active memory.
- Project evidence remains searchable, but frozen project/agent legacy candidate creation, validation callbacks, promotion, and rejection writes are retired/fenced. Scheduled synthesis and development seeding return before graph/LLM/ingestion work under frozen authority.

The complete caller disposition is recorded in [MEMORY_V2_SLICE_6_FROZEN_WRITER_INVENTORY.md](./MEMORY_V2_SLICE_6_FROZEN_WRITER_INVENTORY.md). Focused route/service regressions cover Pod archival with real/reserved tenancy, ad-hoc intake, run/session rollups, reordered replay and content conflict, pending review lifecycle, project evidence without promotion, and synthesis/seed suppression.

---

## 1. The original gap, precisely

The canonical-memory cutover froze all legacy memory writers, but two producers were never rerouted to the canonical intake:

| Producer | Current write path | What blocks it when legacy is frozen |
|---|---|---|
| Pod archival | `extractArchiveLearnings` (`packages/server/src/routes/org.ts:472`) calls `ingestLearnings` (`org.ts:485`), which calls `addLearningsToGraph` (`packages/server/src/services/knowledge-graph.ts:491`) | `assertLegacyMemoryWritable("knowledge_graph_ingestion")` at `knowledge-graph.ts:499` throws `LegacyMemoryAuthorityFrozenError` |
| Agent run/session rollups | `rollupAgentRun` (`packages/server/src/services/agent-memory.ts:2420`) and `rollupAgentSession` (`agent-memory.ts:2829`) insert into the legacy `memory_candidates` table (`agent-memory.ts:2541`, `agent-memory.ts:2779`) | SQL triggers installed by `installLegacySqlWriteBarriers` (`packages/server/src/services/memory-authority.ts:85`) abort with `legacy_authority_frozen` |

Concrete failure today: archiving a pod under frozen legacy authority runs `runArchiveExtractionJob` (`org.ts:440`), the graph write throws, the catch at `org.ts:461` marks the job **failed** and extraction **pending**. The pod row itself archives fine, but its learnings go nowhere and the archive job reports an error. Rollups fail similarly at the SQL layer.

Meanwhile the canonical intake already exists and is the correct target:

- `PUT /api/v1/memory/run-receipts/:producer_run_id` (`packages/server/src/routes/memory-receipts.ts:99`) validates a typed `RunReceiptV1`, then `acceptMemoryRunReceipt` (`packages/server/src/services/memory-receipts.ts:392`) persists the receipt, evidence manifest, and candidates.
- `insertMemoryCandidate` (`packages/server/src/services/memory-candidates.ts:149`) writes each candidate into `memory_candidates_v1` with status `received`, blocker `validation_pending`, and enqueues a validation job on the memory outbox (`memory-candidates.ts:234`).
- Candidates only become searchable after validation and activation (`markMemoryCandidateActive`, `memory-candidates.ts:494`). Nothing goes live automatically.

**Goal:** when legacy authority is frozen, pod archival and rollups submit selected learnings as canonical candidates (pending validation, never auto-active) and stop touching the legacy graph and candidate table. Orgs still on legacy authority keep the existing behavior unchanged.

---

## 2. Design decisions

### 2.1 Enter through the receipt service, not a new side door

Submit via a direct in-process call to `acceptMemoryRunReceipt` with a synthetic `RunReceiptV1`, not by inserting into `memory_candidates_v1` directly and not over HTTP.

Why: `acceptMemoryRunReceipt` is where idempotency (receipt replay on `producer_run_id`), evidence-manifest persistence, candidate digests, transitions, and the validation outbox all hang together. Calling `insertMemoryCandidate` directly would bypass the receipt audit trail and force us to reimplement evidence-row plumbing (`memory-candidates.ts:227` throws if an `evidence_ref` has no manifest row). Going over HTTP would require minting service tokens for the server to talk to itself.

This preserves the "typed receipt/candidate API is the single canonical intake" invariant; pod archival becomes just another producer.

### 2.2 Producer identity

- `producer_run_id`: `pod-archival:<pod_id>` for archival (one logical receipt per pod archive; retries replay), `agent-rollup:<run_id or session_id>` for rollups.
- `principalId`: a reserved internal principal, e.g. `pim-internal:pod-archival` / `pim-internal:agent-rollup`, so transitions and receipts are attributable and distinguishable from external harness traffic.
- `repository: null` (pod learnings are not repo-anchored).

### 2.3 Candidate mapping (`EnhancedPodLearning` to `MemoryCandidateV1`)

The contract (`packages/shared/src/types/memory-contracts.generated.ts`, `MemoryCandidateV1`) requires `plane`, `kind`, `content`, `applicability`, `validation`, `evidence_refs`, `source_run_ids`, `activation_requirement_requested`.

- **plane:** `org`. Pod learnings are organizational knowledge, not codebase- or harness-bound.
- **kind mapping** from `KnowledgeNodeType` (`packages/shared/src/types/graph.ts:8`):

  | Learning type | Candidate kind |
  |---|---|
  | `decision` | `decision` |
  | `pattern` | `constraint` (a positive practice to follow) |
  | `anti_pattern` | `anti_pattern` |
  | `resolved_conflict` | `decision` |
  | `scope_insight` | `constraint`, or **drop** if it fails the selection filter (see 2.4) |

  Review this table during implementation; any type we drop must be counted and logged, never silently discarded.
- **applicability (`OrgApplicabilityV1`):** `audience` from the learning's `scopes`/`domains`, `policy_owner` = pod name (falls back to org), `effective_from` = archive timestamp, `project_ids` = `[pod.project_id]` when present.
- **content:** summary/details/retrieval_text carried over; entity refs preserved.
- **client_candidate_id:** deterministic, `pod:<pod_id>:<sha256(summary + details).slice(0,16)>`, so re-archival of identical extractions dedups inside `insertMemoryCandidate` instead of duplicating.
- **activation_requirement_requested:** always request review-gated activation. This is the explicit product requirement: pod learnings land as candidates **pending validation, not automatically active**. `deriveActivationRequirement` (`memory-candidates.ts:104`) remains the authority regardless of what we request.
- **evidence_refs:** point at manifest refs built from the pod's provenance: living-doc snapshot ref, source context-update ids, source pod id. Every candidate ref must resolve to a manifest row or the insert throws.

### 2.4 Selection, not a firehose

Only "selected" learnings cross over:

- `confidence_score >= threshold` (org-tunable via the existing org-tuning mechanism; default 0.6).
- Mappable kind per the table above.
- Per-archive cap (default 25) to bound validation-pipeline load; overflow is logged with counts.

Dropped learnings are still visible in the archive job result (`selected`, `dropped_low_confidence`, `dropped_unmappable`, `dropped_over_cap` counters) so nothing disappears silently.

### 2.5 Authority-aware branching, no dual writes

Branch on `getMemoryAuthorityState()` (`memory-authority.ts:29`):

- `legacyWritesFrozen === true` (post-cutover): canonical route **only**. The legacy `ingestLearnings` call is not made at all.
- Legacy authority (not cut over): existing behavior unchanged, byte for byte.

Never write both stores; dual-writing recreates the divergence the cutover was designed to end.

### 2.6 Tenancy for podless projects (open decision)

`RunReceiptV1.tenant.project_id` and `memory_candidates_v1.project_id` are required, but `pod.project_id` is optional (`org.ts:477`). Options:

1. **(Recommended)** A reserved per-org system project (e.g. `proj-org-memory`), created lazily at first use, that holds org-plane candidates from pods with no project link.
2. Skip canonical submission for podless pods and report `dropped_no_project` (loses learnings; not preferred).

Confirm option 1 with whoever owns memory tenancy before implementation; it touches project binding checks.

---

## 3. Implementation phases

### Phase 0 (optional, only if Phase 1 will not ship immediately): stop failing archives

In `runArchiveExtractionJob` (`org.ts:440`), catch `LegacyMemoryAuthorityFrozenError` specifically: complete the archive with `learnings_extracted: 0` and a `learnings_deferred: true` marker instead of marking the job failed. Note: the current failure mode already leaves extraction `pending` (`markArchiveExtractionPending`, `org.ts:463`), which is the recovery hook; once Phase 1 ships, pending archives can be re-run to backfill. If Phase 0 is implemented, keep that pending flag so backfill still works.

### Phase 1: pod archival to canonical candidates (the P0)

New service `packages/server/src/services/pod-archival-memory.ts`:

1. `mapPodLearningsToCandidates(learnings, pod, project, now)` implementing sections 2.3 and 2.4. Pure function, unit-testable.
2. `buildPodArchivalReceipt(...)`: assembles the synthetic `RunReceiptV1` plus evidence manifest (section 2.2/2.3), validated through `parseMemoryContract("RunReceiptV1", ...)` so contract drift fails loudly at build time, not inside the intake.
3. `submitPodLearningsAsCandidates(orgId, pod, learnings)`: calls `acceptMemoryRunReceipt` and returns `{submitted, created, dropped: {...}}`.

Wire into `extractArchiveLearnings` (`org.ts:472`):

```
if (getMemoryAuthorityState().legacyWritesFrozen) {
  return (await submitPodLearningsAsCandidates(...)).submitted;
} else {
  // existing ingestLearnings path, unchanged
}
```

Adjust job reporting: on the canonical branch, `learnings_extracted` means "candidates submitted for validation". Broadcast a distinct event (`memory_candidates_submitted`) instead of `knowledge_updated` (`org.ts:448`) so UI consumers do not imply the learnings are already live in search.

### Phase 2: agent run/session rollups

Same branch at the top of the legacy insert paths in `rollupAgentRun` and the session rollup writer (`agent-memory.ts:2533`, `agent-memory.ts:2779`):

- Frozen: map the already-built rollup candidate (summary, details, retrieval_text, entity refs, domains, evidence) to a `MemoryCandidateV1` (plane `org`, kind from the existing `candidateType` heuristic mapped through the section 2.3 table) and submit through `submitPodLearningsAsCandidates`'s shared receipt helper. Skip the legacy insert and skip legacy auto-promotion entirely; `promoteCandidate` is fenced anyway (`agent-memory.ts:2243`). An `auto_promote` rollup policy maps to a stronger `activation_requirement_requested` but still goes through canonical validation; it must not bypass it.
- Not frozen: unchanged.

Rollups always have `session.project_id`/`run.project_id` context; where absent, apply the same section 2.6 decision.

### Phase 3: inventory and retire the remaining legacy writers

These also sit behind the fence and will surface next; decide each explicitly rather than being surprised:

| Caller | Path | Proposed disposition |
|---|---|---|
| Ad-hoc knowledge submission | `packages/server/src/routes/graph.ts:216` | Reroute to canonical candidates (same mapper); this is the second sanctioned ingestion path in CLAUDE.md |
| Scheduled synthesis | `packages/server/src/services/knowledge-synthesis.ts:322` | Pause under frozen authority; revisit as a canonical producer later |
| Project-memory promotion | `packages/server/src/services/project-memory.ts:445` | Superseded by canonical validation; retire |
| Agent-memory promotion | `packages/server/src/services/agent-memory.ts:2281` | Covered by Phase 2; retire |
| Knowledge seeding | `packages/server/src/db/seed-knowledge.ts` | Dev/seed only; guard on authority state |

Also in this phase: update `CLAUDE.md` ("Knowledge Graph, load-bearing rules": the two ingestion paths must point at the canonical intake once cut over) and `docs/ARCHITECTURE_OVERVIEW.md`.

---

## 4. Testing

Unit (mapper):
- Each `KnowledgeNodeType` maps to the expected kind; unmappable and sub-threshold learnings are counted, not silently dropped.
- `client_candidate_id` is deterministic for identical content and differs when content differs.
- Built receipt round-trips `parseMemoryContract("RunReceiptV1", ...)`.

Integration (frozen authority; insert a `memory_authority_transitions` row in the test db):
- Archive a pod with extractable learnings: job completes; rows exist in `memory_candidates_v1` with status `received` and blocker `validation_pending`; a validation job row exists in `memory_outbox`; the legacy graph and `memory_candidates` are untouched.
- Archive the same pod twice: receipt replays (`created: false`), no duplicate candidates.
- Pod with and without `project_id` (exercises the section 2.6 decision).
- Rollup under frozen authority: canonical candidate created, no legacy insert attempted (no trigger abort in logs), auto-promote path not taken.

Regression (legacy authority, not frozen):
- Archival and rollup behavior is unchanged, including `knowledge_updated` broadcast and graph node counts.

---

## 5. Risks and open questions

- **Re-extraction nondeterminism.** `extractKnowledgeEnhanced` is LLM-based; a retried archive can produce different text, hence different `client_candidate_id`s. Receipt replay on `producer_run_id` prevents this for the same receipt, but a failed-then-retried extraction builds a new receipt body and will 409 (`replayOrConflict`, `memory-receipts.ts:381`). Mitigation: derive `producer_run_id` as `pod-archival:<pod_id>:<content-digest-of-selected-candidates>` so a genuinely different extraction gets a new receipt, and rely on validation-side dedup for near-duplicates. Decide during implementation.
- **Validation/review throughput.** Every archive now feeds the validation queue; the per-archive cap (2.4) bounds this, but someone must own reviewing pending org-plane candidates or they will pool at `received`. Surface pending counts in the memory UI as part of Phase 1 acceptance.
- **Kind semantics.** Mapping `pattern` to `constraint` stretches the kind's meaning slightly; if the contract later grows a `pattern` kind, migrate the mapping, not the stored rows.
- **Tenancy decision (2.6)** blocks Phase 1 completion for podless pods; get the call early.

## 6. Acceptance criteria

1. With legacy authority frozen, `POST /api/pods/:podId/archive` completes successfully and selected learnings appear in `memory_candidates_v1` as `received`/`validation_pending`, attributable to the pod via receipt and evidence refs.
2. No code path writes to the legacy graph, `memory_candidates`, or S3 graph storage when `legacyWritesFrozen` is true.
3. Archived-pod candidates appear in canonical search only after validation activates them, never before.
4. Orgs on legacy authority observe zero behavior change.
5. Re-archiving a pod is idempotent at the candidate level.
