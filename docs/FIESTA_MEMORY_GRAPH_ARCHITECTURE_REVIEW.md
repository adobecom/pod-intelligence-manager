# Fiesta Memory: Should We Keep a Graph?

> **Historical architecture review.** The recommendation informed the current SQL-authoritative,
> read-only-legacy-graph design. Endpoint and prompt-policy details below predate Memory v2
> simplification; use [MEMORY_API.md](./MEMORY_API.md) for current behavior.

## Architecture review and recommendation

**Status:** Recommendation for review  
**Date:** 2026-08-06  
**Scope:** PIM's Fiesta-facing canonical memory service, the legacy JSON knowledge graph, and the role of memory-to-memory relationships after cutover

---

## 1. Executive conclusion

My recommendation is an evidence-first middle ground:

1. **Keep the canonical SQL memory model as the only write and lifecycle authority.**
2. **Do not restore the legacy JSON knowledge graph as a second authority, and do not add a dedicated graph database now.**
3. **Preserve every legacy relationship and endpoint mapping in the immutable migration ledger and read-only graph archive. Do not block cutover on a new general relationship schema.**
4. **Use those preserved relationships in an offline or shadow Fiesta benchmark. Leave graph expansion out of prompt exposure until that benchmark proves a net benefit under the same authorization and token constraints.**
5. **Only after a positive result, promote the useful relationship types into canonical SQL and derive any graph view from those rows. Never synchronize two independently writable memory pools.**

In shorter form:

> Preserve the graph as evidence, not authority. Make traversal prove value before promoting relationships into the product model.

I have **high confidence** that SQL should remain the authority, **medium-high confidence** that a general relationship schema should wait for evidence, and **low confidence** that graph-expanded recall will materially improve ordinary Fiesta searches. That last question needs measurement, not architectural faith.

---

## 2. What decision is actually being made

There are three ideas that are easy to collapse into the word "graph":

| Idea | Meaning | Recommendation |
|---|---|---|
| Graph-shaped data | Memories can have typed relationships such as `builds_on`, `contradicts`, `resolved_by`, and `supersedes` | Preserve in migration evidence now; promote selectively if justified |
| Graph-assisted retrieval | A direct search result can pull in one or more related memories | Shadow-test first |
| Graph storage authority | A JSON graph or graph database is the source of truth for active memory and lifecycle | Do not keep |

The current Fiesta API rejected the third idea. That does not require rejecting the first two.

The real decision is therefore not "SQL or graph." It is:

> Do Fiesta outcomes justify promoting selected legacy relationships into canonical SQL and using them during retrieval?

---

## 3. Verified current state

### 3.1 Fiesta memory is a governed record service

`POST /api/v1/memory/search` retrieves canonical records after hard organization, project, repository, plane, lifecycle, compatibility, and prompt-policy checks. It ranks eligible records using exact applicability matches, identifiers, task class, lexical overlap, embeddings, evidence strength, and freshness.

It does not traverse legacy `KnowledgeEdge` relationships. It writes an immutable retrieval pack so PIM can later prove exactly what was offered to Fiesta.

This is aligned with the integration requirements: Fiesta needs durable receipts, candidates, evidence, attestations, lifecycle decisions, idempotency, and exact repository authorization. Those are primarily transactional record-management requirements.

### 3.2 The legacy system is a real graph, but graph expansion is not load-bearing

The legacy `KnowledgeGraph` has typed nodes and these edge types:

- `relates_to`
- `supersedes`
- `contradicts`
- `builds_on`
- `resolved_by`

Its retriever can expand strong direct matches by one hop. Edge type controls whether a neighbor is eligible and edge weight contributes to ranking.

However, the compact agent-recall path explicitly disables graph expansion to prevent neighbors from displacing direct task matches. The frozen KG retrieval evaluation also runs with expansion disabled.

The checked-in evaluation has 35 cases and reports:

| Budget | Recall@5 | Recall@10 | MRR |
|---:|---:|---:|---:|
| 1,000 tokens | 0.917 | 0.917 | 0.867 |
| 4,000 tokens | 0.917 | 1.000 | 0.870 |

That is strong evidence that **ordinary legacy recall does not currently need graph traversal**. It is not proof that relationships never help: the evaluation is small, is based on the legacy corpus, and does not specifically test Fiesta's multi-memory or lineage questions.

### 3.3 The cutover imports graph content but does not make general edges queryable

The offline migration:

- inventories every graph root and snapshot;
- reads graph nodes and edges;
- preserves source payloads, source provenance, graph version, digests, and related edges in the import evidence/ledger;
- recognizes and validates supersession lineage;
- imports eligible nodes as canonical records;
- sends incomplete or unsafe items to pending validation or quarantine;
- leaves legacy graph files unchanged and read-only.

Canonical SQL already has a first-class `memory_record_supersessions` table. It does not currently have a general canonical relationship model for `relates_to`, `builds_on`, `contradicts`, and `resolved_by`, and canonical search does not use those relationships.

Therefore the cutover preserves the old bytes and some lineage, but ongoing canonical memory becomes mostly **record-shaped rather than graph-shaped**. If nothing changes, new Fiesta memories will not accumulate the same general relationship structure as the old KG.

### 3.4 The SQL move fixed real defects

The move was not arbitrary. The previous architecture allowed candidate status in SQLite and promoted state in JSON to diverge. Its graph path could also vary with the process working directory, which had already produced divergent graphs for the same organization.

A single transactional authority fixes important invariants:

- activation and active-record creation commit together;
- a record cannot be active while unreadable;
- lifecycle transitions remain append-only;
- evidence and activation cannot drift apart;
- exact repository and tenant boundaries are enforceable before ranking;
- retries can be idempotent;
- revocation and prompt policy can be enforced in the retrieval transaction.

Those benefits should not be traded away merely to retain a graph label.

---

## 4. What a graph could still contribute

A graph is useful when the answer depends on a relationship that is not obvious from the query and the individual memory text.

Potentially valuable examples include:

- "What decision does this constraint build on?"
- "What replaced this obsolete pattern, and why?"
- "Which validated memory resolves this known contradiction?"
- "What adjacent constraint should an agent consider after retrieving this API rule?"
- "Which memories form the evidence-backed chain behind this recommendation?"

These are not the dominant shape of the existing Fiesta search contract. Most searches ask for directly applicable memories for a repository, task, path, symbol, component, or task class. Hybrid direct retrieval is a good fit for that.

The graph's likely value is therefore **secondary recall and explanation**, not primary eligibility or factual authority.

Relationships should never:

- activate a pending record;
- make a popular or highly connected record more truthful;
- bypass exact repository or tenant authorization;
- resurrect stale, superseded, revoked, or expired content;
- allow an inactive neighbor into a prompt because an active seed points to it;
- replace provenance or evidence checks.

---

## 5. Options considered

### Option A: Canonical SQL, preserved legacy relationships, proof before promotion

This is closest to the current implementation and is the recommended immediate state. General relationships remain in the immutable import ledger and read-only graph snapshots. They are available to an offline or shadow evaluator but are not yet normalized into a new serving schema.

**Advantages**

- Lowest runtime and operational complexity.
- One clear authority.
- No graph synchronization or traversal latency.
- Direct retrieval is easier to explain and audit.
- Existing evidence says direct hybrid retrieval is already strong.
- Does not discard the evidence needed for a later graph experiment.
- Avoids designing a permanent relationship contract before knowing which relationship types provide value.

**Disadvantages**

- General legacy relationships remain archival rather than first-class product data.
- New canonical memories do not accumulate general relationship history during the proof period.
- A later graph experiment must materialize and map archived relationships to canonical record IDs.
- "Why changed," contradiction, and supporting-context experiences remain weaker.
- A long proof period would make the legacy graph progressively less representative of current canonical memory.

**Assessment:** Best immediate choice because it is simple, reversible, and supported by current retrieval evidence. It should be time- or evidence-bounded rather than becoming an unexamined permanent decision.

### Option B: Canonical SQL plus canonical relationships and an optional derived graph now

SQL remains the sole authority. Typed relationships are rows in the same database and reference canonical record versions. A graph-shaped in-memory view or index can be derived when needed. Fiesta search remains direct by default.

**Advantages**

- Retains transactional lifecycle and authorization guarantees.
- Preserves the information needed to test graph value later.
- Avoids a parallel memory pool and dual-write reconciliation.
- Supports lineage and explanation even if traversal never ships.
- Allows graph assistance to be enabled per query class or policy rather than globally.
- Can be moved with the rest of the canonical model from SQLite to PostgreSQL.

**Disadvantages**

- Adds a relationship contract, migration mapping, and validation rules.
- Requires decisions about evidence, confidence, validity intervals, and endpoint versions.
- Inferred legacy edges may be noisy and must not silently become trusted.
- Shadow evaluation and observability add work before any user-visible payoff.

**Assessment:** Best conditional target if the benchmark shows value or a concrete audit/lineage product need independently justifies the relationship model. Adding it before either signal is plausible but premature.

### Option C: Keep the legacy graph or a graph database as primary/parallel authority

**Advantages**

- Preserves existing graph APIs and visualization with minimal conceptual change.
- Makes traversal natural.
- Avoids mapping every relationship into a relational contract.

**Disadvantages**

- Reintroduces split authority, atomicity, and reconciliation problems.
- Duplicates authorization and lifecycle enforcement.
- Makes rollback and revocation behavior harder to reason about.
- No current benchmark demonstrates enough graph benefit to justify the operational cost.
- A dedicated graph database adds another deployment, backup, access-control, and migration surface.

**Assessment:** Not justified by current evidence.

### Decision matrix

| Criterion | A: Preserve, then prove | B: SQL + derived graph now | C: Graph authority |
|---|---:|---:|---:|
| Single lifecycle authority | Strong | Strong | Weak if parallel; disruptive if primary |
| Exact authorization | Strong | Strong | Must be rebuilt and kept aligned |
| Current retrieval evidence | Strong | Strong before expansion | Unproven |
| Preserves relationship evidence | Strong | Strong | Strong |
| Makes relationships queryable now | Weak | Strong | Strong |
| Operational simplicity | Strong | Moderate | Weak |
| Reversibility | Strong | Strong | Weak |
| Supports controlled learning | Strong through shadow test | Strong | Moderate |

---

## 6. Recommended staged architecture

### 6.1 Immediate production state

```text
Fiesta APIs -> canonical SQL -> direct lexical/vector retrieval -> retrieval pack

Legacy graph snapshots + immutable import ledger -> offline/shadow evaluator only
```

Canonical SQL owns records, lifecycle, evidence, receipts, feedback, and prompt eligibility. The old graph is retained read-only for recovery and measurement, but it is not consulted for normal Fiesta prompt exposure.

### 6.2 Conditional target if graph value is proven

```text
Fiesta search/receipt/candidate APIs
                 |
                 v
      Canonical SQL transaction boundary
      +----------------------------------+
      | records + immutable versions     |
      | lifecycle transitions            |
      | evidence + attestations           |
      | retrieval packs + feedback        |
      | typed record relationships        |
      +----------------------------------+
             |                  |
             | direct search    | derived, read-only
             v                  v
      lexical/vector ranker   graph view/index
             |                  |
             +--------+---------+
                      |
              policy-selected results
```

### 6.3 Authority rules

- Canonical SQL is the only place that can change record lifecycle or relationship state.
- A derived graph is disposable and rebuildable from canonical rows.
- The legacy JSON graph remains a read-only migration/recovery artifact, not a live write target.
- Search eligibility is decided before any graph expansion.
- An edge cannot confer authority on either endpoint.

### 6.4 Relationship model

Do not add a separate graph database. Add a canonical relationship contract only if the shadow benchmark succeeds or a separately approved lineage/audit use case justifies it.

A minimal relationship should include:

- stable relationship ID;
- organization, project, plane, and repository scope;
- source record ID and version;
- target record ID and version;
- typed relationship;
- confidence and whether it was inferred or reviewed;
- evidence/attestation references;
- validity interval;
- lifecycle or revocation state;
- origin, including legacy edge identity where applicable;
- creation policy and actor.

The existing `memory_record_supersessions` table should remain the lifecycle authority for supersession. A unified read view can expose it alongside general relationships; a second `supersedes` write path should not be created.

Recommended treatment by type:

| Type | Canonical treatment | Prompt-expansion treatment |
|---|---|---|
| `supersedes` | Existing governed lifecycle path | Never use predecessor as current advice |
| `contradicts` | Require evidence or review | Explanation/warning only by default |
| `resolved_by` | Require evidence or review | May add the active resolution, never the unresolved claim alone |
| `builds_on` | Preserve confidence and provenance | Candidate for one-hop shadow expansion |
| `relates_to` | Preserve as a soft edge | Lowest-priority candidate; require demonstrated precision |

### 6.5 Retrieval behavior

Production should initially remain:

1. authorize and filter canonical active records;
2. run direct lexical, identifier, applicability, and semantic ranking;
3. enforce the token budget and prompt policy;
4. return an immutable retrieval pack.

The experimental graph-assisted path should:

1. use only the top direct results as seeds;
2. consider at most one hop initially;
3. consider only authorized, active, compatible endpoints;
4. apply type-specific evidence gates;
5. fit neighbors inside the same token budget rather than expanding the budget;
6. record which results were direct and which were relationship-expanded;
7. run in shadow mode before any prompt exposure.

This retains the most important property of the current contract: a graph can improve ranking, but cannot widen authorization or factual eligibility.

---

## 7. What to do with the 777 legacy learnings

The number alone should not decide the architecture. The relevant questions are how many nodes and relationships are valid, evidence-backed, and useful.

For the cutover:

1. Keep the existing node migration and canonical activation rules.
2. Do not make activation depend on edge count, community membership, or centrality.
3. Inventory every edge by type, endpoint disposition, confidence, evidence coverage, and whether it was inferred.
4. Map supersession through the existing governed supersession model.
5. Preserve other edges as non-serving relationship candidates or immutable migration evidence.
6. Quarantine dangling, cross-scope, ambiguous, or conflicting edges without quarantining an otherwise valid node solely because it has a bad soft edge.
7. Retain legacy snapshots read-only until record and relationship reconciliation is independently verified.

This means a memory can safely become active while its low-confidence `relates_to` edge remains non-serving. Node trust and edge trust are separate decisions.

---

## 8. How graph retrieval should earn production use

There is no checked-in Fiesta-specific comparison showing that relationship expansion improves canonical memory retrieval. The legacy 35-case evaluation is useful evidence for the direct baseline, but it cannot answer the Fiesta question by itself.

### 8.1 Benchmark set

First map a representative subset of archived legacy edges to the canonical records produced by the migration. This mapping is experimental output, not a new authority. Then build an adjudicated set from real or representative Fiesta work containing:

- direct repository/path/symbol questions;
- tasks requiring two complementary memories;
- supersession and "why changed" questions;
- contradiction/resolution questions;
- negative controls where a nearby relationship would be distracting or unsafe;
- cross-project and cross-repository authorization traps;
- stale, revoked, expired, and incompatible neighbors.

Include a meaningful relationship-dependent subset. Otherwise a graph experiment is structurally unable to demonstrate value even if value exists.

### 8.2 Compare these variants

- **Baseline:** current canonical direct hybrid retrieval.
- **Shadow B1:** baseline plus one-hop, reviewed `builds_on`/`resolved_by` relations.
- **Shadow B2:** baseline plus the broader allowed relationship set with confidence thresholds.

All variants must use the same eligible record population, token budget, and prompt policy.

### 8.3 Measure

- Recall@1, @3, @5, and within token budget;
- MRR or nDCG;
- precision and judged distracting-context rate;
- Fiesta task success, rework, and harmful-memory rate where outcome data exists;
- stale/inactive exposure count;
- cross-scope exposure count;
- additional latency and token displacement;
- benefit by query class, not only a global average;
- direct versus relationship-expanded feedback dispositions.

### 8.4 Proposed enablement gate

Set numerical thresholds before examining results. At minimum:

- zero authorization or inactive-lifecycle violations;
- a credible improvement on the predeclared relationship-dependent subset;
- no material regression on ordinary direct searches;
- acceptable latency under the existing service objective;
- improved agent outcomes or retrieval relevance, not merely more returned memories.

If graph expansion fails this test, leave it off and do not add a general serving relationship schema. Keep the existing governed supersession model and retain the archived graph/import evidence according to its recovery and audit policy.

---

## 9. What not to build now

- Do not deploy Neo4j, Neptune, or another dedicated graph database.
- Do not resume writes to `graph-latest.json` after canonical cutover.
- Do not maintain indefinite canonical-plus-legacy dual read for normal Fiesta traffic.
- Do not let inferred edges change lifecycle.
- Do not use degree, retrieval count, or community membership as a truth signal.
- Do not enable unrestricted multi-hop traversal.
- Do not mix current project-search documents into the active-memory result collection.
- Do not delay the governed memory loop merely to recreate the former graph UI.

---

## 10. Risks in the recommended middle ground

### Risk: relationship preservation becomes unused architecture

Mitigation: keep the contract and schema minimal. Do not build a graph database or production expansion until the benchmark supports it. Review usage after the first experiment and remove unused derived infrastructure, while retaining audit-required lineage.

### Risk: low-quality inferred legacy edges contaminate recall

Mitigation: import them as non-serving, confidence-bearing relationships. Require evidence/review for visibility-changing types and shadow-test soft types.

### Risk: relationship authorization is implemented incorrectly

Mitigation: expand only after both endpoints independently pass the same canonical eligibility query. Treat scope as an intersection, never a union.

### Risk: two relationship authorities emerge

Mitigation: make canonical SQL the only relationship write authority. Legacy graph files and any derived graph index are read-only.

### Risk: preserving every edge blocks cutover

Mitigation: do not require every edge to become an active relationship. Require every edge to be accounted for as mapped, duplicate, non-serving, dangling, conflicting, or quarantined.

---

## 11. Final opinion

The original decision to move Fiesta memory authority out of the JSON graph was correct. The system needed transactional lifecycle, exact authorization, evidence integrity, idempotency, and one unambiguous source of truth. Keeping the old graph as an active parallel authority would undo that work.

The stronger claim—"the memory platform does not need relationships"—is not established. What is established is narrower: the current direct retriever performs well without graph expansion on the existing 35-case legacy benchmark. That supports leaving expansion off, not erasing the graph model.

The lowest-regret immediate decision is therefore:

> **Canonical SQL authority, read-only preservation of the legacy graph and edge mappings, and no graph-expanded Fiesta prompts or general relationship schema until a controlled benchmark proves net value.**

If that benchmark succeeds, the right target is canonical typed relationships in SQL plus a disposable derived graph view—not a revival of the JSON graph authority. The migration must preserve enough edge identity and endpoint mapping that "prove it later" remains a genuine option rather than a euphemism for rebuilding the graph from scratch.

---

## 12. Review decisions requested

- [ ] Confirm canonical SQL remains the sole memory and lifecycle authority.
- [ ] Confirm general typed relationships remain in the immutable import ledger/read-only archive during the proof phase rather than becoming a new serving schema immediately.
- [ ] Confirm the legacy JSON graph becomes read-only after cutover.
- [ ] Confirm graph expansion remains disabled for Fiesta prompt exposure initially.
- [ ] Approve a Fiesta-specific direct-versus-one-hop shadow benchmark before enabling graph-assisted retrieval.
- [ ] If the benchmark succeeds, approve canonical SQL relationship rows and a derived graph view as a separate decision.
- [ ] Confirm no dedicated graph database will be added without measured need.

---

## 13. Evidence reviewed

- [PIM-side Fiesta memory integration requirements](./research/PIM_SIDE_FIESTA_MEMORY_INTEGRATION_REQUIREMENTS.md), especially current gaps and storage architecture
- [Memory offline cutover runbook](./MEMORY_OFFLINE_CUTOVER.md)
- [PIM memory explained](./research/PIM_MEMORY_EXPLAINED.md), especially graph expansion and retrieval evaluation
- [KG retrieval evaluation](../packages/eval/reports/kg-retrieval.md)
- [Canonical memory search](../packages/server/src/services/memory-search.ts)
- [Canonical record model](../packages/server/src/services/memory-records.ts)
- [Legacy memory migration](../packages/server/src/services/memory-legacy-migration.ts)
- [Canonical memory migrations](../packages/server/src/db/migrations/001-memory-read-path.ts)
- [Trust and supersession migration](../packages/server/src/db/migrations/003-memory-trust-path.ts)
- [Legacy knowledge graph service](../packages/server/src/services/knowledge-graph.ts)
- [Legacy graph contracts](../packages/shared/src/types/graph.ts)
