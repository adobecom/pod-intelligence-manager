import { DatabaseSync } from "node:sqlite";
import { canonicalJsonSha256 } from "@pim/shared";
import { describe, expect, it } from "vitest";
import { runSchemaMigrations } from "../../db/migrations.js";
import {
  MEMORY_RETENTION_DATA_CLASSES,
  applyMemoryErasurePlan,
  createMemoryRetentionPolicyVersion,
  placeMemoryLegalHold,
  planMemoryErasure,
  planMemoryRetention,
  releaseMemoryLegalHold,
} from "../memory-data-governance.js";

const NOW = "2026-08-03T12:00:00.000Z";
const OLD = "2026-06-01T00:00:00.000Z";
const FRESH = "2026-07-20T00:00:00.000Z";
const SHA = `sha256:${"a".repeat(64)}`;

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE orgs (org_id TEXT PRIMARY KEY);
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(org_id)
    );
    CREATE TABLE service_principals (service_principal_id TEXT PRIMARY KEY);
    CREATE TABLE service_tokens (token_id TEXT PRIMARY KEY);
  `);
  runSchemaMigrations(db);
  db.exec(`
    INSERT INTO orgs VALUES ('org-a'), ('org-b');
    INSERT INTO projects VALUES
      ('project-a1', 'org-a'),
      ('project-a2', 'org-a'),
      ('project-b1', 'org-b');
  `);
  db.prepare(
    `INSERT INTO memory_legacy_import_runs
       (import_run_id, inventory_digest, resolution_digest, source_bundle_digest,
        source_item_count, imported_count, pending_count, quarantined_count,
        deduplicated_count, report_json, created_at)
     VALUES ('cutover', ?, ?, ?, 0, 0, 0, 0, 0, '{}', ?)`,
  ).run(SHA, SHA, SHA, NOW);
  db.prepare(
    `INSERT INTO memory_authority_transitions
       (transition_id, revision, from_authority, to_authority, legacy_writes_frozen,
        import_run_id, actor_id, reason_code, occurred_at)
     VALUES ('authority-1', 1, 'legacy', 'migration_locked', 1,
             'cutover', 'test', 'cutover_started', ?),
            ('authority-2', 2, 'migration_locked', 'canonical', 1,
             'cutover', 'test', 'cutover_complete', ?)`,
  ).run(NOW, NOW);
  return db;
}

function seedRepository(db: DatabaseSync, orgId: string, projectId: string): string {
  const id = `repo-${projectId}`;
  db.prepare(
    `INSERT INTO memory_repository_registry
       (repository_row_id, org_id, project_id, provider, provider_repository_id,
        repository_id, display_slug, valid_from, created_at, updated_at)
     VALUES (?, ?, ?, 'github', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    orgId,
    projectId,
    `provider-${projectId}`,
    `github.com/acme/${projectId}`,
    `Acme/${projectId}`,
    OLD,
    OLD,
    OLD,
  );
  return id;
}

function seedRecord(db: DatabaseSync, input: {
  recordId: string;
  orgId: string;
  projectId: string;
  repositoryRowId: string;
  status: "active" | "revoked" | "expired";
  updatedAt: string;
  secret?: string;
}): void {
  db.prepare(
    `INSERT INTO memory_records
       (record_id, org_id, project_id, repository_row_id, harness_id, plane, kind,
        current_version, current_status, aggregate_version, shadow_recall_eligible,
        prompt_eligible, claim_key, valid_from, valid_until, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, 'codebase', 'constraint', 1, ?, 1, 1, 0, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    input.recordId,
    input.orgId,
    input.projectId,
    input.repositoryRowId,
    input.status,
    `claim-${input.recordId}`,
    input.updatedAt,
    input.updatedAt,
    input.updatedAt,
  );
  const content = {
    summary: input.secret ?? `summary-${input.recordId}`,
    details: `details-${input.recordId}`,
    rationale: `rationale-${input.recordId}`,
  };
  db.prepare(
    `INSERT INTO memory_record_versions
       (record_id, record_version, content_json, applicability_json, exceptions_json,
        compatibility_json, validation_json, evidence_json, evidence_summary_json,
        freshness_json, provenance_json, embedding_json, content_digest, recorded_at)
     VALUES (?, 1, ?, '{}', '[]', '{}', '{}', '[]', '{}', '{}', '{}', NULL, ?, ?)`,
  ).run(input.recordId, JSON.stringify(content), canonicalJsonSha256(content), input.updatedAt);
}

function seedReceiptCandidate(db: DatabaseSync, input: {
  receiptId: string;
  candidateId: string;
  repositoryRowId?: string;
  plane: "codebase" | "harness";
  status: "received" | "validating" | "pending_merge" | "pending_review" | "rejected" | "quarantined" | "validation_failed" | "active" | "activation_failed";
}): Record<string, unknown> {
  const receipt = {
    producer: { harness_id: input.plane === "harness" ? "side" : "fiesta" },
    repository: {
      provider_pull_request_id: `pr-${input.receiptId}`,
      pr_head_sha: `head-${input.receiptId}`,
      candidate_tree_sha: `head-${input.receiptId}`,
    },
    outcome: { status: "completed", failure_fingerprint: `failure-${input.receiptId}` },
  };
  db.prepare(
    `INSERT INTO memory_run_receipts
       (receipt_id, org_id, project_id, producer_run_id, schema_major, request_digest,
        receipt_json, response_json, producer_harness_id, repository_row_id,
        repository_id, base_sha, outcome_status, created_at)
     VALUES (?, 'org-a', 'project-a1', ?, '1', ?, ?, '{}', ?, ?, ?, ?, 'completed', ?)`,
  ).run(
    input.receiptId,
    `run-${input.receiptId}`,
    SHA,
    JSON.stringify(receipt),
    input.plane === "harness" ? "side" : "fiesta",
    input.repositoryRowId ?? null,
    input.repositoryRowId ? "github.com/acme/project-a1" : null,
    input.repositoryRowId ? SHA : null,
    OLD,
  );
  db.prepare(
    `INSERT INTO memory_candidates_v1
       (candidate_id, org_id, project_id, receipt_id, repository_row_id,
        producer_harness_id, client_candidate_id, candidate_digest, candidate_json,
        plane, kind, current_status, aggregate_version, activation_requirement,
        blockers_json, evidence_manifest_row_id, active_record_id, active_record_version,
        created_at, updated_at)
     VALUES (?, 'org-a', 'project-a1', ?, ?, ?, ?, ?, '{}', ?, 'constraint', ?, 1, ?,
             '[]', NULL, NULL, NULL, ?, ?)`,
  ).run(
    input.candidateId,
    input.receiptId,
    input.repositoryRowId ?? null,
    input.plane === "harness" ? "side" : "fiesta",
    `client-${input.candidateId}`,
    SHA,
    input.plane,
    input.status,
    input.status === "pending_review" || input.plane === "harness"
      ? "authorized_review"
      : "verified_merge",
    OLD,
    OLD,
  );
  db.prepare(
    `INSERT INTO memory_receipt_candidates
       (receipt_id, candidate_id, client_candidate_id, candidate_digest)
     VALUES (?, ?, ?, ?)`,
  ).run(input.receiptId, input.candidateId, `client-${input.candidateId}`, SHA);
  return receipt;
}

function count(db: DatabaseSync, sql: string, ...params: string[]): number {
  return Number((db.prepare(sql).get(...params) as { count: number }).count);
}

describe("offline memory data governance", () => {
  it("uses effective per-class policies and erases only retention-eligible records", () => {
    const db = database();
    const repoA = seedRepository(db, "org-a", "project-a1");
    const repoB = seedRepository(db, "org-b", "project-b1");
    seedRecord(db, {
      recordId: "old-revoked",
      orgId: "org-a",
      projectId: "project-a1",
      repositoryRowId: repoA,
      status: "revoked",
      updatedAt: OLD,
      secret: "secret-old-record-content",
    });
    seedRecord(db, {
      recordId: "fresh-revoked",
      orgId: "org-a",
      projectId: "project-a1",
      repositoryRowId: repoA,
      status: "revoked",
      updatedAt: FRESH,
    });
    seedRecord(db, {
      recordId: "old-active",
      orgId: "org-a",
      projectId: "project-a1",
      repositoryRowId: repoA,
      status: "active",
      updatedAt: OLD,
    });
    seedRecord(db, {
      recordId: "other-tenant",
      orgId: "org-b",
      projectId: "project-b1",
      repositoryRowId: repoB,
      status: "revoked",
      updatedAt: OLD,
    });

    const policies = new Map<string, string>();
    for (const dataClass of MEMORY_RETENTION_DATA_CLASSES) {
      const policy = createMemoryRetentionPolicyVersion({
        orgId: "org-a",
        projectId: "project-a1",
        dataClass,
        retentionDays: 30,
        actorId: "privacy-admin",
        reasonCode: `retain_${dataClass}`,
        now: NOW,
      }, db);
      policies.set(dataClass, policy.policyVersionId);
      const classPlan = planMemoryRetention({
        orgId: "org-a",
        projectId: "project-a1",
        dataClass,
        actorId: "privacy-admin",
        reasonCode: `apply_${dataClass}`,
        now: NOW,
        requestId: `plan-${dataClass}`,
      }, db);
      expect(classPlan.policy_version_id).toBe(policy.policyVersionId);
      expect(classPlan.policy_revision).toBe(1);
    }

    const plan = planMemoryRetention({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "record",
      actorId: "privacy-admin",
      reasonCode: "apply_record_retention",
      now: NOW,
      requestId: "record-retention",
    }, db);
    expect(plan.policy_version_id).toBe(policies.get("record"));
    expect(plan.cutoff_at).toBe("2026-07-04T12:00:00.000Z");
    expect(plan.targets.filter((entry) => entry.resource_class === "record")
      .map((entry) => entry.resource_id)).toEqual(["old-revoked"]);

    const result = applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
    }, db);
    expect(result.state).toBe("pending_backup_expiry");
    expect(db.prepare("SELECT record_id FROM memory_records ORDER BY record_id").all())
      .toEqual([
        { record_id: "fresh-revoked" },
        { record_id: "old-active" },
        { record_id: "other-tenant" },
      ]);
    const tombstone = db.prepare(
      `SELECT resource_id, content_digest, actor_digest, reason_code
       FROM memory_erasure_tombstones WHERE resource_class = 'record'`,
    ).get() as Record<string, string>;
    expect(tombstone.resource_id).toBe("old-revoked");
    expect(JSON.stringify(tombstone)).not.toContain("secret-old-record-content");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => db.prepare(
      "UPDATE memory_record_versions SET content_json = '{}' WHERE record_id = 'old-active'",
    ).run()).toThrow(/immutable/);
    db.close();
  });

  it("preserves old receipts needed for delayed merge, revert, and review correlation", () => {
    const db = database();
    const repositoryRowId = seedRepository(db, "org-a", "project-a1");
    const protectedCases = [
      { suffix: "pending-merge", plane: "codebase", status: "pending_merge" },
      { suffix: "pending-review", plane: "codebase", status: "pending_review" },
      { suffix: "active", plane: "codebase", status: "active" },
      { suffix: "harness-review", plane: "harness", status: "pending_review" },
      { suffix: "retry-validation", plane: "codebase", status: "validation_failed" },
    ] as const;
    const originalReceipts = new Map<string, Record<string, unknown>>();
    for (const item of protectedCases) {
      const receiptId = `receipt-${item.suffix}`;
      originalReceipts.set(receiptId, seedReceiptCandidate(db, {
        receiptId,
        candidateId: `candidate-${item.suffix}`,
        repositoryRowId: item.plane === "codebase" ? repositoryRowId : undefined,
        plane: item.plane,
        status: item.status,
      }));
    }
    for (const status of ["rejected", "quarantined"] as const) {
      seedReceiptCandidate(db, {
        receiptId: `receipt-${status}`,
        candidateId: `candidate-${status}`,
        repositoryRowId,
        plane: "codebase",
        status,
      });
    }
    createMemoryRetentionPolicyVersion({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "receipt",
      retentionDays: 30,
      actorId: "privacy-admin",
      reasonCode: "receipt_retention",
      now: NOW,
    }, db);
    const plan = planMemoryRetention({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "receipt",
      actorId: "privacy-admin",
      reasonCode: "apply_receipt_retention",
      now: NOW,
    }, db);
    expect(plan.targets.map((entry) => entry.resource_id)).toEqual([
      "receipt-quarantined",
      "receipt-rejected",
    ]);
    applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: NOW,
    }, db);

    for (const [receiptId, original] of originalReceipts) {
      const stored = db.prepare(
        "SELECT receipt_json, base_sha FROM memory_run_receipts WHERE receipt_id = ?",
      ).get(receiptId) as { receipt_json: string; base_sha: string | null };
      expect(JSON.parse(stored.receipt_json)).toEqual(original);
      if (receiptId !== "receipt-harness-review") expect(stored.base_sha).toBe(SHA);
    }
    expect(db.prepare(
      `SELECT candidate.current_status, receipt.receipt_id
       FROM memory_candidates_v1 AS candidate
       JOIN memory_run_receipts AS receipt ON receipt.receipt_id = candidate.receipt_id
       WHERE candidate.current_status IN ('pending_merge','active')
         AND json_extract(receipt.receipt_json, '$.repository.provider_pull_request_id') IS NOT NULL
       ORDER BY candidate.current_status`,
    ).all()).toEqual([
      { current_status: "active", receipt_id: "receipt-active" },
      { current_status: "pending_merge", receipt_id: "receipt-pending-merge" },
    ]);
    expect(db.prepare(
      `SELECT receipt.receipt_id
       FROM memory_candidates_v1 AS candidate
       JOIN memory_run_receipts AS receipt ON receipt.receipt_id = candidate.receipt_id
       WHERE candidate.current_status = 'pending_review'
         AND json_extract(receipt.receipt_json, '$.producer.harness_id') IS NOT NULL
       ORDER BY receipt.receipt_id`,
    ).all()).toEqual([
      { receipt_id: "receipt-harness-review" },
      { receipt_id: "receipt-pending-review" },
    ]);
    expect(db.prepare(
      `SELECT receipt_id, receipt_json, base_sha FROM memory_run_receipts
       WHERE receipt_id IN ('receipt-rejected','receipt-quarantined') ORDER BY receipt_id`,
    ).all()).toEqual([
      { receipt_id: "receipt-quarantined", receipt_json: "{}", base_sha: null },
      { receipt_id: "receipt-rejected", receipt_json: "{}", base_sha: null },
    ]);
    db.close();
  });

  it("keeps shared receipt correlation when candidate retention closes only one candidate", () => {
    const db = database();
    const repositoryRowId = seedRepository(db, "org-a", "project-a1");
    const protectedReceipts = new Map<string, Record<string, unknown>>();

    const addSurvivingCandidate = (input: {
      receiptId: string;
      candidateId: string;
      plane: "codebase" | "harness";
      status: "pending_merge" | "pending_review" | "active" | "quarantined";
      updatedAt?: string;
    }): void => {
      db.prepare(
        `INSERT INTO memory_candidates_v1
           (candidate_id, org_id, project_id, receipt_id, repository_row_id,
            producer_harness_id, client_candidate_id, candidate_digest, candidate_json,
            plane, kind, current_status, aggregate_version, activation_requirement,
            blockers_json, evidence_manifest_row_id, active_record_id, active_record_version,
            created_at, updated_at)
         VALUES (?, 'org-a', 'project-a1', ?, ?, ?, ?, ?, '{}', ?, 'constraint', ?, 1, ?,
                 '[]', NULL, NULL, NULL, ?, ?)`,
      ).run(
        input.candidateId,
        input.receiptId,
        input.plane === "codebase" ? repositoryRowId : null,
        input.plane === "harness" ? "side" : "fiesta",
        `client-${input.candidateId}`,
        SHA,
        input.plane,
        input.status,
        input.plane === "harness" ? "authorized_review" : "verified_merge",
        input.updatedAt ?? OLD,
        input.updatedAt ?? OLD,
      );
      db.prepare(
        `INSERT INTO memory_receipt_candidates
           (receipt_id, candidate_id, client_candidate_id, candidate_digest)
         VALUES (?, ?, ?, ?)`,
      ).run(input.receiptId, input.candidateId, `client-${input.candidateId}`, SHA);
    };

    for (const item of [
      { suffix: "pending-merge", plane: "codebase", status: "pending_merge" },
      { suffix: "active", plane: "codebase", status: "active" },
      { suffix: "harness-review", plane: "harness", status: "pending_review" },
    ] as const) {
      const receiptId = `receipt-shared-${item.suffix}`;
      protectedReceipts.set(receiptId, seedReceiptCandidate(db, {
        receiptId,
        candidateId: `candidate-closed-${item.suffix}`,
        repositoryRowId: item.plane === "codebase" ? repositoryRowId : undefined,
        plane: item.plane,
        status: "rejected",
      }));
      addSurvivingCandidate({
        receiptId,
        candidateId: `candidate-surviving-${item.suffix}`,
        plane: item.plane,
        status: item.status,
      });
    }

    seedReceiptCandidate(db, {
      receiptId: "receipt-shared-closed-only",
      candidateId: "candidate-closed-control",
      repositoryRowId,
      plane: "codebase",
      status: "rejected",
    });
    addSurvivingCandidate({
      receiptId: "receipt-shared-closed-only",
      candidateId: "candidate-fresh-quarantined-control",
      plane: "codebase",
      status: "quarantined",
      updatedAt: FRESH,
    });

    createMemoryRetentionPolicyVersion({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "candidate",
      retentionDays: 30,
      actorId: "privacy-admin",
      reasonCode: "candidate_retention",
      now: NOW,
    }, db);
    const plan = planMemoryRetention({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "candidate",
      actorId: "privacy-admin",
      reasonCode: "apply_candidate_retention",
      now: NOW,
    }, db);

    expect(plan.targets.filter((entry) => entry.resource_class === "receipt")
      .map((entry) => entry.resource_id)).toEqual(["receipt-shared-closed-only"]);
    applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: NOW,
    }, db);

    for (const [receiptId, originalReceipt] of protectedReceipts) {
      const row = db.prepare(
        `SELECT receipt_json, base_sha
         FROM memory_run_receipts WHERE receipt_id = ?`,
      ).get(receiptId) as { receipt_json: string; base_sha: string | null };
      expect(JSON.parse(row.receipt_json)).toEqual(originalReceipt);
      if (receiptId !== "receipt-shared-harness-review") expect(row.base_sha).toBe(SHA);
      expect(count(
        db,
        `SELECT COUNT(*) AS count FROM memory_erasure_tombstones
         WHERE resource_class = 'receipt' AND resource_id = ?`,
        receiptId,
      )).toBe(0);
    }
    expect(db.prepare(
      `SELECT candidate.current_status,
              json_extract(receipt.receipt_json, '$.repository.provider_pull_request_id') AS pull_request_id
       FROM memory_candidates_v1 AS candidate
       JOIN memory_run_receipts AS receipt ON receipt.receipt_id = candidate.receipt_id
       WHERE candidate.current_status IN ('pending_merge','active')
       ORDER BY candidate.current_status`,
    ).all()).toEqual([
      { current_status: "active", pull_request_id: "pr-receipt-shared-active" },
      { current_status: "pending_merge", pull_request_id: "pr-receipt-shared-pending-merge" },
    ]);
    expect(db.prepare(
      `SELECT candidate.current_status,
              json_extract(receipt.receipt_json, '$.producer.harness_id') AS harness_id
       FROM memory_candidates_v1 AS candidate
       JOIN memory_run_receipts AS receipt ON receipt.receipt_id = candidate.receipt_id
       WHERE candidate.candidate_id = 'candidate-surviving-harness-review'`,
    ).get()).toEqual({ current_status: "pending_review", harness_id: "side" });
    expect(db.prepare(
      `SELECT receipt_json, base_sha FROM memory_run_receipts
       WHERE receipt_id = 'receipt-shared-closed-only'`,
    ).get()).toEqual({ receipt_json: "{}", base_sha: null });
    expect(count(
      db,
      `SELECT COUNT(*) AS count FROM memory_erasure_tombstones
       WHERE resource_class = 'receipt' AND resource_id = 'receipt-shared-closed-only'`,
    )).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("applies policy cutoffs for packs, receipts, evidence, candidates, feedback, and external logs", () => {
    const db = database();
    const repo = seedRepository(db, "org-a", "project-a1");
    seedRecord(db, {
      recordId: "active-for-feedback",
      orgId: "org-a",
      projectId: "project-a1",
      repositoryRowId: repo,
      status: "active",
      updatedAt: OLD,
    });
    db.prepare(
      `INSERT INTO memory_retrieval_packs
         (retrieval_pack_id, org_id, project_id, request_id, request_digest,
          repository_row_id, repository_id, harness_id, plane, query, policy_version,
          ranker_version, authorized_scope_json, token_count, omitted_count, response_json,
          created_at, expires_at, prompt_eligible, evaluation_arm, prompt_policy_revision,
          prompt_policy_snapshot_json, prompt_item_count, prompt_token_count)
       VALUES ('pack-old', 'org-a', 'project-a1', 'request-old', ?, ?,
               'github.com/acme/project-a1', NULL, 'codebase', 'secret pack query',
               'policy-v1', 'ranker-v1', '{"secret":"scope"}', 10, 0,
               '{"secret":"response"}', ?, ?, 0, 'shadow', 0, '{"secret":"policy"}', 0, 0)`,
    ).run(SHA, repo, OLD, OLD);
    db.prepare(
      `INSERT INTO memory_retrieval_pack_items
         (retrieval_pack_id, item_order, record_id, record_version, token_count,
          rank_score, match_reasons_json, prompt_eligible)
       VALUES ('pack-old', 0, 'active-for-feedback', 1, 10, 1.0, '["secret match"]', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO memory_run_receipts
         (receipt_id, org_id, project_id, producer_run_id, schema_major, request_digest,
          receipt_json, response_json, producer_harness_id, repository_row_id,
          repository_id, outcome_status, created_at)
       VALUES ('receipt-old', 'org-a', 'project-a1', 'run-old', '1', ?,
               '{"secret":"receipt"}', '{"secret":"receipt response"}', 'fiesta', ?,
               'github.com/acme/project-a1', 'completed', ?)`,
    ).run(SHA, repo, OLD);
    db.prepare(
      `INSERT INTO memory_evidence_manifests
         (evidence_manifest_row_id, org_id, project_id, receipt_id,
          producer_manifest_id, manifest_digest, manifest_json, created_at)
       VALUES ('manifest-old', 'org-a', 'project-a1', 'receipt-old',
               'producer-manifest-old', ?, '{"secret":"manifest"}', ?)`,
    ).run(SHA, OLD);
    db.prepare(
      `INSERT INTO memory_evidence_refs
         (evidence_row_id, evidence_manifest_row_id, producer_ref_id, type, uri, digest,
          origin_id, source_authority, occurred_at, created_at)
       VALUES ('evidence-old', 'manifest-old', 'ref-old', 'git_diff',
               'https://example.invalid/secret.diff', ?, 'secret-origin', 'observed', ?, ?)`,
    ).run(SHA, OLD, OLD);
    db.prepare(
      `INSERT INTO memory_candidates_v1
         (candidate_id, org_id, project_id, receipt_id, repository_row_id,
          producer_harness_id, client_candidate_id, candidate_digest, candidate_json,
          plane, kind, current_status, aggregate_version, activation_requirement,
          blockers_json, evidence_manifest_row_id, created_at, updated_at)
       VALUES ('candidate-old', 'org-a', 'project-a1', 'receipt-old', ?, 'fiesta',
               'client-old', ?, '{"secret":"candidate"}', 'codebase', 'constraint',
               'rejected', 1, 'verified_merge', '[]', 'manifest-old', ?, ?)`,
    ).run(repo, SHA, OLD, OLD);
    db.prepare(
      `INSERT INTO memory_receipt_candidates
         (receipt_id, candidate_id, client_candidate_id, candidate_digest)
       VALUES ('receipt-old', 'candidate-old', 'client-old', ?)`,
    ).run(SHA);
    db.prepare(
      `INSERT INTO memory_feedback
         (feedback_id, org_id, project_id, receipt_id, producer_run_id,
          retrieval_pack_id, record_id, record_version, feedback_stage,
          feedback_revision, feedback_json, feedback_digest, created_at)
       VALUES ('feedback-old', 'org-a', 'project-a1', 'receipt-old', 'run-old',
               'pack-old', 'active-for-feedback', 1, 'later', 1,
               '{"secret":"feedback"}', ?, ?)`,
    ).run(SHA, OLD);

    for (const dataClass of MEMORY_RETENTION_DATA_CLASSES) {
      createMemoryRetentionPolicyVersion({
        orgId: "org-a",
        projectId: "project-a1",
        dataClass,
        retentionDays: 30,
        actorId: "privacy-admin",
        reasonCode: `retain_${dataClass}`,
        now: NOW,
      }, db);
    }

    for (const dataClass of ["retrieval_pack", "receipt", "evidence", "candidate", "feedback"] as const) {
      const plan = planMemoryRetention({
        orgId: "org-a",
        projectId: "project-a1",
        dataClass,
        actorId: "privacy-admin",
        reasonCode: `apply_${dataClass}`,
        now: NOW,
      }, db);
      expect(plan.targets.some((entry) => entry.resource_class === dataClass)).toBe(true);
      applyMemoryErasurePlan({
        plan,
        expectedPlanDigest: plan.plan_digest,
        downtimeConfirmed: true,
        compact: false,
      }, db);
    }
    expect(db.prepare(
      "SELECT query, response_json, authorized_scope_json FROM memory_retrieval_packs WHERE retrieval_pack_id = 'pack-old'",
    ).get()).toEqual({ query: "[ERASED]", response_json: "{}", authorized_scope_json: "{}" });
    expect(db.prepare(
      "SELECT receipt_json, response_json FROM memory_run_receipts WHERE receipt_id = 'receipt-old'",
    ).get()).toEqual({ receipt_json: "{}", response_json: "{}" });
    expect(db.prepare(
      "SELECT manifest_json FROM memory_evidence_manifests WHERE evidence_manifest_row_id = 'manifest-old'",
    ).get()).toEqual({ manifest_json: "{}" });
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_candidates_v1 WHERE candidate_id = 'candidate-old'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_feedback WHERE feedback_id = 'feedback-old'")).toBe(0);

    const logPlan = planMemoryRetention({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "security_log",
      actorId: "privacy-admin",
      reasonCode: "apply_security_logs",
      now: NOW,
    }, db);
    const logResult = applyMemoryErasurePlan({
      plan: logPlan,
      expectedPlanDigest: logPlan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
    }, db);
    expect(logResult.state).toBe("pending_external_erasure");
    expect(db.prepare(
      "SELECT state FROM memory_erasure_events WHERE request_id = ?",
    ).get(logPlan.request_id)).toEqual({ state: "pending_external_erasure" });
    db.close();
  });

  it("rejects stale plans without writing audit rows", () => {
    const db = database();
    const repo = seedRepository(db, "org-a", "project-a1");
    seedRecord(db, {
      recordId: "record-stale",
      orgId: "org-a",
      projectId: "project-a1",
      repositoryRowId: repo,
      status: "revoked",
      updatedAt: OLD,
    });
    const plan = planMemoryErasure({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "record",
      recordId: "record-stale",
      method: "physical_delete",
      actorId: "privacy-admin",
      reasonCode: "legal_erasure",
      now: NOW,
    }, db);
    db.prepare(
      "UPDATE memory_records SET updated_at = ? WHERE record_id = 'record-stale'",
    ).run("2026-08-03T12:00:01.000Z");
    expect(() => applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
    }, db)).toThrowError(expect.objectContaining({ code: "plan_stale" }));
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_erasure_requests")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_records WHERE record_id = 'record-stale'")).toBe(1);
    db.close();
  });

  it("rejects a plan when a newer policy becomes effective after planning", () => {
    const db = database();
    createMemoryRetentionPolicyVersion({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "receipt",
      retentionDays: 30,
      actorId: "privacy-admin",
      reasonCode: "receipt_policy_v1",
      now: NOW,
    }, db);
    const plan = planMemoryRetention({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "receipt",
      actorId: "privacy-admin",
      reasonCode: "planned_under_v1",
      now: NOW,
    }, db);
    createMemoryRetentionPolicyVersion({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "receipt",
      retentionDays: 60,
      actorId: "privacy-admin",
      reasonCode: "receipt_policy_v2",
      effectiveAt: "2026-08-03T12:05:00.000Z",
      now: "2026-08-03T12:01:00.000Z",
    }, db);
    expect(() => applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: "2026-08-03T12:06:00.000Z",
    }, db)).toThrowError(expect.objectContaining({ code: "plan_stale" }));
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_erasure_requests")).toBe(0);
    db.close();
  });

  it("blocks an exact record hold until the append-only release event exists", () => {
    const db = database();
    const repo = seedRepository(db, "org-a", "project-a1");
    seedRecord(db, {
      recordId: "record-held",
      orgId: "org-a",
      projectId: "project-a1",
      repositoryRowId: repo,
      status: "revoked",
      updatedAt: OLD,
    });
    const plan = planMemoryErasure({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "record",
      recordId: "record-held",
      method: "field_redaction",
      actorId: "privacy-admin",
      reasonCode: "field_erasure",
      now: NOW,
    }, db);
    expect(plan.effective_method).toBe("physical_delete");
    const hold = placeMemoryLegalHold({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "record",
      resourceId: "record-held",
      actorId: "legal",
      reasonCode: "litigation",
      now: NOW,
    }, db);
    expect(() => applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
    }, db)).toThrowError(expect.objectContaining({ code: "legal_hold_active" }));
    releaseMemoryLegalHold({
      holdId: hold.holdId,
      actorId: "legal",
      reasonCode: "matter_closed",
      now: "2026-08-03T12:01:00.000Z",
    }, db);
    applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
    }, db);
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_records WHERE record_id = 'record-held'")).toBe(0);
    db.close();
  });

  it("blocks exact and class-wide holds on collateral receipt targets", () => {
    const db = database();
    const repositoryRowId = seedRepository(db, "org-a", "project-a1");
    seedReceiptCandidate(db, {
      receiptId: "receipt-collateral-held",
      candidateId: "candidate-retention-root",
      repositoryRowId,
      plane: "codebase",
      status: "rejected",
    });
    createMemoryRetentionPolicyVersion({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "candidate",
      retentionDays: 30,
      actorId: "privacy-admin",
      reasonCode: "candidate_retention",
      now: NOW,
    }, db);
    const plan = planMemoryRetention({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "candidate",
      actorId: "privacy-admin",
      reasonCode: "apply_candidate_retention",
      now: NOW,
    }, db);
    expect(plan.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource_class: "candidate", resource_id: "candidate-retention-root" }),
      expect.objectContaining({ resource_class: "receipt", resource_id: "receipt-collateral-held" }),
    ]));

    const exactHold = placeMemoryLegalHold({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "receipt",
      resourceId: "receipt-collateral-held",
      actorId: "legal",
      reasonCode: "receipt_evidence_hold",
      now: NOW,
    }, db);
    expect(() => applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: NOW,
    }, db)).toThrowError(expect.objectContaining({ code: "legal_hold_active" }));
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_erasure_requests")).toBe(0);
    releaseMemoryLegalHold({
      holdId: exactHold.holdId,
      actorId: "legal",
      reasonCode: "exact_hold_released",
      now: "2026-08-03T12:01:00.000Z",
    }, db);

    const classHold = placeMemoryLegalHold({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "receipt",
      actorId: "legal",
      reasonCode: "receipt_class_hold",
      now: "2026-08-03T12:02:00.000Z",
    }, db);
    expect(() => applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: NOW,
    }, db)).toThrowError(expect.objectContaining({ code: "legal_hold_active" }));
    releaseMemoryLegalHold({
      holdId: classHold.holdId,
      actorId: "legal",
      reasonCode: "class_hold_released",
      now: "2026-08-03T12:03:00.000Z",
    }, db);

    placeMemoryLegalHold({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "candidate",
      resourceId: "receipt-collateral-held",
      actorId: "legal",
      reasonCode: "same_id_other_class",
      now: "2026-08-03T12:04:00.000Z",
    }, db);
    applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
      now: NOW,
    }, db);
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_candidates_v1")).toBe(0);
    expect(db.prepare(
      "SELECT receipt_json FROM memory_run_receipts WHERE receipt_id = 'receipt-collateral-held'",
    ).get()).toEqual({ receipt_json: "{}" });
    db.close();
  });

  it("supports project and org-wide tenant erasure without crossing tenant boundaries", () => {
    const db = database();
    const repoA1 = seedRepository(db, "org-a", "project-a1");
    const repoA2 = seedRepository(db, "org-a", "project-a2");
    const repoB1 = seedRepository(db, "org-b", "project-b1");
    seedRecord(db, {
      recordId: "record-a1",
      orgId: "org-a",
      projectId: "project-a1",
      repositoryRowId: repoA1,
      status: "active",
      updatedAt: OLD,
    });
    seedRecord(db, {
      recordId: "record-a2",
      orgId: "org-a",
      projectId: "project-a2",
      repositoryRowId: repoA2,
      status: "active",
      updatedAt: OLD,
    });
    seedRecord(db, {
      recordId: "record-b1",
      orgId: "org-b",
      projectId: "project-b1",
      repositoryRowId: repoB1,
      status: "active",
      updatedAt: OLD,
    });

    const projectPlan = planMemoryErasure({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "tenant",
      method: "physical_delete",
      actorId: "privacy-admin",
      reasonCode: "project_deleted",
      now: NOW,
    }, db);
    applyMemoryErasurePlan({
      plan: projectPlan,
      expectedPlanDigest: projectPlan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
    }, db);
    expect(db.prepare("SELECT record_id FROM memory_records ORDER BY record_id").all())
      .toEqual([{ record_id: "record-a2" }, { record_id: "record-b1" }]);

    const orgPlan = planMemoryErasure({
      orgId: "org-a",
      dataClass: "tenant",
      method: "physical_delete",
      actorId: "privacy-admin",
      reasonCode: "tenant_deleted",
      now: "2026-08-03T13:00:00.000Z",
    }, db);
    applyMemoryErasurePlan({
      plan: orgPlan,
      expectedPlanDigest: orgPlan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
    }, db);
    expect(db.prepare("SELECT record_id, org_id FROM memory_records").all())
      .toEqual([{ record_id: "record-b1", org_id: "org-b" }]);
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_repository_registry WHERE org_id = 'org-a'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_repository_registry WHERE org_id = 'org-b'")).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });

  it("fails crypto-shred closed and rolls back a failed physical erase with guards intact", () => {
    const db = database();
    const repo = seedRepository(db, "org-a", "project-a1");
    seedRecord(db, {
      recordId: "record-protected",
      orgId: "org-a",
      projectId: "project-a1",
      repositoryRowId: repo,
      status: "revoked",
      updatedAt: OLD,
    });
    expect(() => planMemoryErasure({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "record",
      recordId: "record-protected",
      method: "crypto_shred",
      actorId: "privacy-admin",
      reasonCode: "crypto_requested",
      now: NOW,
    }, db)).toThrowError(expect.objectContaining({ code: "crypto_shred_unavailable" }));

    const plan = planMemoryErasure({
      orgId: "org-a",
      projectId: "project-a1",
      dataClass: "record",
      recordId: "record-protected",
      method: "physical_delete",
      actorId: "privacy-admin",
      reasonCode: "legal_erasure",
      now: NOW,
    }, db);
    db.exec(`
      CREATE TABLE external_record_reference (
        record_id TEXT PRIMARY KEY REFERENCES memory_records(record_id)
      );
      INSERT INTO external_record_reference VALUES ('record-protected');
    `);
    expect(() => applyMemoryErasurePlan({
      plan,
      expectedPlanDigest: plan.plan_digest,
      downtimeConfirmed: true,
      compact: false,
    }, db)).toThrow();
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_erasure_requests")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS count FROM memory_records WHERE record_id = 'record-protected'")).toBe(1);
    expect(() => db.prepare(
      "UPDATE memory_record_versions SET content_json = '{}' WHERE record_id = 'record-protected'",
    ).run()).toThrow(/immutable/);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.close();
  });
});
