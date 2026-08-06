# PIM memory operations

This runbook covers the canonical memory service after the offline cutover. PIM
may be taken offline during recovery. Preserving authoritative data and keeping a
single writer are more important than availability.

## Service objectives

| Signal | Objective | Alarm |
|---|---|---|
| Boundary leakage | Zero persisted cross-org, project, plane, repository, or harness pack items | Any `BoundaryLeakageCount > 0` |
| Active pointers | Every active candidate resolves to its same-scope immutable record and version; a terminal record lifecycle after revert, expiry, or supersession remains a valid pointer | Any `ActivePointerViolationCount > 0` |
| Outbox | Due work and expired leases are serviced within 5 minutes | `OldestOutboxAgeSeconds > 300` for two minutes |
| Dead letters | Zero active provider-inbox or outbox dead letters | Any `DeadLetterCount > 0`; escalate if unresolved for 15 minutes |
| Codebase search | Successful codebase search p95 at or below 500 ms over five minutes | p95 `SearchLatency > 500 ms` for two periods |
| Logical backup | One fully imported and validated portable backup every UTC hour | `LogicalBackupSuccess < 1`, including a missing hourly heartbeat |
| Server health | One healthy target | Any unhealthy target for two minutes; missing health data breaches |

The periodic memory health sample is global and has no tenant dimensions. IDs are
log fields, never metric dimensions. `OldestOutboxAgeSeconds` includes only
pending jobs whose `next_attempt_at` is due and leases that have expired; planned
retry backoff does not page.

For planned maintenance and the canonical cutover, the recovery-point objective
is zero data loss: stop every writer, checkpoint SQLite, and create and verify the
exact backup before changing anything. For an unplanned total-volume loss, the
hourly logical and EBS schedules provide a recovery point no more than 60 minutes
old. The recovery-time objective is four hours. The deployment is intentionally
single-instance and does not promise zero downtime.

## Alert delivery

The CDK stack sends every alarm and terminal AWS Backup job state (`FAILED`,
`ABORTED`, or `EXPIRED`) to `pim-<owner>-operations-alerts`. Configure a confirmed
subscriber before enabling memory:

```sh
cd packages/infra
npx cdk deploy PimEc2Stack-rkhan \
  -c owner=rkhan \
  -c alarmEmail=operator@example.com
```

Email subscriptions remain pending until the recipient confirms them. If email is
not configured during deployment, use the `OperationsAlertTopicArn` stack output
to add an approved SNS subscription. Alarm messages contain counts and reason
codes, not memory bodies.

## First response

1. Acknowledge the alarm and record its start time, metric, deployment, and
   CloudWatch evaluation window.
2. Do not delete rows, purge queues, restore an older database over the current
   one, or start a second SQLite writer.
3. For a boundary or pointer alarm, stop `pim-server` immediately. Downtime is the
   safe containment action. Keep prompt exposure disabled and leave the project
   kill switch on until reconciliation passes.
4. Before repair, checkpoint and capture a transactionally consistent SQLite copy,
   its SHA-256, and a full manifest. Preserve the current database even when it is
   suspected to be invalid.
5. Investigate with IDs, digests, timestamps, and reason codes. Do not copy raw
   prompts, evidence bodies, tokens, or memory details into tickets or alerts.

## Boundary or active-pointer incident

- Keep PIM stopped. Query the affected pack, candidate, and record IDs read-only.
- Treat any cross-tenant result as a security incident. Rotate exposed service
  credentials if access scope may have been compromised.
- Repair forward from the preserved canonical database. Do not use the
  pre-cutover database as a live rollback authority.
- Run integrity and foreign-key checks, the memory reconciliation suite, and a
  representative scoped search before restarting.
- Re-enable a project only after its policy owner reviews the evidence and clears
  the kill switch explicitly.

## Overdue work or dead letters

- Confirm `MEMORY_WORKERS_ENABLED` is not `0` and inspect the worker error reason
  codes in the application log.
- Fix authentication, repository binding, resolver availability, or the bounded
  handler error before replay. Never replay blindly.
- Preserve the dead-letter row and attempt history. Use the scoped replay service
  only for the named job/event after its cause is fixed.
- The alarm clears only when the durable job/event is no longer in
  `dead_letter`; deleting its audit row is not a recovery action.

## Backup failure or missing heartbeat

The cron wrapper publishes `LogicalBackupSuccess=1` only after the archive has
been imported into a disposable SQLite database and passed integrity,
foreign-key, and non-empty-organization checks. It publishes `0` on backup
failure. Missing data is also an alarm.

1. Check `/var/log/pim-backup.log`, the S3 hourly prefix, and the AWS Backup job
   state. A checksum sidecar without its `.sql.gz` object is not a recovery point.
2. If neither recovery layer has a verified point inside the 60-minute objective,
   stop writes before any deployment, migration, or destructive administration.
3. Fix the cause and run the wrapper once inside the container. Confirm a new
   archive and checksum plus an `OK` CloudWatch heartbeat.
4. Perform a throwaway restore when integrity, storage, IAM, or manifest behavior
   was involved. Follow [BACKUP_RESTORE.md](./BACKUP_RESTORE.md).

## Recovery drill

At least quarterly, restore both a portable logical backup and an AWS Backup EBS
recovery point into isolated throwaway resources. Record the selected recovery
point, checksum, manifest result, integrity/foreign-key results, canonical
authority state, measured data-loss window, and measured recovery time. Never
attach a drill volume to the live writer.
