# PIM memory API

PIM exposes a strict, versioned memory surface at `/api/v1/memory`. The PIM-side
implementation for Slices 0–6 and the lossless offline SQLite cutover path in
Slice 7 is complete. Joint Fiesta rollout evidence and the production cutover
execution remain separate operational gates.

## Implemented surface

- `GET /api/v1/memory/capabilities`
- `POST /api/v1/memory/search`
- `GET /api/v1/memory/records/:record_id?version=:record_version`
- `PUT /api/v1/memory/run-receipts/:producer_run_id`
- `GET /api/v1/memory/candidates/:candidate_id`
- `POST /api/v1/memory/attestations/github`
- `POST /api/v1/memory/feedback`
- `POST /api/v1/memory/candidates/:candidate_id/decisions`
- `GET|PUT /api/v1/memory/projects/:project_id/prompt-policy`
- `POST /api/v1/memory/projects/:project_id/release-gates/evaluate`
- `POST /api/v1/memory/harness/search`

Capabilities advertise the codebase and harness planes, `current` temporal mode, GitHub and immutable-HTTPS evidence resolution, and verified-merge and authorized-review activation. Organization search, `as_of`, CI attestation ingress, and harness record detail are not implemented.

Codebase and harness retrieval are intentionally separate contracts. Harness results are permanent shadow data: they are never prompt eligible and always return `shadow_only: true`, `routing_influence: false`, and `evaluation_arm: "shadow"`.

`PimMemoryClient` exposes strict wrappers for capabilities, codebase and harness search, immutable record detail, receipts, candidate status and decisions, feedback, prompt-policy reads and updates, and release-gate evaluation.

## Authorization boundary

Organization and project are derived from the authenticated token. A request cannot widen either boundary.

| Scope | Binding and operation |
|---|---|
| `memory:search` | Exact project/repository-bound codebase search and immutable detail |
| `memory:receipt:write` | Exact project/repository-bound codebase receipts |
| `memory:candidate:read` | Bound candidate status lookup |
| `memory:attest` | Separately credentialed, repository-bound GitHub attestations |
| `memory:feedback:write` | Bound append-only feedback |
| `memory:review` | Repository-bound codebase review |
| `memory:admin` | Bound prompt-policy and release-gate administration |
| `memory:harness:receipt:write` | Exact project/principal/harness-bound receipts |
| `memory:harness:review` | Exact project/principal/harness-bound review |
| `memory:harness:search` | Exact project/principal/harness-bound shadow retrieval |

Codebase calls resolve only canonical `github.com/owner/repository` identities from immutable service-token bindings. Local paths, leaf names, raw remotes, fuzzy matches, and legacy unbound memory tokens fail closed. Harness bindings cannot substitute for repository bindings, or vice versa.

## Lifecycle and exposure

Receipts, candidates, evidence, transitions, feedback, provider events, and outbox work are durable. Candidates remain outside canonical search. Codebase activation requires the shared structural validator plus independently resolved evidence; verified successors preserve both histories, and reverts remove records from current retrieval without deleting audit state.

GitHub automatic activation is fail closed unless `MEMORY_ACTIVATION_REPOSITORIES` explicitly includes the canonical repository. Provider workers recheck that allowlist at processing time.

Harness code-change lessons also require `MEMORY_FIESTA_REPOSITORY_ID` to name
the exact canonical Fiesta repository. Authorized review can activate one only
when an independently resolved GitHub merge for that repository has the same
manifest and authoritative final-diff digest.

Codebase prompt exposure requires all of the following: `PIM_MEMORY_PROMPT_EXPOSURE_ENABLED=1`, an enabled project policy, kill switch off, a passing pre-canary gate, exact repository and kind allowlists, deterministic canary assignment, and item/token caps. Automatic verified-merge prompt eligibility additionally requires a passing expansion gate. Critical leakage, evidence-bypass, policy, or harm incidents disable automatic activation and trip the project kill switch.

The release-gate contract records PIM-outage blocked-execution and lost-receipt measurements. End-to-end Fiesta outage injection and queued-receipt proof remain part of the joint F5/F6 rollout gate; this repository does not synthesize that external evidence.

## Storage and operations

Migrations `001` through `011` are checksummed and immutable; the next schema
change must be `012`. Canonical records, versions, packs, candidates, evidence,
transitions, feedback, provider inbox, outbox state, legacy import ledger, and
terminal authority state use the transactional SQLite model. Migration `008`
preserves populated codebase rows while adding harness scope and verifies all
foreign keys before commit. Migration `009` adds the lossless import/reconciliation
ledger and monotonic authority transitions. Migration `010` adds append-only
retention policies, legal holds, erasure audit events, and minimum tombstones.
Migration `011` preserves the authoritative final-diff digest on independently
verified GitHub attestations for Fiesta code-change lessons.
Retention and tenant erasure are offline-only explicit plan/apply operations;
follow [MEMORY_RETENTION_ERASURE.md](./MEMORY_RETENTION_ERASURE.md).

To seed a codebase fixture after registering its project repository:

```sh
PIM_MEMORY_SEED_ORG_ID=org-id \
PIM_MEMORY_SEED_PROJECT_ID=project-id \
PIM_MEMORY_SEED_REPOSITORY_ID=github.com/owner/repository \
PIM_MEMORY_SEED_DISPLAY_SLUG=Owner/Repository \
PIM_MEMORY_SEED_PROVIDER_REPOSITORY_ID=immutable-provider-id \
pnpm --filter @pim/server seed-memory
```

The Slice 7 inventory and cutover tools require explicit paths. Inventory is
read-only:

```sh
pnpm --filter @pim/server inventory-legacy-graphs -- \
  --db /absolute/path/to/pim.db \
  --graph-root /absolute/path/to/knowledge-graph
```

The inventory opens a checkpointed SQLite database read-only/immutable, refuses a nonempty WAL, and reports hashes, divergent layouts, orphan references, and pointer classifications without initializing or mutating either authority.

The offline cutover applies migration `009`, generates a quarantine-by-default
resolution template, verifies every source hash, plans without writes, imports in
one immediate transaction, reconciles the immutable ledger, and permanently
freezes legacy writers. Follow [MEMORY_OFFLINE_CUTOVER.md](./MEMORY_OFFLINE_CUTOVER.md);
do not invoke `apply` outside that stopped-service procedure.

Legacy items that cannot activate safely are preserved as parked candidates with
`legacy_reingestion_required`; they must re-enter through the normal typed
receipt/evidence path and never receive an automatic migration outbox job.

PostgreSQL/pgvector remains conditional on measured value justifying it; SQLite is
the supported canonical store for this cutover. No destructive legacy retention or
deletion runs as part of migration. Backup/restore policy and tested recovery are
documented in [BACKUP_RESTORE.md](./BACKUP_RESTORE.md).
