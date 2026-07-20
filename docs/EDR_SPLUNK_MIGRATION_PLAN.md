# EDR + Splunk Compliance Migration — Execution Plan (for independent review)

Date: 2026-07-09 (rev 2, stop-and-restore). Purpose: remediate two security-
compliance requirements on the PIM host by booting from an Adobe Image Factory (IF)
base image, **without data loss** on the live hosted service. For an independent
agent/human to validate before we run the remaining steps.

> Redaction note: concrete identifiers (AWS account IDs, resource IDs, bucket/ECR/
> stack/ASG names, AMI IDs, hosted URL) are replaced with `<PLACEHOLDERS>`, consistent
> within this doc. No secrets, credentials, or CrowdStrike CIDs appear here.

## Objective

Make the PIM EC2 host compliant with (1) **EDR** — CrowdStrike Falcon on the host,
and (2) **Splunk** — host OS syslog forwarded to Security Splunk. Approach: boot the
host from an IF Amazon Linux 2023 base image, which bakes in and auto-configures both
agents (and Hubble). SIO-recommended for AL2023.

Hard constraint: the target stack **is the live hosted PIM**. No data loss.

## Migration model: single-writer, stop-and-restore

PIM is **single-writer SQLite on per-instance local EBS** (each instance has its own
`/data`; there is no shared datastore). Therefore we do **NOT** use a
launch-before-terminate / temporary `max=2` roll: two instances behind the ALB would
each take writes into their own DB (the new one restored from a point-in-time
backup), causing split-brain and losing every write the old instance took after the
backup. Instead: stop the writer, back up, replace the single instance, restore, and
verify — exactly one writer at all times. This trades a short **planned downtime**
window for correctness. That trade is intended.

## Environment (blast radius)

| Item | Value |
|---|---|
| Account / region | `<PIM_ACCOUNT_ID>` / `us-west-2` |
| Stack | `<STACK_NAME>` |
| ASG | `<ASG_NAME>` (min=max=desired=1) |
| Current instance | `<INSTANCE_ID>` (launched 2026-04-21, old AL2023 `<OLD_AMI_ID>`, healthy) — NOT yet replaced |
| Data volume | `<DATA_VOLUME_ID>` (`/data`, `/dev/sdb`, deleteOnTermination=false) |
| Pre-op snapshot | `<SNAPSHOT_ID>` |
| Buckets | `<BACKUPS_BUCKET>` (DB dumps), `<KG_BUCKET>` (KG writethrough) |
| ECR | `<ECR_REPO_URI>` |
| Public URL | `<HOSTED_PIM_URL>` (this IS the hosted PIM) |
| Target IF image | `IF_Amazon-Linux-2023_aws_2.0.0` = `<IF_AMI_ID>` (owner `<IF_OWNER_ACCOUNT_ID>`, shared to account, Falcon 7.23) |

## Key facts established (and how verified)

1. **Host OS/arch:** AL2023 on T3.MEDIUM = x86_64 (`pim-ec2-stack.ts`). Chosen IF flavor matches (plain x86_64).
2. **IF images bake + auto-configure EDR (CID/tags by AWS account) and Splunk UF (Honeydew → Security Splunk)**, tested for EDR/Splunk/Hubble before release. AL2023 AMI confirmed shared to the account.
3. **DATA-LOSS LANDMINE (pre-existing):** a fresh ASG instance gets an empty `/data`. `entrypoint.sh` did not restore the DB; and the KG restore is driven by orgs read *from that DB*, so an empty DB also skips KG restore. ANY replacement brought up an empty PIM. Fixed by restore-on-boot (below).
4. **Single-writer SQLite, per-instance local EBS** (no shared DB) — the reason for stop-and-restore, not launch-before-terminate.
5. **Container sqlite = 3.53.2** (supports `unistr`, which dumps use).
6. **Live baseline:** orgs=11, pods=20.

## Changes made (working tree)

`packages/infra/lib/pim-ec2-stack.ts`:
- `machineImage` **pinned** via `genericLinux({"us-west-2":"<IF_AMI_ID>"})` (was `MachineImage.lookup`, nondeterministic). DEPLOYED value is the same AMI, so redeploy is a no-op diff.
- Server image supports **digest pinning** via `-c serverImageDigest=sha256:...` (else `:latest`).
- Added `-e PIM_REQUIRE_RESTORE=true` to the container env (stateful host: never start empty).
- `backupsBucket.grantWrite` → `grantReadWrite` (restore needs GetObject/List). **DEPLOYED**.
- Removed the hand-rolled `falcon-sensor` user-data block (IF makes it redundant).

`packages/server/scripts/restore-db.sh` (new) + `entrypoint.sh`:
- Restore-on-boot, **fail-closed**. Restores `PIM_RESTORE_KEY` (exact) or the latest backup into a sibling staging DB; optional sha256 + manifest gate; `PRAGMA integrity_check` and non-empty (orgs>0) gates. Only after every gate passes is the staged DB atomically renamed to `DB_PATH`, so a failed restore cannot be mistaken for a populated DB on retry. On any failure it exits non-zero → the server never starts → health never returns 200. **Fresh-env escape:** clean start only when there is genuinely no backup AND `PIM_REQUIRE_RESTORE` is not `true`. Idempotent on populated volumes. **NOT yet shipped** (needs image build + push).

## Safeguards completed

- On-demand backup `<BACKUP_KEY>` (integrity ok); EBS snapshot `<SNAPSHOT_ID>`.
- Baseline counts (orgs=11, pods=20).
- **Restore tested end-to-end** in-container (throwaway `/tmp` DB): `LOAD_OK`, orgs=11, integrity ok. Testing caught + fixed two bugs: `s3api` per-page pagination; write-only IAM.

## Remaining steps (to validate)

### A. Pre-flight (no downtime; old instance keeps serving)
1. **Build + push** the restore-on-boot image to ECR (`:latest` + a traceable tag); capture the **image digest**.
2. **Pin** the launch template to the exact AMI + image digest (`cdk deploy -c serverImageDigest=sha256:...`, reviewed apply). No instance change yet.
3. **Dress rehearsal (addition):** launch a **throwaway** instance from the pinned AMI+digest, **outside the ASG/ALB**, restore a copy of the backup, confirm it boots healthy with a matching manifest, then destroy it. Converts "we think it boots" into "we watched it boot" before the irreversible terminate. Validate `dnf install docker` + server start on the hardened base here.

### B. Cutover (planned downtime; schedule a window)
4. **Gracefully stop** `pim-server` and pause the backup cron / ingestion → writes end.
5. With the app stopped: **final backup** → record exact **S3 key + sha256**; **capture a manifest** (per-critical-table counts, org IDs, pod/conflict counts, max timestamps, KG node count); **final EBS snapshot** of `/data`.
6. **Verify the final backup**: load into a temp DB, `integrity_check`, confirm it matches the manifest.
7. **Terminate-then-launch, single instance** (standard instance-refresh, ASG stays max=1).
8. New instance restore is **fail-closed** and uses the **exact key + sha256 + manifest gate** (via `PIM_RESTORE_KEY` / `PIM_RESTORE_SHA256` / `PIM_RESTORE_MANIFEST_KEY`, set transiently for this boot, then cleared). Health cannot 200 until the restore passes all gates.

### C. Validate, then compliance
9. **Data:** regenerate the manifest from the new DB and diff — must be **exact** (app was stopped, so no growth). Spot-check a pod + conflict; confirm KG hydrated.
10. **EDR:** `falconctl -g --cid --aid --tags`; `/falconbot <CID> <AID>` in `#edr-falconbot` → RFM `no`, correct BU tags.
11. **Splunk:** forwarder active; events in Security Splunk.
12. Clear the transient `PIM_RESTORE_*` values; confirm steady-state env is just `PIM_REQUIRE_RESTORE=true`.

## Rollback plan (per failure mode)

- **Dress rehearsal fails:** fix before any cutover; production untouched (old instance still serving).
- **New instance won't boot / restore fails (fail-closed):** service is **down but consistent** (never served empty). Options: fix + relaunch, or restore `<SNAPSHOT_ID>` to a new `/data` volume, or revert `machineImage`/digest and redeploy. Data safe (app-consistent snapshot + verified backup).
- **Manifest mismatch:** do not accept; investigate; recover from `<SNAPSHOT_ID>` + verified backup.
- **Bad container image:** redeploy a previous ECR tag/digest as the pin and restart.

## Risks / assumptions to scrutinize

1. **Downtime window length** (stop → backup/manifest/verify → terminate → launch → restore → validate). Estimate and schedule; keep the app stopped throughout so there is a single writer.
2. **Fail-closed + terminate-then-launch = no live fallback.** Mitigated by the dress rehearsal (step 3) and by the app-consistent snapshot + verified backup. Confirm this is acceptable.
3. **Restore-on-boot latency** (~18 MB download + import + integrity + manifest) must fit the ELB health grace (5 min) + instance warmup.
4. **Transient `PIM_RESTORE_*` hygiene:** these must be cleared after cutover so later replacements restore *latest*, not a stale pinned key. (Manifest gate also guards against a wrong restore.)
5. **IF hardened image compat:** `dnf install docker` + server start on the hardened base; SELinux mode. Validated in the dress rehearsal.
6. **EDR account→CID mapping:** confirm the PIM account maps to the correct BU CID (ops / `#imagefactory-support`) or verify post-roll via Falcon Bot.
7. **Shared code:** `pim-ec2-stack.ts`, `entrypoint.sh`, `restore-db.sh` are shared with prod; changes apply to prod on its next deploy (not now). Pin the prod region's AMI id before deploying there.
8. **KG restore** depends on the DB having orgs first; the manifest includes a KG node count so we don't declare success with an empty graph.

## Do NOT

- Do not use launch-before-terminate / `max=2` (split-brain on single-writer SQLite).
- Do not roll before the restore-on-boot image is pushed and the dress rehearsal passes.
- Do not blind-apply IaC/IAM (auto-mode guardrail); apply with review.
- Do not leave `PIM_RESTORE_KEY`/`PIM_RESTORE_MANIFEST_KEY` set after cutover.
