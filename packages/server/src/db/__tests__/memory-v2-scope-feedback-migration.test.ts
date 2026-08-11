import { DatabaseSync } from "node:sqlite";
import { canonicalJsonSha256 } from "@pim/shared";
import { describe, expect, it } from "vitest";
import { runSchemaMigrations } from "../migrations.js";
import { reconcileMemoryV2CanonicalWrites } from "../../services/memory-v2-startup-reconciliation.js";

const CREATED_AT = "2026-08-10T00:00:00.000Z";
const EXPIRES_AT = "2026-08-11T00:00:00.000Z";
const BASE_SHA = "a".repeat(40);
const V2_REQUEST_DIGEST = canonicalJsonSha256({ request: "v2" });
const CORE_REQUEST_DIGEST = canonicalJsonSha256({ request: "projected-v1" });
const PACK_SCOPE_DIGEST = canonicalJsonSha256({ snapshot: "retrieval-pack-search-scope" });

function resourceBinding(resourceRowId = "v2res_repository:repo-row-1") {
  return {
    resource_row_id: resourceRowId,
    organization_id: "org-1",
    project_id: "project-1",
    plane: "codebase" as const,
    resource_type: "repository" as const,
    canonical_resource_id: resourceRowId.endsWith("repo-row-2")
      ? "github.com/acme/two"
      : "github.com/acme/one",
    provider: "github",
    provider_resource_id: resourceRowId.endsWith("repo-row-2")
      ? "provider-repo-2"
      : "provider-repo-1",
    display_label: resourceRowId.endsWith("repo-row-2") ? "acme/two" : "acme/one",
    permitted_operations: [
      "search",
      "detail",
      "history",
      "pack",
      "receipt_write",
      "feedback_write",
    ],
  };
}

const SCOPE_DIGEST = canonicalJsonSha256({
  schema_version: "pim.memory-scope-snapshot.codebase.v2",
  plane: "codebase",
  resource_binding: resourceBinding(),
  repository_id: "github.com/acme/one",
  base_sha: BASE_SHA,
});

function fixture(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE orgs (org_id TEXT PRIMARY KEY);
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(org_id)
    );
    CREATE TABLE service_principals (
      service_principal_id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL REFERENCES orgs(org_id)
    );
    CREATE TABLE service_tokens (
      token_id TEXT PRIMARY KEY,
      service_principal_id TEXT NOT NULL REFERENCES service_principals(service_principal_id),
      scopes_json TEXT NOT NULL,
      project_id TEXT REFERENCES projects(project_id)
    );

    INSERT INTO orgs VALUES ('org-1');
    INSERT INTO projects VALUES ('project-1', 'org-1');
    INSERT INTO service_principals VALUES ('principal-1', 'org-1');
    INSERT INTO service_tokens VALUES (
      'token-1', 'principal-1',
      '["memory:search","memory:receipt:write","memory:feedback:write"]',
      'project-1'
    );
  `);
  runSchemaMigrations(database, { throughVersion: 11 });
  database.exec(`
    INSERT INTO memory_repository_registry (
      repository_row_id, org_id, project_id, provider, provider_repository_id,
      repository_id, display_slug, valid_from, valid_until, created_at, updated_at
    ) VALUES
      ('repo-row-1', 'org-1', 'project-1', 'github', 'provider-repo-1',
       'github.com/acme/one', 'acme/one', '${CREATED_AT}', NULL, '${CREATED_AT}', '${CREATED_AT}'),
      ('repo-row-2', 'org-1', 'project-1', 'github', 'provider-repo-2',
       'github.com/acme/two', 'acme/two', '${CREATED_AT}', NULL, '${CREATED_AT}', '${CREATED_AT}');

    INSERT INTO memory_records (
      record_id, org_id, project_id, repository_row_id, harness_id, plane, kind,
      current_version, current_status, aggregate_version, shadow_recall_eligible,
      prompt_eligible, claim_key, valid_from, valid_until, expires_at, created_at, updated_at
    ) VALUES
      ('record-one', 'org-1', 'project-1', 'repo-row-1', NULL, 'codebase', 'constraint',
       1, 'active', 1, 1, 0, 'claim-one', '${CREATED_AT}', NULL, NULL, '${CREATED_AT}', '${CREATED_AT}'),
      ('record-two', 'org-1', 'project-1', 'repo-row-2', NULL, 'codebase', 'constraint',
       1, 'active', 1, 1, 0, 'claim-two', '${CREATED_AT}', NULL, NULL, '${CREATED_AT}', '${CREATED_AT}');

    INSERT INTO memory_record_versions (
      record_id, record_version, content_json, applicability_json, exceptions_json,
      compatibility_json, validation_json, evidence_json, evidence_summary_json,
      freshness_json, provenance_json, embedding_json, content_digest, recorded_at
    ) VALUES
      ('record-one', 1, '{}', '{}', '[]', '{}', '{}', '[]', '{}', '{}', '{}', NULL,
       'sha256:record-one', '${CREATED_AT}'),
      ('record-two', 1, '{}', '{}', '[]', '{}', '{}', '[]', '{}', '{}', '{}', NULL,
       'sha256:record-two', '${CREATED_AT}');
  `);
  runSchemaMigrations(database, { throughVersion: 15 });
  return database;
}

function insertPack(database: DatabaseSync, input: {
  packId?: string;
  resourceRowId?: string;
  recordId?: string;
  scopeDigest?: string;
} = {}): void {
  const packId = input.packId ?? "pack-one";
  const resourceRowId = input.resourceRowId ?? "v2res_repository:repo-row-1";
  const recordId = input.recordId ?? "record-one";
  const scopeDigest = input.scopeDigest ?? SCOPE_DIGEST;
  database.prepare(
    `INSERT INTO memory_v2_retrieval_packs (
       retrieval_pack_id, schema_version, org_id, project_id, request_id, request_digest,
       principal_id, plane, resource_row_id, resource_binding_json, scope_snapshot_digest,
       policy_version, ranker_version, budget_json, authorized_scopes_json,
       response_json, token_count, omitted_count, created_at, expires_at
     ) VALUES (?, 'pim.memory-retrieval-pack.v2', 'org-1', 'project-1', ?, ?,
       'principal-1', 'codebase', ?, ?, ?, 'policy-v1', 'ranker-v1',
       '{"max_tokens":800,"max_items":8}', '["memory:search"]',
       '{}', 12, 0, ?, ?)`,
  ).run(
    packId,
    `request-${packId}`,
    canonicalJsonSha256({ packId }),
    resourceRowId,
    JSON.stringify(resourceBinding(resourceRowId)),
    scopeDigest,
    CREATED_AT,
    EXPIRES_AT,
  );
  database.prepare(
    `INSERT INTO memory_v2_retrieval_pack_items (
       retrieval_pack_id, item_order, record_id, record_version, token_count,
       rank_score, match_reasons_json
     ) VALUES (?, 0, ?, 1, 12, 1.0, '["selector:repository"]')`,
  ).run(packId, recordId);
}

function insertReceipt(database: DatabaseSync, input: {
  receiptId?: string;
  producerRunId?: string;
  coreRequestDigest?: string;
  baseSha?: string;
} = {}): void {
  const receiptId = input.receiptId ?? "receipt-one";
  const producerRunId = input.producerRunId ?? "run-one";
  database.prepare(
    `INSERT INTO memory_run_receipts (
       receipt_id, org_id, project_id, producer_run_id, schema_major, idempotency_key,
       request_digest, receipt_json, response_json, producer_harness_id,
       repository_row_id, repository_id, base_sha, outcome_status, created_at
     ) VALUES (?, 'org-1', 'project-1', ?, 'pim.run-receipt.v1', ?, ?, '{}', '{}',
       'consumer-one', 'repo-row-1', 'github.com/acme/one', ?, 'completed', ?)`,
  ).run(
    receiptId,
    producerRunId,
    `pim.run-receipt.v2:${producerRunId}`,
    input.coreRequestDigest ?? CORE_REQUEST_DIGEST,
    input.baseSha ?? BASE_SHA,
    CREATED_AT,
  );
  database.prepare(
    `INSERT INTO memory_v2_receipt_facets (
       receipt_id, org_id, project_id, plane, resource_row_id, facet_json, created_at
     ) VALUES (?, 'org-1', 'project-1', 'codebase',
       'v2res_repository:repo-row-1', '{"projection":"v2"}', ?)`,
  ).run(receiptId, CREATED_AT);
}

function scopeSnapshot() {
  return {
    schema_version: "pim.memory-scope-snapshot.codebase.v2" as const,
    plane: "codebase" as const,
    resource_binding: resourceBinding(),
    repository_id: "github.com/acme/one",
    base_sha: BASE_SHA,
    scope_snapshot_digest: SCOPE_DIGEST,
  };
}

function receiptResponse(receiptId = "receipt-one", producerRunId = "run-one") {
  return {
    schema_version: "pim.run-receipt-result.v2" as const,
    receipt_id: receiptId,
    producer_run_id: producerRunId,
    request_digest: V2_REQUEST_DIGEST,
    tenant: { organization_id: "org-1", project_id: "project-1" },
    plane: "codebase" as const,
    resource_binding: resourceBinding(),
    scope_snapshot_digest: SCOPE_DIGEST,
    status: "accepted" as const,
    duplicate: false,
    candidate_results: [],
  };
}

function insertScope(database: DatabaseSync): void {
  database.prepare(
    `INSERT INTO memory_v2_scope_snapshots (
       receipt_id, org_id, project_id, plane, resource_row_id, producer_principal_id,
       producer_run_id, request_digest, core_request_digest, scope_snapshot_json,
       scope_snapshot_digest, response_json, created_at
     ) VALUES (
       'receipt-one', 'org-1', 'project-1', 'codebase',
       'v2res_repository:repo-row-1', 'principal-1', 'run-one', ?, ?, ?, ?, ?, ?
     )`,
  ).run(
    V2_REQUEST_DIGEST,
    CORE_REQUEST_DIGEST,
    JSON.stringify(scopeSnapshot()),
    SCOPE_DIGEST,
    JSON.stringify(receiptResponse()),
    CREATED_AT,
  );
}

function laterFeedback(disposition: "helpful" | "harmful" | "stale" = "harmful") {
  return {
    schema_version: "pim.memory-feedback.v2" as const,
    feedback_revision: 1,
    retrieval_pack_id: "pack-one",
    record_id: "record-one",
    record_version: 1,
    producer_run_id: "run-one",
    plane: "codebase" as const,
    resource_row_id: "v2res_repository:repo-row-1",
    scope_snapshot_digest: SCOPE_DIGEST,
    disposition,
    reason_code: "test.feedback",
    outcome_evidence_refs: [],
    event_time: CREATED_AT,
  };
}

function laterFeedbackResponse(feedbackId: string, signalIds: string[] = []) {
  return {
    schema_version: "pim.memory-feedback-result.v2" as const,
    feedback_id: feedbackId,
    feedback_revision: 1,
    tenant: { organization_id: "org-1", project_id: "project-1" },
    plane: "codebase" as const,
    resource_binding: resourceBinding(),
    duplicate: false,
    review_signal_ids: signalIds,
  };
}

function insertLaterFeedback(
  database: DatabaseSync,
  feedbackId = "v2-feedback-later",
  disposition: "helpful" | "harmful" | "stale" = "harmful",
  signalIds: string[] = [],
): void {
  const feedback = laterFeedback(disposition);
  database.prepare(
    `INSERT INTO memory_v2_feedback_bindings (
       feedback_id, org_id, project_id, receipt_id, producer_principal_id,
       producer_run_id, feedback_stage, feedback_revision, retrieval_pack_id,
       record_id, record_version, plane, resource_row_id, scope_snapshot_digest,
       feedback_json, feedback_digest, response_json, created_at
     ) VALUES (?, 'org-1', 'project-1', 'receipt-one', 'principal-1', 'run-one',
       'later', 1, 'pack-one', 'record-one', 1, 'codebase',
       'v2res_repository:repo-row-1', ?, ?, ?, ?, ?)`,
  ).run(
    feedbackId,
    SCOPE_DIGEST,
    JSON.stringify(feedback),
    canonicalJsonSha256(feedback),
    JSON.stringify(laterFeedbackResponse(feedbackId, signalIds)),
    CREATED_AT,
  );
}

describe("memory v2 scope and feedback migration", () => {
  it("registers only 015 and stores standalone and receipt feedback without legacy rows", () => {
    const database = fixture();
    expect(database.prepare(
      "SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1",
    ).get()).toEqual({ version: 15, name: "memory_v2_scope_feedback" });
    expect(database.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'memory_v2_runtime_attestations'",
    ).get()).toBeUndefined();

    insertPack(database);
    insertReceipt(database);
    insertScope(database);
    insertLaterFeedback(database, "v2-feedback-later", "helpful");

    const receiptItem = {
      retrieval_pack_id: "pack-one",
      scope_snapshot_digest: SCOPE_DIGEST,
      record_id: "record-one",
      record_version: 1,
      disposition: "helpful" as const,
      reason_code: "test.receipt_feedback",
    };
    database.prepare(
      `INSERT INTO memory_v2_feedback_bindings (
         feedback_id, org_id, project_id, receipt_id, producer_principal_id,
         producer_run_id, feedback_stage, feedback_revision, retrieval_pack_id,
         record_id, record_version, plane, resource_row_id, scope_snapshot_digest,
         feedback_json, feedback_digest, response_json, created_at
       ) VALUES (
         'v2-feedback-receipt', 'org-1', 'project-1', 'receipt-one', 'principal-1',
         'run-one', 'receipt', 0, 'pack-one', 'record-one', 1, 'codebase',
         'v2res_repository:repo-row-1', ?, ?, ?, ?, ?
       )`,
    ).run(
      SCOPE_DIGEST,
      JSON.stringify(receiptItem),
      canonicalJsonSha256(receiptItem),
      JSON.stringify(receiptResponse()),
      CREATED_AT,
    );
    const helpful = laterFeedback("helpful");
    database.prepare(
      `INSERT INTO memory_idempotency_keys (
         org_id, project_id, operation, idempotency_key, request_digest,
         response_resource_type, response_resource_id, response_json, created_at, expires_at
       ) VALUES
         ('org-1', 'project-1', 'memory_run_receipt_v2', 'receipt-key', ?,
          'memory_v2_scope_snapshot', 'receipt-one', ?, ?, ?),
         ('org-1', 'project-1', 'memory_feedback_v2', 'feedback-key', ?,
          'memory_v2_feedback_binding', 'v2-feedback-later', ?, ?, ?)`,
    ).run(
      V2_REQUEST_DIGEST,
      JSON.stringify(receiptResponse()),
      CREATED_AT,
      EXPIRES_AT,
      canonicalJsonSha256(helpful),
      JSON.stringify(laterFeedbackResponse("v2-feedback-later")),
      CREATED_AT,
      EXPIRES_AT,
    );

    expect(database.prepare(
      `SELECT request_digest, core_request_digest, scope_snapshot_digest
       FROM memory_v2_scope_snapshots`,
    ).get()).toEqual({
      request_digest: V2_REQUEST_DIGEST,
      core_request_digest: CORE_REQUEST_DIGEST,
      scope_snapshot_digest: SCOPE_DIGEST,
    });
    expect(database.prepare(
      `SELECT feedback_id, feedback_stage, feedback_revision
       FROM memory_v2_feedback_bindings ORDER BY feedback_stage`,
    ).all()).toEqual([
      { feedback_id: "v2-feedback-later", feedback_stage: "later", feedback_revision: 1 },
      { feedback_id: "v2-feedback-receipt", feedback_stage: "receipt", feedback_revision: 0 },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_feedback").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM memory_v2_feedback_facets").get())
      .toEqual({ count: 0 });
    expect(reconcileMemoryV2CanonicalWrites(database)).toMatchObject({
      scopeSnapshotCount: 1,
      receiptIdempotencyClaimCount: 1,
      feedbackBindingCount: 2,
      standaloneFeedbackCount: 1,
      receiptFeedbackCount: 1,
      feedbackIdempotencyClaimCount: 1,
      reviewSignalCount: 0,
      mismatchCount: 0,
      ok: true,
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    database.close();
  });

  it("allows a receipt to bind feedback to a distinct exact pack scope without widening authority", () => {
    const database = fixture();
    insertPack(database, { scopeDigest: PACK_SCOPE_DIGEST });
    insertReceipt(database);
    insertScope(database);
    const insert = database.prepare(
      `INSERT INTO memory_v2_feedback_bindings (
         feedback_id, org_id, project_id, receipt_id, producer_principal_id,
         producer_run_id, feedback_stage, feedback_revision, retrieval_pack_id,
         record_id, record_version, plane, resource_row_id, scope_snapshot_digest,
         feedback_json, feedback_digest, response_json, created_at
       ) VALUES (?, 'org-1', 'project-1', 'receipt-one', ?, 'run-one',
         'receipt', 0, 'pack-one', ?, 1, 'codebase', ?, ?, ?, ?, ?, ?)`
    );
    const insertCase = (input: {
      feedbackId: string;
      principalId?: string;
      recordId?: string;
      resourceRowId?: string;
    }): void => {
      const principalId = input.principalId ?? "principal-1";
      const recordId = input.recordId ?? "record-one";
      const resourceRowId = input.resourceRowId ?? "v2res_repository:repo-row-1";
      const item = {
        retrieval_pack_id: "pack-one",
        scope_snapshot_digest: PACK_SCOPE_DIGEST,
        record_id: recordId,
        record_version: 1,
        disposition: "helpful" as const,
        reason_code: "test.distinct_pack_scope",
      };
      insert.run(
        input.feedbackId,
        principalId,
        recordId,
        resourceRowId,
        PACK_SCOPE_DIGEST,
        JSON.stringify(item),
        canonicalJsonSha256(item),
        JSON.stringify(receiptResponse()),
        CREATED_AT,
      );
    };

    expect(() => insertCase({ feedbackId: "distinct-pack-scope" })).not.toThrow();
    expect(database.prepare(
      `SELECT feedback_id, scope_snapshot_digest FROM memory_v2_feedback_bindings
       WHERE feedback_id = 'distinct-pack-scope'`,
    ).get()).toEqual({
      feedback_id: "distinct-pack-scope",
      scope_snapshot_digest: PACK_SCOPE_DIGEST,
    });
    expect(() => insertCase({
      feedbackId: "wrong-principal",
      principalId: "principal-other",
    })).toThrow(/feedback pack binding mismatch/);
    expect(() => insertCase({
      feedbackId: "wrong-resource",
      resourceRowId: "v2res_repository:repo-row-2",
    })).toThrow(/feedback pack binding mismatch/);
    expect(() => insertCase({
      feedbackId: "wrong-pack-item",
      recordId: "record-two",
    })).toThrow(/feedback pack binding mismatch/);
    database.close();
  });

  it("rejects receipt, pack, item, resource, payload, revision, and digest mismatches", () => {
    const database = fixture();
    insertPack(database);
    insertReceipt(database);

    const insertSnapshot = database.prepare(
      `INSERT INTO memory_v2_scope_snapshots (
         receipt_id, org_id, project_id, plane, resource_row_id, producer_principal_id,
         producer_run_id, request_digest, core_request_digest, scope_snapshot_json,
         scope_snapshot_digest, response_json, created_at
       ) VALUES (
         'receipt-one', 'org-1', 'project-1', 'codebase',
         'v2res_repository:repo-row-1', 'principal-1', 'run-one', ?, ?, ?, ?, ?, ?
       )`,
    );
    expect(() => insertSnapshot.run(
      V2_REQUEST_DIGEST,
      canonicalJsonSha256({ wrong: true }),
      JSON.stringify(scopeSnapshot()),
      SCOPE_DIGEST,
      JSON.stringify(receiptResponse()),
      CREATED_AT,
    )).toThrow(/snapshot receipt binding mismatch/);
    expect(() => insertSnapshot.run(
      V2_REQUEST_DIGEST,
      CORE_REQUEST_DIGEST,
      JSON.stringify({ ...scopeSnapshot(), base_sha: "b".repeat(40) }),
      SCOPE_DIGEST,
      JSON.stringify(receiptResponse()),
      CREATED_AT,
    )).toThrow(/codebase scope snapshot mismatch/);
    insertScope(database);

    const feedback = laterFeedback("helpful");
    const insert = database.prepare(
      `INSERT INTO memory_v2_feedback_bindings (
         feedback_id, org_id, project_id, receipt_id, producer_principal_id,
         producer_run_id, feedback_stage, feedback_revision, retrieval_pack_id,
         record_id, record_version, plane, resource_row_id, scope_snapshot_digest,
         feedback_json, feedback_digest, response_json, created_at
       ) VALUES (?, 'org-1', 'project-1', 'receipt-one', 'principal-1', 'run-one',
         ?, ?, 'pack-one', ?, 1, 'codebase', ?, ?, ?, ?, ?, ?)`,
    );
    expect(() => insert.run(
      "bad-revision",
      "receipt",
      1,
      "record-one",
      "v2res_repository:repo-row-1",
      SCOPE_DIGEST,
      JSON.stringify(feedback),
      canonicalJsonSha256(feedback),
      JSON.stringify(receiptResponse()),
      CREATED_AT,
    )).toThrow(/receipt feedback payload mismatch|CHECK constraint failed/);
    expect(() => insert.run(
      "bad-item",
      "later",
      2,
      "record-two",
      "v2res_repository:repo-row-1",
      SCOPE_DIGEST,
      JSON.stringify({ ...feedback, feedback_revision: 2, record_id: "record-two" }),
      canonicalJsonSha256({ ...feedback, feedback_revision: 2, record_id: "record-two" }),
      JSON.stringify({ ...laterFeedbackResponse("bad-item"), feedback_revision: 2 }),
      CREATED_AT,
    )).toThrow(/feedback pack binding mismatch/);
    expect(() => insert.run(
      "bad-resource",
      "later",
      2,
      "record-one",
      "v2res_repository:repo-row-2",
      SCOPE_DIGEST,
      JSON.stringify({
        ...feedback,
        feedback_revision: 2,
        resource_row_id: "v2res_repository:repo-row-2",
      }),
      canonicalJsonSha256({ bad: "resource" }),
      JSON.stringify({
        ...laterFeedbackResponse("bad-resource"),
        feedback_revision: 2,
        resource_binding: resourceBinding("v2res_repository:repo-row-2"),
      }),
      CREATED_AT,
    )).toThrow(/feedback pack binding mismatch/);
    expect(() => insert.run(
      "bad-digest",
      "later",
      2,
      "record-one",
      "v2res_repository:repo-row-1",
      "sha256:not-a-digest",
      JSON.stringify({ ...feedback, feedback_revision: 2 }),
      canonicalJsonSha256(feedback),
      JSON.stringify({ ...laterFeedbackResponse("bad-digest"), feedback_revision: 2 }),
      CREATED_AT,
    )).toThrow(/feedback pack binding mismatch|CHECK constraint failed/);

    const evidence128 = Array.from({ length: 128 }, (_, index) => `evidence-${index}`);
    const maxEvidenceFeedback = {
      ...feedback,
      feedback_revision: 2,
      outcome_evidence_refs: evidence128,
    };
    expect(() => insert.run(
      "feedback-evidence-128",
      "later",
      2,
      "record-one",
      "v2res_repository:repo-row-1",
      SCOPE_DIGEST,
      JSON.stringify(maxEvidenceFeedback),
      canonicalJsonSha256(maxEvidenceFeedback),
      JSON.stringify({
        ...laterFeedbackResponse("feedback-evidence-128"),
        feedback_revision: 2,
      }),
      CREATED_AT,
    )).not.toThrow();
    const overEvidenceFeedback = {
      ...feedback,
      feedback_revision: 3,
      outcome_evidence_refs: [...evidence128, "evidence-128"],
    };
    expect(() => insert.run(
      "feedback-evidence-129",
      "later",
      3,
      "record-one",
      "v2res_repository:repo-row-1",
      SCOPE_DIGEST,
      JSON.stringify(overEvidenceFeedback),
      canonicalJsonSha256(overEvidenceFeedback),
      JSON.stringify({
        ...laterFeedbackResponse("feedback-evidence-129"),
        feedback_revision: 3,
      }),
      CREATED_AT,
    )).toThrow(/later feedback payload mismatch/);

    const boundaryRunId = "r".repeat(256);
    insertReceipt(database, {
      receiptId: "receipt-boundary",
      producerRunId: boundaryRunId,
    });
    const boundaryResponse = {
      ...receiptResponse("receipt-boundary", boundaryRunId),
      candidate_results: Array.from({ length: 64 }, () => ({})),
    };
    expect(() => database.prepare(
      `INSERT INTO memory_v2_scope_snapshots (
         receipt_id, org_id, project_id, plane, resource_row_id, producer_principal_id,
         producer_run_id, request_digest, core_request_digest, scope_snapshot_json,
         scope_snapshot_digest, response_json, created_at
       ) VALUES (
         'receipt-boundary', 'org-1', 'project-1', 'codebase',
         'v2res_repository:repo-row-1', 'principal-1', ?, ?, ?, ?, ?, ?, ?
       )`,
    ).run(
      boundaryRunId,
      V2_REQUEST_DIGEST,
      CORE_REQUEST_DIGEST,
      JSON.stringify(scopeSnapshot()),
      SCOPE_DIGEST,
      JSON.stringify(boundaryResponse),
      CREATED_AT,
    )).not.toThrow();
    const overBoundaryResponse = {
      ...receiptResponse("receipt-over-boundary", "run-over-boundary"),
      candidate_results: Array.from({ length: 65 }, () => ({})),
    };
    insertReceipt(database, {
      receiptId: "receipt-over-boundary",
      producerRunId: "run-over-boundary",
    });
    expect(() => database.prepare(
      `INSERT INTO memory_v2_scope_snapshots (
         receipt_id, org_id, project_id, plane, resource_row_id, producer_principal_id,
         producer_run_id, request_digest, core_request_digest, scope_snapshot_json,
         scope_snapshot_digest, response_json, created_at
       ) VALUES (
         'receipt-over-boundary', 'org-1', 'project-1', 'codebase',
         'v2res_repository:repo-row-1', 'principal-1', 'run-over-boundary',
         ?, ?, ?, ?, ?, ?
       )`,
    ).run(
      V2_REQUEST_DIGEST,
      CORE_REQUEST_DIGEST,
      JSON.stringify(scopeSnapshot()),
      SCOPE_DIGEST,
      JSON.stringify(overBoundaryResponse),
      CREATED_AT,
    )).toThrow(/scope snapshot response mismatch/);
    database.close();
  });

  it("binds harmful and stale review signals to explicit v2 outbox jobs", () => {
    const database = fixture();
    insertPack(database);
    insertReceipt(database);
    insertScope(database);
    insertLaterFeedback(database, "v2-feedback-later", "harmful", ["v2-signal-harmful"]);

    database.prepare(
      `INSERT INTO memory_outbox (
         job_id, org_id, project_id, job_type, aggregate_type, aggregate_id,
         expected_version, payload_json, status, attempt_count, max_attempts,
         next_attempt_at, lease_owner, lease_expires_at, last_error_code,
         last_error_message, created_at, updated_at, completed_at
       ) VALUES (
         'v2-job-harmful', 'org-1', 'project-1', 'review_notification', 'record',
         'record-one', 1, ?, 'pending', 0, 5, ?, NULL, NULL, NULL, NULL, ?, ?, NULL
       )`,
    ).run(
      JSON.stringify({
        feedback_source: "memory_v2_feedback_bindings",
        feedback_id: "v2-feedback-later",
        signal_id: "v2-signal-harmful",
      }),
      CREATED_AT,
      CREATED_AT,
      CREATED_AT,
    );
    database.prepare(
      `INSERT INTO memory_v2_feedback_review_signals (
         signal_id, org_id, project_id, feedback_id, record_id, record_version,
         signal_type, reason_code, status, outbox_job_id, created_at, resolved_at
       ) VALUES (
         'v2-signal-harmful', 'org-1', 'project-1', 'v2-feedback-later',
         'record-one', 1, 'harmful_review', 'test.feedback', 'open',
         'v2-job-harmful', ?, NULL
       )`,
    ).run(CREATED_AT);
    expect(database.prepare(
      `SELECT signal_id, feedback_id, outbox_job_id
       FROM memory_v2_feedback_review_signals`,
    ).get()).toEqual({
      signal_id: "v2-signal-harmful",
      feedback_id: "v2-feedback-later",
      outbox_job_id: "v2-job-harmful",
    });
    expect(() => database.prepare(
      `UPDATE memory_v2_feedback_bindings SET feedback_revision = 2
       WHERE feedback_id = 'v2-feedback-later'`,
    ).run()).toThrow(/append-only/);
    expect(() => database.prepare(
      `DELETE FROM memory_v2_feedback_review_signals
       WHERE signal_id = 'v2-signal-harmful'`,
    ).run()).toThrow(/cannot be deleted/);

    database.prepare(
      `INSERT INTO memory_outbox (
         job_id, org_id, project_id, job_type, aggregate_type, aggregate_id,
         expected_version, payload_json, status, attempt_count, max_attempts,
         next_attempt_at, lease_owner, lease_expires_at, last_error_code,
         last_error_message, created_at, updated_at, completed_at
       ) VALUES (
         'v2-job-wrong-source', 'org-1', 'project-1', 'review_notification', 'record',
         'record-one', 1, ?, 'pending', 0, 5, ?, NULL, NULL, NULL, NULL, ?, ?, NULL
       )`,
    ).run(
      JSON.stringify({
        feedback_source: "memory_feedback",
        feedback_id: "v2-feedback-later",
        signal_id: "v2-signal-wrong-source",
      }),
      CREATED_AT,
      CREATED_AT,
      CREATED_AT,
    );
    expect(() => database.prepare(
      `INSERT INTO memory_v2_feedback_review_signals (
         signal_id, org_id, project_id, feedback_id, record_id, record_version,
         signal_type, reason_code, status, outbox_job_id, created_at, resolved_at
       ) VALUES (
         'v2-signal-wrong-source', 'org-1', 'project-1', 'v2-feedback-later',
         'record-one', 1, 'harmful_review', 'test.feedback', 'open',
         'v2-job-wrong-source', ?, NULL
       )`,
    ).run(CREATED_AT)).toThrow(/review outbox mismatch/);
    database.close();
  });
});
