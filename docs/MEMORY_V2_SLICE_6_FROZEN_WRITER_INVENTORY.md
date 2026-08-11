# Slice 6 Frozen Legacy Writer Inventory

**Status:** Implemented and regression-tested on 2026-08-10
**Scope:** PIM production code only. Migration/import tools are listed separately because they are explicit operator workflows, not normal producers.

## Normal producers

| Producer/caller | Legacy target | Frozen-authority disposition | Proof boundary |
| --- | --- | --- | --- |
| Pod archive job, `routes/org.ts` | `ingestLearnings` → legacy graph/S3 snapshots | Selected output goes only to `submitCanonicalLegacyLearnings`; the legacy call remains only in the unfrozen branch | Archive route integration asserts completed job, pending canonical rows/outbox, real/reserved projects, distinct event, and zero legacy writes |
| REST ad-hoc intake, `routes/graph.ts` (also used by SDK/MCP) | `ingestLearnings` → legacy graph | Returns `202 candidate_submitted` from canonical intake; no dual write | Route integration asserts canonical receipt/candidate and zero legacy writes |
| Agent run rollup, `services/agent-memory.ts` | legacy `memory_candidates`, entity persistence, optional auto-promotion | Builds the existing rollup material, submits it canonically, skips entity/candidate insert and promotion | Frozen rollup integration installs SQL barriers and asserts pending canonical output only |
| Agent session rollup, `services/agent-memory.ts` | legacy `memory_candidates`, entity persistence, runtime/merge auto-promotion | Deduplicated seeds go to canonical intake; legacy insert and validation/promotion callbacks are skipped | Same frozen rollup integration |
| Project evidence intake, `services/project-memory.ts` | `project_memory_candidates` plus optional graph promotion | Evidence/indexing remains available; candidate creation, agent-validation callback, and promotion are skipped | Authority regression asserts evidence persists while legacy candidate count is unchanged |
| Scheduled synthesis, `services/knowledge-synthesis.ts` | `ingestLearnings` → legacy graph | Returns `skipped: legacy_authority_frozen` before graph, embedding, or LLM work | Focused frozen-producer test |
| Development seed, `db/seed-knowledge.ts` | `ingestLearnings` → legacy graph | Returns before graph inspection or ingestion | Focused frozen-producer test |

All frozen producer output is centralized in `services/canonical-legacy-intake.ts`. That service is the only Slice 6 call site for `acceptMemoryRunReceipt`; producers do not call HTTP, insert canonical rows directly, or dual-write.

## Legacy mutation surfaces retained only for pre-cutover use

| Surface | Frozen behavior |
| --- | --- |
| `ingestion-gateway.ts` / `knowledge-graph.ts:addLearningsToGraph` | `assertLegacyMemoryWritable` at entry and immediately before mutation closes both normal and authority-race writes |
| Graph curation routes / `curateNode` | Fail closed through `assertLegacyMemoryWritable`; no mutation occurs |
| Graph analysis, telemetry, pruning, retraction, embedding refresh | Return/no-op when frozen |
| `graph-storage.ts` local/S3 saves and maintenance writers | Save operations assert; background/restore/cleanup writers return/no-op when frozen |
| Manual agent/project candidate promotion and rejection routes | Service functions assert before mutation; automatic validation/promotion callbacks return/no-op when frozen |
| Legacy candidate tables | SQL insert/update/delete barriers remain the final enforcement layer |
| `project_evidence_items.promoted_node_id` | SQL barriers reject promotion-pointer insertion or change while ordinary searchable evidence rows remain writable |

## Explicit operator tools

- `scripts/migrate-legacy-memory.ts` writes canonical v1 import/candidate records during the authorized offline migration; it is not a legacy producer.
- `scripts/rescore-legacy-patterns.ts` and project-search scrub/retraction tools are explicit legacy maintenance commands. Their graph writes fail closed or no-op through the storage/graph authority guards; Slice 6 does not redefine these operator workflows.
- Legacy graph inventory and reviewed-resolution preparation scripts are read/export preparation paths, not runtime writers.

## Canonical frozen-producer contract

- Real project when one exists; otherwise one stable reserved system project is created lazily and idempotently per organization.
- One selected learning per v1 receipt, matching the universal `0..1` receipt invariant.
- Selection order is deterministic from normalized immutable source/content, not extractor array order. Reordered retries replay; content drift at a stable slot raises `canonical_legacy_intake_content_conflict`.
- Source fields are preserved in bounded candidate extensions and covered by a generic immutable PIM evidence digest/URI.
- The v1 `org` allowance is internal only. It creates unsupported-plane companion quarantines rather than a public v2 org resource.
- Candidates enter `received / validation_pending`, validate to `pending_review / manual_policy_owner_required`, and cannot use automatic activation.
- Selected and every dropped category are additive counters on the returned intake result and Pod archive job.
