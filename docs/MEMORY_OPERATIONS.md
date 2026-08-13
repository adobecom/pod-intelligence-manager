# PIM canonical memory operations

**Status:** current operator guidance as of 2026-08-13

This runbook covers the canonical Memory v1/v2 service after authority cutover. PIM uses one SQLite
writer. Preserving authoritative state and tenant/resource boundaries takes precedence over
availability.

## Operating invariants

- Zero cross-organization, project, plane, repository, harness, candidate, record, or pack leakage.
- One canonical SQLite writer and one terminal memory authority.
- Immutable receipts, packs, versions, evidence, transitions, feedback, and import ledgers.
- Service-token authority is rechecked on every request; IDs are not authority.
- Memory v2 is fail-closed when migration, reconciliation, admission, or startup validation fails.
- Legacy graph/candidate writers remain frozen after cutover.

## Runtime controls

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEMORY_WORKERS_ENABLED` | enabled unless `0` | Provider outbox/inbox and reconciliation workers |
| `MEMORY_OUTBOX_INTERVAL_MS` | `30000` | Outbox drain interval |
| `MEMORY_RECONCILE_INTERVAL_MS` | `300000` | Provider inbox reconciliation interval |
| `MEMORY_METRICS_INTERVAL_MS` | `60000` | Operational metric publication interval |
| `MEMORY_V2_REVERIFICATION_ENABLED` | `0` | Admit/run v2 reverification only when set to `1` |
| `MEMORY_V2_REVERIFICATION_INTERVAL_MS` | `30000` | Reverification worker interval |
| `PIM_MEMORY_REQUIRE_CANONICAL_AUTHORITY` | `0` locally | Fail startup unless terminal canonical authority is present when `1` |

Reverification admission also supports validated bounds for interval, maximum age, attempts, and
admitted-record count. See `.env.example`; invalid values fail admission instead of silently using
unsafe policy.

## Health and readiness

- `GET /api/health` covers process/database health and reports Memory v2 availability.
- `GET /api/v2/memory/readiness` returns bounded state for one authorized resource.
- `pim_memory_readiness` is the equivalent restricted MCP tool.

Readiness is not a bulk inventory. It must not expose evidence bodies, credentials, job payloads,
or other tenants' identifiers.

Monitor at least:

| Signal | Required response |
| --- | --- |
| Any boundary leakage or active-pointer violation | Stop the service and treat as a security/data-integrity incident |
| Memory v2 unavailable at startup | Keep v2 callers disabled; inspect the logged migration/reconciliation/admission/validation reason |
| Oldest due outbox work above five minutes | Inspect worker enablement, leases, provider errors, and retry schedule |
| Any provider/outbox dead letter | Fix the cause before a scoped replay; retain the audit row |
| Reverification overdue/dead-lettered | Prevent use of affected records and repair provider/policy state |
| Missing logical-backup heartbeat | Verify the backup job and recovery window immediately |
| Unhealthy single target | Restore service on the one authoritative data volume; never start a second writer on a copy |

## First response to a boundary or integrity incident

1. Record the start time, deployment/image digest, build revision, alarm, and affected bounded IDs.
2. Stop `pim-server` if a cross-boundary result, pointer violation, or canonical-integrity failure is
   possible.
3. Revoke the exact affected service token when credential scope may be compromised. Do not broaden
   the response to unrelated credentials without evidence.
4. Checkpoint SQLite and capture a transactionally consistent recovery copy, SHA-256, and manifest
   before repair. Preserve the suspect database.
5. Investigate with IDs, digests, timestamps, and reason codes. Keep memory bodies, prompts,
   credentials, and unrestricted evidence out of tickets and metric dimensions.
6. Repair forward on a copy, run integrity/foreign-key/reconciliation and scoped-search tests, and
   obtain the required security/policy review before restart.

Do not delete audit rows, restore an older database over the only current copy, start a second
writer, or use a pre-cutover database as live rollback authority.

## Memory v2 startup failure

The startup chain records one of four bounded reasons: `migration_failed`,
`reconciliation_failed`, `admission_failed`, or `startup_validation_failed`.

1. Keep v2 consumers retrying with bounded backoff or disabled; do not route them to legacy memory.
2. Inspect the first logged exception and the database migration ledger.
3. Reproduce against a verified copy of the same database and image digest.
4. Fix the migration/reconciliation/configuration issue and run the focused v2 startup suites.
5. Restart one writer and verify `/api/health`, capabilities, binding, readiness, and a scoped
   non-mutating search before restoring consumers.

## Overdue work and dead letters

- Confirm `MEMORY_WORKERS_ENABLED` is not `0`.
- Distinguish planned retry backoff from an expired lease or due job.
- Fix token binding, repository/harness applicability, provider authentication, or handler errors
  before replay.
- Replay only the named event/job through its scoped service path. Never delete the dead-letter row
  to clear an alarm.
- Confirm the durable state transition and bounded metrics after replay.

## Reverification incidents

When reverification is enabled, a record can remain fresh, become pending when its provider is
temporarily unavailable, or be retired when evidence is contradicted, withdrawn, stale, or expired.

- Do not mark a provider outage as successful verification.
- Preserve policy revisions, attempts, decisions, and runtime-origin evidence.
- A stale worker must not overwrite newer state; investigate compare-and-swap/lease failures rather
  than forcing a row update.
- Verify both v1 and v2 current search exclude a retired record while authorized immutable history
  remains readable.

## Backup failure

The logical backup job publishes an archive only after it can be imported into a disposable SQLite
database and passes integrity, foreign-key, and non-empty-organization checks. A checksum sidecar
without the matching `.sql.gz` object is not a recovery point.

1. Check `/var/log/pim-backup.log`, the S3 tier prefixes, and AWS Backup job state.
2. If neither recovery layer has a verified point within the recovery objective, stop writes before
   deployment, migration, or destructive administration.
3. Fix the cause and run the backup once in the server container.
4. Perform an isolated restore when integrity, IAM, storage, schema, or manifest behavior was
   involved.

Follow [BACKUP_RESTORE.md](./BACKUP_RESTORE.md).

## Recovery drill

At least quarterly, restore both a portable logical backup and an AWS Backup EBS recovery point
into isolated resources. Record the selected recovery point, checksum, manifest result, SQLite
integrity/foreign-key results, authority state, Memory v2 availability, measured data-loss window,
and recovery time. Never attach a drill volume to the live writer.

## Related runbooks

- [Memory API and authorization](./MEMORY_API.md)
- [Backup and restore](./BACKUP_RESTORE.md)
- [Retention and erasure](./MEMORY_RETENTION_ERASURE.md)
- [One-time offline authority cutover](./MEMORY_OFFLINE_CUTOVER.md)
