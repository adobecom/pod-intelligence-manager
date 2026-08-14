# Memory retention and erasure

Memory retention is an offline, explicit operation. PIM does not run a deletion
job at startup, during legacy cutover, or on a schedule. An operator first writes
an append-only per-class policy, creates a read-only plan, reviews its exact IDs
and digest, stops PIM, then applies that unchanged plan.

This separation keeps normal lifecycle history append-only while allowing an
authorized privacy operation to remove content without reopening the frozen
legacy write authority.

## Governed classes

Policies may be organization-wide or project-specific. A project policy wins
over its organization fallback. Planning fails if no effective policy exists.

| Class | Retention behavior |
|---|---|
| `retrieval_pack` | Only expired packs older than the policy cutoff are selected. Query/response/scope fields and pinned items are redacted; the pack ID and request digest remain as audit metadata. |
| `receipt` | Receipt and response bodies older than the cutoff are redacted only after every linked candidate is permanently closed. Receipts needed for delayed validation, merge, revert, or authorized review retain their correlation fields. |
| `evidence` | Old manifests are redacted only when no non-terminal candidate depends on them. Digests remain; URIs, origins, and manifest bodies are removed. |
| `candidate` | Only terminal rejected, quarantined, validation-failed, or activation-failed candidates are removed. Linked decisions are removed and shared receipt bodies are redacted. |
| `record` | Only stale, superseded, revoked, or expired records older than the cutoff are removed. Active records are never selected by retention. Version, FTS, applicability, feedback, pack, candidate, transition, and legacy-ledger copies are handled in the same transaction. |
| `feedback` | Old feedback and its derived review signals are removed. |
| `security_log` | PIM records the policy and an external-erasure obligation. CloudWatch owns physical log expiry, so the request stays pending until that retention is verified. |

An explicit record erasure may select an active record. Canonical record versions
are immutable, so a field-redaction request cannot safely rewrite one in place;
the reviewed plan clearly escalates it to whole-record physical erasure. Tenant
erasure supports physical deletion only.

## Legal holds

Hold placement and release are separate append-only events. A hold can cover an
organization, project, class, or exact resource. Apply rechecks holds after it
has acquired the exclusive database transaction; a hold placed after planning
therefore blocks the plan. Releasing a hold does not mutate its original event.

## Plan and apply

Examples use an explicit actor and bounded reason code. Plan files are created
mode `0600` and are never overwritten.

```sh
pnpm --filter @pim/server memory-retention -- policy-set \
  --org org-id --project project-id --class record --days 365 \
  --actor privacy-admin --reason record_retention_v1

pnpm --filter @pim/server memory-retention -- plan-retention \
  --org org-id --project project-id --class record \
  --actor privacy-admin --reason scheduled_record_retention \
  --out /secure/path/record-retention-plan.json
```

For a specific record or a complete project's memory:

```sh
pnpm --filter @pim/server memory-retention -- plan-erasure \
  --org org-id --project project-id --class record --record record-id \
  --method physical_delete --actor privacy-admin --reason legal_erasure \
  --out /secure/path/record-erasure-plan.json

pnpm --filter @pim/server memory-retention -- plan-erasure \
  --org org-id --project project-id --class tenant \
  --method physical_delete --actor privacy-admin --reason project_erasure \
  --out /secure/path/project-erasure-plan.json
```

Omit `--project` from the tenant command to select every memory row owned by the
organization. This removes PIM memory data, not the organization, projects, or
unrelated product records.

Review `targets`, `warnings`, and `external_obligations`, then stop PIM. Apply
requires the exact digest printed by planning:

```sh
systemctl stop pim-server.service

pnpm --filter @pim/server memory-retention -- apply \
  --plan /secure/path/record-erasure-plan.json \
  --expect-digest sha256:<reviewed-plan-digest> \
  --confirm-pim-stopped
```

Apply uses `BEGIN EXCLUSIVE`, rechecks canonical authority, the policy effective
at apply time, the target snapshot, and legal holds across both root and
collateral targets, then writes minimum tombstones before
erasing. It temporarily suspends immutable/delete guards only inside that
transaction, restores their exact SQL, requires an empty foreign-key check, and
commits. Any failure rolls back the content changes, tombstones, and guard DDL.
`secure_delete`, WAL truncation, and `VACUUM` clear primary SQLite remnants.

## Audit proof and recovery copies

Tombstones contain only resource class/ID, the original content digest, actor
digest, reason, method, and time. They never retain memory bodies, evidence URIs,
prompts, or hidden reasoning.

Legacy import identities and digests remain as cutover audit metadata. When an
imported record or a terminal imported-candidate lineage is erased, its source,
provenance, and mapped payload fields are redacted under a `legacy_import`
tombstone, including deduplicated aliases.
Cutover reconciliation recognizes that overlay and continues to verify the
original immutable report, coverage counts, authority transitions, and every
non-erased ledger item.

Primary erasure is not the same as immediate erasure from recovery copies. The
current shared logical backups can retain data for 91 days, AWS Backup recovery
points for 84 days, and versioned legacy graph objects can retain noncurrent
versions. Successful primary apply therefore ends in `pending_backup_expiry`
with a `backup_not_before` time; tenant plans also report the graph/object-version
obligation. Operators must verify expiry or perform an approved external purge
before treating the request as fully erased.

Per-tenant `crypto_shred` fails closed. Canonical content is plaintext inside a
shared SQLite database, and backups use shared storage encryption. Destroying a
shared key would destroy other tenants' recovery data and violate the no-data-loss
requirement. True tenant cryptographic erasure requires tenant envelope keys and
encrypted backup payloads; this implementation does not claim that capability.

An authority migration remains separate and never invokes these controls. See
[BACKUP_RESTORE.md](./BACKUP_RESTORE.md) for recovery safeguards.
