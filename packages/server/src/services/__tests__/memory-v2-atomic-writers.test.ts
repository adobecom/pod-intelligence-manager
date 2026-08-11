import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONTRACT_FIXTURES,
  canonicalJsonSha256,
  parseMemoryContract,
  type CodeEvidenceManifestV2,
  type MemoryCandidateV1,
  type MemoryFeedbackV1,
  type RunReceiptV1,
} from "@pim/shared";
import db from "../../db/connection.js";
import {
  createMemoryTestContext,
  type MemoryTestContext,
} from "../../routes/__tests__/memory-test-app.js";
import { appendMemoryFeedback } from "../memory-feedback.js";
import { insertMemoryCandidate } from "../memory-candidates.js";
import { createMemoryHarnessPrincipalBinding } from "../memory-harness-bindings.js";
import { importActiveMemoryRecord } from "../memory-records.js";
import {
  registerMemoryRepository,
  resolveMemoryRepository,
} from "../memory-repository-registry.js";
import {
  reconcileMemoryV2Resources,
} from "../memory-v2-resources.js";
import {
  assertMemoryV2StartupReconciled,
  reconcileMemoryV2CanonicalFacets,
} from "../memory-v2-startup-reconciliation.js";
import {
  acceptMemoryRunReceipt,
  canonicalEvidenceManifestDigest,
} from "../memory-receipts.js";
import { createServiceToken } from "../service-tokens.js";

const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const TREE_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const NOW = "2026-08-09T18:00:00.000Z";

let context: MemoryTestContext;

function count(sql: string, ...params: Array<string | number | bigint | null>): number {
  return (db.prepare(sql).get(...params) as { count: number }).count;
}

function withFailingFacetInsert(table: string, fn: () => void): void {
  const trigger = `test_fail_${table}_${randomUUID().replaceAll("-", "")}`;
  db.exec(
    `CREATE TEMP TRIGGER ${trigger} BEFORE INSERT ON ${table}
     BEGIN SELECT RAISE(ABORT, 'injected v2 companion failure'); END`,
  );
  try {
    fn();
  } finally {
    db.exec(`DROP TRIGGER ${trigger}`);
  }
}

function removeImportedRecords(recordIds: readonly string[]): void {
  if (recordIds.length === 0) return;
  const guards = ["memory_record_versions_no_delete", "memory_transitions_no_delete"].map(
    (name) => db.prepare(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?",
    ).get(name) as { name: string; sql: string },
  );
  for (const guard of guards) db.exec(`DROP TRIGGER ${guard.name}`);
  const marks = recordIds.map(() => "?").join(",");
  try {
    const deleteFts = db.prepare("DELETE FROM memory_record_versions_fts WHERE record_key = ?");
    for (const recordId of recordIds) deleteFts.run(`${recordId}:1`);
    db.prepare(`DELETE FROM memory_applicability_indexes WHERE record_id IN (${marks})`)
      .run(...recordIds);
    db.prepare(`DELETE FROM memory_v2_record_facets WHERE record_id IN (${marks})`)
      .run(...recordIds);
    db.prepare(
      `DELETE FROM memory_transitions
       WHERE aggregate_type = 'record' AND aggregate_id IN (${marks})`,
    ).run(...recordIds);
    db.prepare(`DELETE FROM memory_record_versions WHERE record_id IN (${marks})`)
      .run(...recordIds);
    db.prepare(`DELETE FROM memory_records WHERE record_id IN (${marks})`).run(...recordIds);
  } finally {
    for (const guard of guards) db.exec(guard.sql);
  }
}

function importStartupRepresentabilityRecord(input: {
  label: string;
  evidenceType: string;
  originId: string;
}): string {
  const repository = resolveMemoryRepository(
    context.orgA.id,
    context.projectA,
    "github.com/acme/checkout",
  )!;
  const recordId = `startup-representability-${input.label}-${randomUUID()}`;
  const evidenceDigest = canonicalJsonSha256({ recordId, evidenceType: input.evidenceType });
  importActiveMemoryRecord({
    orgId: context.orgA.id,
    projectId: context.projectA,
    repositoryRowId: repository.repository_row_id,
    recordId,
    kind: "constraint",
    content: {
      summary: `Startup representability fixture ${input.label}.`,
      details: "This active v1 record exercises the v2 startup representability gate without changing retrieval behavior.",
      rationale: "The v2 route must remain closed if an active canonical record cannot be projected exactly.",
    },
    applicability: {
      repository_id: repository.repository_id,
      base_sha: BASE_SHA,
      paths: [`src/startup-${input.label}.ts`],
      symbols: [`startup_${input.label}`],
      task_classes: ["bug_fix"],
    },
    exceptions: [],
    compatibility: {
      harness_version_range: "*",
      workflow_version_range: "*",
      adapter_version_range: "*",
    },
    validation: {
      strategy: "repository_anchors",
      anchor_refs: [{
        type: "path",
        value: `src/startup-${input.label}.ts`,
        digest: evidenceDigest,
      }],
    },
    evidence: [{
      evidence_ref_id: `startup-evidence-${input.label}`,
      type: input.evidenceType,
      digest: evidenceDigest,
      origin_id: input.originId,
      source_authority: "observed",
    }],
    evidenceSummary: { strength: "observed", ref_count: 1 },
    freshness: { last_confirmed_at: NOW, expires_at: null },
    provenance: { producer: "slice-2-startup-test", extractor_version: "v1" },
    now: NOW,
  });
  return recordId;
}

function codeReceipt(input: {
  producerRunId: string;
  withCandidate?: boolean;
}): RunReceiptV1 {
  const receipt = structuredClone(MEMORY_CONTRACT_FIXTURES.RunReceiptV1) as unknown as RunReceiptV1;
  const candidate = structuredClone(
    MEMORY_CONTRACT_FIXTURES.MemoryCandidateV1,
  ) as unknown as MemoryCandidateV1;
  const refId = `atomic-diff-${randomUUID()}`;
  const manifestBody: Omit<CodeEvidenceManifestV2, "digest"> = {
    schema_version: "pim.memory-code-evidence.v2",
    manifest_id: `atomic-manifest-${randomUUID()}`,
    refs: [{
      id: refId,
      type: "git_diff",
      uri: `https://github.com/acme/checkout/commit/${TREE_SHA}.diff`,
      digest: canonicalJsonSha256({ refId }),
      origin_id: `github.com/acme/checkout:${TREE_SHA}:${refId}`,
      occurred_at: NOW,
      source_authority: "observed",
    }],
  };
  const manifest = parseMemoryContract("CodeEvidenceManifestV2", {
    ...manifestBody,
    digest: canonicalEvidenceManifestDigest(manifestBody),
  });
  const parsedCandidate = parseMemoryContract("MemoryCandidateV1", {
    ...candidate,
    client_candidate_id: `atomic-candidate-${randomUUID()}`,
    source_run_ids: [input.producerRunId],
    evidence_refs: [refId],
  });
  return parseMemoryContract("RunReceiptV1", {
    ...receipt,
    external_session_id: `atomic-session-${randomUUID()}`,
    tenant: { project_id: context.projectA },
    ...(input.withCandidate === false ? {} : { evidence_manifest: manifest }),
    candidates: input.withCandidate === false ? [] : [parsedCandidate],
  });
}

function acceptCodeReceipt(producerRunId: string, withCandidate = true) {
  const repository = resolveMemoryRepository(
    context.orgA.id,
    context.projectA,
    "github.com/acme/checkout",
  );
  expect(repository).not.toBeNull();
  const receipt = codeReceipt({ producerRunId, withCandidate });
  return {
    repository: repository!,
    receipt,
    accepted: acceptMemoryRunReceipt({
      orgId: context.orgA.id,
      projectId: context.projectA,
      principalId: "atomic-code-producer",
      producerRunId,
      repository: repository!,
      receipt,
      now: NOW,
    }),
  };
}

function harnessConstraintReceipt(): {
  producerRunId: string;
  receipt: RunReceiptV1;
} {
  const suffix = randomUUID();
  const producerRunId = `atomic-harness-${suffix}`;
  const failureRefId = `atomic-harness-failure-${suffix}`;
  const manifestBody: Omit<CodeEvidenceManifestV2, "digest"> = {
    schema_version: "pim.memory-code-evidence.v2",
    manifest_id: `atomic-harness-manifest-${suffix}`,
    refs: [{
      id: failureRefId,
      type: "failure",
      uri: `https://github.com/acme/checkout/commit/${TREE_SHA}.log`,
      digest: canonicalJsonSha256({ failureRefId }),
      origin_id: `example-harness-a:${producerRunId}:failure`,
      occurred_at: NOW,
      source_authority: "observed",
    }],
  };
  const candidate = parseMemoryContract("MemoryCandidateV1", {
    schema_version: "pim.memory-candidate.v1",
    client_candidate_id: `atomic-harness-candidate-${suffix}`,
    plane: "harness",
    kind: "constraint",
    content: {
      summary: `Keep ambiguous harness constraint ${suffix} unclassified.`,
      details: "A legacy harness constraint does not prove whether it is a tool constraint or an escalation requirement.",
      rationale: "The v2 companion must preserve ambiguity instead of guessing a subtype.",
    },
    applicability: {
      harness_id: "example-harness-a",
      harness_version_range: "harness-atomic-v1",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "example-harness-a-pim-adapter.v1",
      configuration_ids: ["routing-default-v2"],
      model_ids: ["gpt-atomic"],
      tool_ids: ["terminal-state-inspector"],
    },
    validation: {
      strategy: "stable_failure_fingerprint",
      failure_fingerprint: `example-harness-a:atomic:${suffix}`,
    },
    exceptions: [],
    source_run_ids: [producerRunId],
    evidence_refs: [failureRefId],
    extraction: {
      method: "deterministic",
      extractor_version: "atomic-harness-extractor.v1",
      confidence: 1,
    },
    activation_requirement_requested: "authorized_review",
  });
  const manifest = parseMemoryContract("CodeEvidenceManifestV2", {
    ...manifestBody,
    digest: canonicalEvidenceManifestDigest(manifestBody),
  });
  return {
    producerRunId,
    receipt: parseMemoryContract("RunReceiptV1", {
      schema_version: "pim.run-receipt.v1",
      external_session_id: `atomic-harness-session-${suffix}`,
      producer: {
        harness_id: "example-harness-a",
        harness_version: "harness-atomic-v1",
        workflow_version: "code-change.v3",
        adapter_version: "example-harness-a-pim-adapter.v1",
      },
      tenant: { project_id: context.projectA },
      task: { task_class: "recovery", summary: "Preserve an ambiguous constraint safely." },
      outcome: {
        status: "failed",
        terminal_stage: "close",
        reason_code: "atomic_ambiguous_constraint",
        verification_status: "failed",
        publication_status: "none",
        gate_attestation_ids: [],
        failure_fingerprint: `example-harness-a:atomic:${suffix}`,
      },
      retrieval_feedback: [],
      evidence_manifest: manifest,
      candidates: [candidate],
    }),
  };
}

function insertFeedbackPack(input: {
  packId: string;
  producerRunId: string;
  repositoryRowId: string;
}): void {
  db.prepare(
    `INSERT INTO memory_retrieval_packs
       (retrieval_pack_id, org_id, project_id, request_id, request_digest,
        repository_row_id, repository_id, harness_id, plane, query, policy_version,
        ranker_version, authorized_scope_json, token_count, omitted_count, response_json,
        created_at, expires_at, consumer_run_id, request_base_sha)
     VALUES (?, ?, ?, ?, ?, ?, 'github.com/acme/checkout', NULL, 'codebase', ?,
             'atomic-policy-v1', 'atomic-ranker-v1', '["memory:search"]', 32, 0,
             '{}', ?, ?, ?, ?)`,
  ).run(
    input.packId,
    context.orgA.id,
    context.projectA,
    `atomic-request-${randomUUID()}`,
    canonicalJsonSha256({ packId: input.packId }),
    input.repositoryRowId,
    "atomic feedback target",
    NOW,
    "2026-08-09T18:15:00.000Z",
    input.producerRunId,
    BASE_SHA,
  );
  db.prepare(
    `INSERT INTO memory_retrieval_pack_items
       (retrieval_pack_id, item_order, record_id, record_version,
        token_count, rank_score, match_reasons_json)
     VALUES (?, 0, ?, 1, 32, 1, '["exact_path"]')`,
  ).run(input.packId, context.seededRecordId);
}

function feedback(input: {
  packId: string;
  producerRunId: string;
  revision?: number;
}): MemoryFeedbackV1 {
  return parseMemoryContract("MemoryFeedbackV1", {
    ...structuredClone(MEMORY_CONTRACT_FIXTURES.MemoryFeedbackV1),
    feedback_revision: input.revision ?? 1,
    retrieval_pack_id: input.packId,
    record_id: context.seededRecordId,
    record_version: 1,
    producer_run_id: input.producerRunId,
    repository_id: "github.com/acme/checkout",
    base_sha: BASE_SHA,
    disposition: "harmful",
    reason_code: "atomic_harmful_fixture",
    outcome_evidence_refs: [],
    event_time: NOW,
  });
}

beforeAll(async () => {
  context = await createMemoryTestContext();
});

afterAll(async () => {
  if (context) await context.app.close();
});

describe("memory v2 atomic companion writers", () => {
  it("creates repository, harness, and seeded-record companions with bounded identities", () => {
    const repositoryResource = db.prepare(
      `SELECT resource_row_id, plane, canonical_resource_id
       FROM memory_v2_resources
       WHERE source_authority = 'memory_repository_registry'
         AND canonical_resource_id = 'github.com/acme/checkout'
         AND org_id = ? AND project_id = ?`,
    ).get(context.orgA.id, context.projectA) as {
      resource_row_id: string;
      plane: string;
      canonical_resource_id: string;
    } | undefined;
    expect(repositoryResource).toMatchObject({
      plane: "codebase",
      canonical_resource_id: "github.com/acme/checkout",
    });
    expect(repositoryResource!.resource_row_id.length).toBeLessThanOrEqual(128);

    const harnessResource = db.prepare(
      `SELECT resource_row_id, plane, canonical_resource_id
       FROM memory_v2_resources
       WHERE source_authority = 'memory_harness_principal_bindings'
         AND canonical_resource_id = 'example-harness-a'
         AND org_id = ? AND project_id = ?`,
    ).get(context.orgA.id, context.projectA) as {
      resource_row_id: string;
      plane: string;
      canonical_resource_id: string;
    } | undefined;
    expect(harnessResource).toMatchObject({ plane: "harness", canonical_resource_id: "example-harness-a" });
    expect(harnessResource!.resource_row_id).toMatch(/^v2res_harness:[0-9a-f-]{32,36}$/);
    expect(harnessResource!.resource_row_id.length).toBeLessThanOrEqual(128);

    expect(db.prepare(
      `SELECT plane, resource_row_id, broad_kind, subtype, projection_status
       FROM memory_v2_record_facets WHERE record_id = ? AND record_version = 1`,
    ).get(context.seededRecordId)).toEqual({
      plane: "codebase",
      resource_row_id: repositoryResource!.resource_row_id,
      broad_kind: "constraint",
      subtype: null,
      projection_status: "mapped",
    });
  });

  it("does not let a drifted memory companion block an unrelated repository-bound token", () => {
    const resource = db.prepare(
      `SELECT resource_row_id, display_label
       FROM memory_v2_resources
       WHERE source_authority = 'memory_repository_registry'
         AND canonical_resource_id = 'github.com/acme/checkout'
         AND org_id = ? AND project_id = ?`,
    ).get(context.orgA.id, context.projectA) as {
      resource_row_id: string;
      display_label: string;
    };
    const creator = db.prepare(
      "SELECT created_by_user_id FROM orgs WHERE org_id = ?",
    ).get(context.orgA.id) as { created_by_user_id: string };

    db.prepare(
      "UPDATE memory_v2_resources SET display_label = ? WHERE resource_row_id = ?",
    ).run("drifted-memory-companion", resource.resource_row_id);
    try {
      const unrelated = createServiceToken({
        orgId: context.orgA.id,
        name: `Unrelated token ${randomUUID()}`,
        scopes: ["project:read"],
        createdByUserId: creator.created_by_user_id,
        projectId: context.projectA,
        repositoryIds: ["github.com/acme/checkout"],
        expiresAt: "2027-08-09T18:00:00.000Z",
      });
      expect(unrelated.scopes).toEqual(["project:read"]);
      expect(count(
        `SELECT COUNT(*) AS count FROM memory_v2_service_token_resource_bindings
         WHERE token_id = ?`,
        unrelated.token_id,
      )).toBe(0);

      let relatedError: unknown;
      try {
        createServiceToken({
          orgId: context.orgA.id,
          name: `Related memory token ${randomUUID()}`,
          scopes: ["memory:search"],
          createdByUserId: creator.created_by_user_id,
          projectId: context.projectA,
          repositoryIds: ["github.com/acme/checkout"],
          expiresAt: "2027-08-09T18:00:00.000Z",
        });
      } catch (error) {
        relatedError = error;
      }
      expect(relatedError).toMatchObject({
        name: "MemoryV2ResourceError",
        statusCode: 409,
        code: "idempotency_conflict",
      });
    } finally {
      db.prepare(
        "UPDATE memory_v2_resources SET display_label = ? WHERE resource_row_id = ?",
      ).run(resource.display_label, resource.resource_row_id);
    }
  });

  it("reconciles exact token binding identities and operation sets, not counts alone", () => {
    const binding = db.prepare(
      `SELECT binding_id, operations_json
       FROM memory_v2_service_token_resource_bindings
       WHERE source_binding_type = 'repository_token_binding'
       ORDER BY binding_id LIMIT 1`,
    ).get() as { binding_id: string; operations_json: string };
    const immutableTrigger = db.prepare(
      `SELECT sql FROM sqlite_schema
       WHERE type = 'trigger' AND name = 'memory_v2_token_resource_bindings_no_update'`,
    ).get() as { sql: string };

    expect(reconcileMemoryV2Resources()).toMatchObject({
      bindingIdentityMismatchCount: 0,
      aliasIdentityMismatchCount: 0,
      ok: true,
    });

    db.exec("DROP TRIGGER memory_v2_token_resource_bindings_no_update");
    try {
      db.prepare(
        `UPDATE memory_v2_service_token_resource_bindings
         SET operations_json = '["search"]' WHERE binding_id = ?`,
      ).run(binding.binding_id);
      expect(reconcileMemoryV2Resources()).toMatchObject({
        bindingIdentityMismatchCount: 2,
        ok: false,
      });
    } finally {
      db.prepare(
        `UPDATE memory_v2_service_token_resource_bindings
         SET operations_json = ? WHERE binding_id = ?`,
      ).run(binding.operations_json, binding.binding_id);
      db.exec(immutableTrigger.sql);
    }

    expect(reconcileMemoryV2Resources()).toMatchObject({
      bindingIdentityMismatchCount: 0,
      ok: true,
    });
  });

  it("fails startup closed on facet corruption or a partial active pointer", () => {
    const initialReconciliation = assertMemoryV2StartupReconciled();
    expect(initialReconciliation.facets).toMatchObject({
      activePointerMismatchCount: 0,
      ok: true,
    });
    expect(initialReconciliation.runtimeOrigins).toMatchObject({
      mismatchCount: 0,
      foreignKeyViolationCount: 0,
      ok: true,
    });

    const facet = db.prepare(
      `SELECT * FROM memory_v2_record_facets
       WHERE record_id = ? AND record_version = 1`,
    ).get(context.seededRecordId) as {
      record_id: string;
      record_version: number;
      org_id: string;
      project_id: string;
      plane: string;
      resource_row_id: string;
      broad_kind: string;
      subtype: string | null;
      projection_status: string;
      facet_json: string;
      created_at: string;
    };
    const trust = db.prepare(
      `SELECT * FROM memory_v2_record_trust
       WHERE record_id = ? AND record_version = 1`,
    ).get(context.seededRecordId) as {
      record_id: string;
      record_version: number;
      org_id: string;
      project_id: string;
      plane: string;
      resource_row_id: string;
      trust_status: string;
      trust_basis: string;
      cutover_decided_at: string | null;
      evidence_verified_at: string | null;
      created_at: string;
      updated_at: string;
    };
    const immutableTrigger = db.prepare(
      `SELECT sql FROM sqlite_schema
       WHERE type = 'trigger' AND name = 'memory_v2_record_facets_no_update'`,
    ).get() as { sql: string };
    db.exec("DROP TRIGGER memory_v2_record_facets_no_update");
    try {
      db.prepare(
        `UPDATE memory_v2_record_facets SET facet_json = '{}'
         WHERE record_id = ? AND record_version = 1`,
      ).run(context.seededRecordId);
      expect(reconcileMemoryV2CanonicalFacets()).toMatchObject({
        records: { mismatchCount: 1 },
        ok: false,
      });
      expect(() => assertMemoryV2StartupReconciled()).toThrow(/service remains closed/);
    } finally {
      db.prepare(
        `UPDATE memory_v2_record_facets SET facet_json = ?
         WHERE record_id = ? AND record_version = 1`,
      ).run(facet.facet_json, context.seededRecordId);
      db.exec(immutableTrigger.sql);
    }

    const source = db.prepare(
      `SELECT version.content_digest, version.recorded_at
       FROM memory_record_versions AS version
       WHERE version.record_id = ? AND version.record_version = 1`,
    ).get(context.seededRecordId) as { content_digest: string; recorded_at: string };
    const quarantineDeleteTrigger = db.prepare(
      `SELECT sql FROM sqlite_schema
       WHERE type = 'trigger' AND name = 'memory_v2_facet_quarantine_no_delete'`,
    ).get() as { sql: string };
    db.prepare(
      "DELETE FROM memory_v2_record_facets WHERE record_id = ? AND record_version = 1",
    ).run(context.seededRecordId);
    try {
      db.prepare(
        `INSERT INTO memory_v2_facet_quarantine
           (aggregate_type, aggregate_id, aggregate_version, org_id, project_id,
            source_plane, reason_code, source_digest, created_at)
         VALUES ('record', ?, 1, ?, ?, 'codebase', 'resource_missing', ?, ?)`,
      ).run(
        context.seededRecordId,
        facet.org_id,
        facet.project_id,
        source.content_digest,
        source.recorded_at,
      );
      expect(reconcileMemoryV2CanonicalFacets()).toMatchObject({
        records: { mismatchCount: 0 },
        codeReadMismatchCount: 1,
        codeReadQuarantineCount: 1,
        ok: false,
      });
      expect(() => assertMemoryV2StartupReconciled()).toThrow(/service remains closed/);
    } finally {
      db.exec("DROP TRIGGER memory_v2_facet_quarantine_no_delete");
      try {
        db.prepare(
          `DELETE FROM memory_v2_facet_quarantine
           WHERE aggregate_type = 'record' AND aggregate_id = ? AND aggregate_version = 1`,
        ).run(context.seededRecordId);
      } finally {
        db.exec(quarantineDeleteTrigger.sql);
      }
      db.prepare(
        `INSERT INTO memory_v2_record_facets
           (record_id, record_version, org_id, project_id, plane, resource_row_id,
            broad_kind, subtype, projection_status, facet_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        facet.record_id,
        facet.record_version,
        facet.org_id,
        facet.project_id,
        facet.plane,
        facet.resource_row_id,
        facet.broad_kind,
        facet.subtype,
        facet.projection_status,
        facet.facet_json,
        facet.created_at,
      );
      db.prepare(
        `INSERT INTO memory_v2_record_trust (
           record_id, record_version, org_id, project_id, plane, resource_row_id,
           trust_status, trust_basis, cutover_decided_at, evidence_verified_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        trust.record_id,
        trust.record_version,
        trust.org_id,
        trust.project_id,
        trust.plane,
        trust.resource_row_id,
        trust.trust_status,
        trust.trust_basis,
        trust.cutover_decided_at,
        trust.evidence_verified_at,
        trust.created_at,
        trust.updated_at,
      );
    }

    const repository = resolveMemoryRepository(
      context.orgA.id,
      context.projectA,
      "github.com/acme/checkout",
    )!;
    const claimKey = `startup-partial-${randomUUID()}`;
    db.prepare(
      `INSERT INTO memory_activation_claims
         (org_id, project_id, repository_row_id, plane, conflict_key,
          aggregate_version, current_candidate_id, current_record_id,
          current_record_version, created_at, updated_at)
       VALUES (?, ?, ?, 'codebase', ?, 1, NULL, ?, 1, ?, ?)`,
    ).run(
      context.orgA.id,
      context.projectA,
      repository.repository_row_id,
      claimKey,
      context.seededRecordId,
      NOW,
      NOW,
    );
    try {
      expect(reconcileMemoryV2CanonicalFacets()).toMatchObject({
        activePointerCount: 1,
        activePointerMismatchCount: 1,
        ok: false,
      });
      expect(() => assertMemoryV2StartupReconciled()).toThrow(/service remains closed/);
    } finally {
      db.prepare(
        `DELETE FROM memory_activation_claims
         WHERE org_id = ? AND project_id = ? AND repository_row_id = ?
           AND plane = 'codebase' AND conflict_key = ?`,
      ).run(context.orgA.id, context.projectA, repository.repository_row_id, claimKey);
    }
    expect(assertMemoryV2StartupReconciled().facets.ok).toBe(true);
  });

  it("keeps startup closed until every active v1 code record is representable as v2", () => {
    const importedRecordIds: string[] = [];
    try {
      importedRecordIds.push(importStartupRepresentabilityRecord({
        label: "representable",
        evidenceType: "git_diff",
        originId: "github.com/acme/checkout:startup-representable",
      }));
      expect(reconcileMemoryV2CanonicalFacets()).toMatchObject({
        records: { mismatchCount: 0 },
        codeReadMismatchCount: 0,
        codeReadQuarantineCount: 0,
        ok: true,
      });

      importedRecordIds.push(importStartupRepresentabilityRecord({
        label: "unsupported-evidence-type",
        evidenceType: "incident",
        originId: "github.com/acme/checkout:startup-incident",
      }));
      expect(reconcileMemoryV2CanonicalFacets()).toMatchObject({
        records: { mismatchCount: 0 },
        codeReadMismatchCount: 1,
        codeReadQuarantineCount: 0,
        ok: false,
      });
      expect(() => assertMemoryV2StartupReconciled()).toThrow(/service remains closed/);

      importedRecordIds.push(importStartupRepresentabilityRecord({
        label: "oversize-origin",
        evidenceType: "git_diff",
        originId: "o".repeat(257),
      }));
      expect(reconcileMemoryV2CanonicalFacets()).toMatchObject({
        records: { mismatchCount: 0 },
        codeReadMismatchCount: 2,
        codeReadQuarantineCount: 0,
        ok: false,
      });
      expect(() => assertMemoryV2StartupReconciled()).toThrow(/service remains closed/);
    } finally {
      removeImportedRecords(importedRecordIds);
    }
    expect(assertMemoryV2StartupReconciled().facets).toMatchObject({
      codeReadMismatchCount: 0,
      codeReadQuarantineCount: 0,
      ok: true,
    });
  });

  it("rolls back repository, harness, token-binding, and record authority rows when companions fail", () => {
    const providerRepositoryId = `atomic-provider-${randomUUID()}`;
    withFailingFacetInsert("memory_v2_resources", () => {
      expect(() => registerMemoryRepository({
        orgId: context.orgA.id,
        projectId: context.projectA,
        providerRepositoryId,
        repositoryId: "github.com/acme/collision",
        displaySlug: "Acme/Collision",
        now: NOW,
      })).toThrow("injected v2 companion failure");
    });
    expect(count(
      "SELECT COUNT(*) AS count FROM memory_repository_registry WHERE provider_repository_id = ?",
      providerRepositoryId,
    )).toBe(0);

    const principal = db.prepare(
      `SELECT service_principal_id FROM memory_harness_principal_bindings
       WHERE org_id = ? AND project_id = ? AND harness_id = 'example-harness-a' LIMIT 1`,
    ).get(context.orgA.id, context.projectA) as { service_principal_id: string };
    const harnessId = `atomic-${randomUUID()}`;
    withFailingFacetInsert("memory_v2_resources", () => {
      expect(() => createMemoryHarnessPrincipalBinding({
        servicePrincipalId: principal.service_principal_id,
        orgId: context.orgA.id,
        projectId: context.projectA,
        harnessId,
        now: NOW,
      })).toThrow("injected v2 companion failure");
    });
    expect(count(
      "SELECT COUNT(*) AS count FROM memory_harness_principal_bindings WHERE harness_id = ?",
      harnessId,
    )).toBe(0);

    const creator = db.prepare(
      "SELECT created_by_user_id FROM orgs WHERE org_id = ?",
    ).get(context.orgA.id) as { created_by_user_id: string };
    const tokenCount = count("SELECT COUNT(*) AS count FROM service_tokens");
    const principalCount = count("SELECT COUNT(*) AS count FROM service_principals");
    const legacyBindingCount = count("SELECT COUNT(*) AS count FROM memory_service_token_repository_bindings");
    const v2BindingCount = count("SELECT COUNT(*) AS count FROM memory_v2_service_token_resource_bindings");
    withFailingFacetInsert("memory_v2_service_token_resource_bindings", () => {
      expect(() => createServiceToken({
        orgId: context.orgA.id,
        name: `Atomic token rollback ${randomUUID()}`,
        scopes: ["memory:search"],
        createdByUserId: creator.created_by_user_id,
        projectId: context.projectA,
        repositoryIds: ["github.com/acme/checkout"],
        expiresAt: "2027-08-09T18:00:00.000Z",
      })).toThrow("injected v2 companion failure");
    });
    expect(count("SELECT COUNT(*) AS count FROM service_tokens")).toBe(tokenCount);
    expect(count("SELECT COUNT(*) AS count FROM service_principals")).toBe(principalCount);
    expect(count("SELECT COUNT(*) AS count FROM memory_service_token_repository_bindings")).toBe(legacyBindingCount);
    expect(count("SELECT COUNT(*) AS count FROM memory_v2_service_token_resource_bindings")).toBe(v2BindingCount);

    const repository = resolveMemoryRepository(
      context.orgA.id,
      context.projectA,
      "github.com/acme/checkout",
    )!;
    const recordId = `mem_atomic_failure_${randomUUID()}`;
    const beforeTransitions = count("SELECT COUNT(*) AS count FROM memory_transitions");
    withFailingFacetInsert("memory_v2_record_facets", () => {
      expect(() => importActiveMemoryRecord({
        orgId: context.orgA.id,
        projectId: context.projectA,
        repositoryRowId: repository.repository_row_id,
        recordId,
        kind: "constraint",
        content: {
          summary: `Atomic record rollback ${recordId}.`,
          details: "The core record and version must roll back when its required v2 facet cannot be written.",
          rationale: "A facetless canonical record must never commit after the v2 cutover.",
        },
        applicability: {
          repository_id: repository.repository_id,
          paths: ["src/atomic-record.ts"],
        },
        exceptions: [],
        compatibility: { harness_version_range: "*", workflow_version_range: "*" },
        validation: { strategy: "repository_anchors" },
        evidence: [{
          evidence_ref_id: `atomic-record-evidence-${randomUUID()}`,
          type: "review",
          digest: canonicalJsonSha256({ recordId }),
          origin_id: `atomic-record:${recordId}`,
          source_authority: "authorized_review",
        }],
        evidenceSummary: { strength: "reviewed", ref_count: 1 },
        freshness: { last_confirmed_at: NOW },
        provenance: { producer: "atomic-writer-test", extractor_version: "v1" },
        now: NOW,
      })).toThrow("injected v2 companion failure");
    });
    expect(count("SELECT COUNT(*) AS count FROM memory_records WHERE record_id = ?", recordId)).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM memory_record_versions WHERE record_id = ?", recordId)).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM memory_transitions")).toBe(beforeTransitions);
  });

  it("writes receipt and candidate companions before idempotency/outbox completion and verifies replay", () => {
    const producerRunId = `atomic-success-${randomUUID()}`;
    const created = acceptCodeReceipt(producerRunId);
    expect(created.accepted.created).toBe(true);
    const receiptId = created.accepted.result.receipt_id;
    const candidateId = created.accepted.result.candidate_results[0]!.candidate_id;
    expect(count("SELECT COUNT(*) AS count FROM memory_v2_receipt_facets WHERE receipt_id = ?", receiptId)).toBe(1);
    expect(count("SELECT COUNT(*) AS count FROM memory_v2_candidate_facets WHERE candidate_id = ?", candidateId)).toBe(1);
    expect(count("SELECT COUNT(*) AS count FROM memory_outbox WHERE aggregate_id = ?", candidateId)).toBe(1);
    expect(count(
      `SELECT COUNT(*) AS count FROM memory_idempotency_keys
       WHERE operation = 'memory.run-receipt.v1' AND idempotency_key = ?`,
      `pim.run-receipt.v1:${producerRunId}`,
    )).toBe(1);

    const replay = acceptMemoryRunReceipt({
      orgId: context.orgA.id,
      projectId: context.projectA,
      principalId: "atomic-code-producer",
      producerRunId,
      repository: created.repository,
      receipt: created.receipt,
      now: NOW,
    });
    expect(replay.created).toBe(false);
    expect(replay.result.receipt_id).toBe(receiptId);
    expect(count("SELECT COUNT(*) AS count FROM memory_v2_candidate_facets WHERE candidate_id = ?", candidateId)).toBe(1);
    expect(count("SELECT COUNT(*) AS count FROM memory_outbox WHERE aggregate_id = ?", candidateId)).toBe(1);
  });

  it("keeps startup closed until every mapped legacy code candidate status is exactly v2-representable", () => {
    const producerRunId = `atomic-status-gate-${randomUUID()}`;
    const created = acceptCodeReceipt(producerRunId);
    const candidateId = created.accepted.result.candidate_results[0]!.candidate_id;

    expect(reconcileMemoryV2CanonicalFacets()).toMatchObject({
      candidates: { mismatchCount: 0 },
      ok: true,
    });

    db.exec("SAVEPOINT test_candidate_manual_policy_status");
    try {
      db.prepare(
        "UPDATE memory_candidates_v1 SET activation_requirement = 'manual_policy_owner' WHERE candidate_id = ?",
      ).run(candidateId);
      expect(reconcileMemoryV2CanonicalFacets()).toMatchObject({
        candidates: { mismatchCount: 1 },
        ok: false,
      });
      expect(() => assertMemoryV2StartupReconciled()).toThrow(/service remains closed/);
    } finally {
      db.exec("ROLLBACK TO test_candidate_manual_policy_status");
      db.exec("RELEASE test_candidate_manual_policy_status");
    }
    expect(reconcileMemoryV2CanonicalFacets()).toMatchObject({
      candidates: { mismatchCount: 0 },
      ok: true,
    });

    db.exec("SAVEPOINT test_candidate_transition_bounds");
    try {
      db.prepare(
        `INSERT INTO memory_transitions
           (transition_id, org_id, project_id, aggregate_type, aggregate_id,
            from_status, to_status, actor_type, actor_id, reason_code, explanation,
            evidence_refs_json, decision_refs_json, policy_version, occurred_at, committed_at)
         VALUES (?, ?, ?, 'candidate', ?, '', 'received', 'system', 'migration-test',
                 'legacy_transition', 'A v1-valid empty from-status is not valid in v2.',
                 '[]', '[]', 'memory-candidate-policy-v1', ?, ?)`,
      ).run(
        `transition_${randomUUID()}`,
        context.orgA.id,
        context.projectA,
        candidateId,
        "2026-08-09T18:00:01.000Z",
        "2026-08-09T18:00:01.000Z",
      );
      expect(reconcileMemoryV2CanonicalFacets()).toMatchObject({
        candidates: { mismatchCount: 1 },
        ok: false,
      });
      expect(() => assertMemoryV2StartupReconciled()).toThrow(/service remains closed/);
    } finally {
      db.exec("ROLLBACK TO test_candidate_transition_bounds");
      db.exec("RELEASE test_candidate_transition_bounds");
    }
    expect(assertMemoryV2StartupReconciled().facets).toMatchObject({
      candidates: { mismatchCount: 0 },
      ok: true,
    });
  });

  it("atomically quarantines an ambiguous v1 harness constraint instead of guessing a subtype", () => {
    const fixture = harnessConstraintReceipt();
    const principal = db.prepare(
      `SELECT service_principal_id FROM memory_harness_principal_bindings
       WHERE org_id = ? AND project_id = ? AND harness_id = 'example-harness-a' LIMIT 1`,
    ).get(context.orgA.id, context.projectA) as { service_principal_id: string };
    const accepted = acceptMemoryRunReceipt({
      orgId: context.orgA.id,
      projectId: context.projectA,
      principalId: principal.service_principal_id,
      producerRunId: fixture.producerRunId,
      repository: null,
      receipt: fixture.receipt,
      now: NOW,
    });
    const candidateId = accepted.result.candidate_results[0]!.candidate_id;
    expect(db.prepare(
      "SELECT 1 FROM memory_v2_candidate_facets WHERE candidate_id = ?",
    ).get(candidateId)).toBeUndefined();
    expect(db.prepare(
      `SELECT aggregate_type, aggregate_id, aggregate_version, source_plane, reason_code
       FROM memory_v2_facet_quarantine
       WHERE aggregate_type = 'candidate' AND aggregate_id = ? AND aggregate_version = 0`,
    ).get(candidateId)).toEqual({
      aggregate_type: "candidate",
      aggregate_id: candidateId,
      aggregate_version: 0,
      source_plane: "harness",
      reason_code: "subtype_ambiguous",
    });
    expect(reconcileMemoryV2CanonicalFacets()).toMatchObject({
      candidates: { mismatchCount: 0 },
      ok: true,
    });
  });

  it("rolls back receipt, candidate, idempotency, and outbox when the candidate companion fails", () => {
    const producerRunId = `atomic-failure-${randomUUID()}`;
    const beforeOutbox = count("SELECT COUNT(*) AS count FROM memory_outbox");
    withFailingFacetInsert("memory_v2_candidate_facets", () => {
      expect(() => acceptCodeReceipt(producerRunId)).toThrow("injected v2 companion failure");
    });
    expect(count("SELECT COUNT(*) AS count FROM memory_run_receipts WHERE producer_run_id = ?", producerRunId)).toBe(0);
    expect(count(
      "SELECT COUNT(*) AS count FROM memory_candidates_v1 WHERE producer_harness_id = 'example-harness-a' AND candidate_json LIKE ?",
      `%${producerRunId}%`,
    )).toBe(0);
    expect(count(
      `SELECT COUNT(*) AS count FROM memory_idempotency_keys
       WHERE operation = 'memory.run-receipt.v1' AND idempotency_key = ?`,
      `pim.run-receipt.v1:${producerRunId}`,
    )).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM memory_outbox")).toBe(beforeOutbox);
  });

  it("makes the exported direct candidate writer atomic outside receipt intake", () => {
    const producerRunId = `atomic-direct-candidate-${randomUUID()}`;
    const accepted = acceptCodeReceipt(producerRunId);
    const receiptId = accepted.accepted.result.receipt_id;
    const manifest = db.prepare(
      `SELECT evidence_manifest_row_id FROM memory_evidence_manifests
       WHERE receipt_id = ?`,
    ).get(receiptId) as { evidence_manifest_row_id: string };
    const evidenceRows = db.prepare(
      `SELECT producer_ref_id, evidence_row_id FROM memory_evidence_refs
       WHERE evidence_manifest_row_id = ?`,
    ).all(manifest.evidence_manifest_row_id) as unknown as Array<{
      producer_ref_id: string;
      evidence_row_id: string;
    }>;
    const clientCandidateId = `atomic-direct-${randomUUID()}`;
    const candidate = parseMemoryContract("MemoryCandidateV1", {
      ...accepted.receipt.candidates[0]!,
      client_candidate_id: clientCandidateId,
      content: {
        ...accepted.receipt.candidates[0]!.content,
        summary: `Direct candidate rollback ${clientCandidateId}.`,
      },
    });
    const beforeTransitions = count("SELECT COUNT(*) AS count FROM memory_transitions");
    const beforeOutbox = count("SELECT COUNT(*) AS count FROM memory_outbox");
    withFailingFacetInsert("memory_v2_candidate_facets", () => {
      expect(() => insertMemoryCandidate({
        orgId: context.orgA.id,
        projectId: context.projectA,
        receiptId,
        repositoryRowId: accepted.repository.repository_row_id,
        producerHarnessId: accepted.receipt.producer.harness_id,
        producerRunId,
        evidenceManifestRowId: manifest.evidence_manifest_row_id,
        evidenceRowsByProducerRef: new Map(evidenceRows.map((row) => [
          row.producer_ref_id,
          row.evidence_row_id,
        ])),
        candidate,
        now: NOW,
      })).toThrow("injected v2 companion failure");
    });
    expect(count(
      "SELECT COUNT(*) AS count FROM memory_candidates_v1 WHERE client_candidate_id = ?",
      clientCandidateId,
    )).toBe(0);
    expect(count("SELECT COUNT(*) AS count FROM memory_transitions")).toBe(beforeTransitions);
    expect(count("SELECT COUNT(*) AS count FROM memory_outbox")).toBe(beforeOutbox);
  });

  it("fails a receipt replay closed when the existing aggregate has no companion facet", () => {
    const producerRunId = `atomic-missing-facet-${randomUUID()}`;
    const repository = resolveMemoryRepository(
      context.orgA.id,
      context.projectA,
      "github.com/acme/checkout",
    )!;
    const receipt = codeReceipt({ producerRunId, withCandidate: false });
    const requestDigest = canonicalJsonSha256(receipt);
    const receiptId = `receipt_${randomUUID()}`;
    const response = {
      schema_version: "pim.run-receipt-result.v1",
      receipt_id: receiptId,
      producer_run_id: producerRunId,
      request_digest: requestDigest,
      status: "accepted",
      candidate_results: [],
    };
    db.prepare(
      `INSERT INTO memory_run_receipts
         (receipt_id, org_id, project_id, producer_run_id, schema_major, idempotency_key,
          request_digest, receipt_json, response_json, producer_harness_id,
          repository_row_id, repository_id, base_sha, outcome_status, created_at)
       VALUES (?, ?, ?, ?, 'pim.run-receipt.v1', NULL, ?, ?, ?, 'example-harness-a', ?,
               'github.com/acme/checkout', ?, 'completed', ?)`,
    ).run(
      receiptId,
      context.orgA.id,
      context.projectA,
      producerRunId,
      requestDigest,
      JSON.stringify(receipt),
      JSON.stringify(response),
      repository.repository_row_id,
      BASE_SHA,
      NOW,
    );
    expect(() => acceptMemoryRunReceipt({
      orgId: context.orgA.id,
      projectId: context.projectA,
      principalId: "atomic-code-producer",
      producerRunId,
      repository,
      receipt,
      now: NOW,
    })).toThrow("Canonical companion facet is missing or mismatched");
    expect(count("SELECT COUNT(*) AS count FROM memory_v2_receipt_facets WHERE receipt_id = ?", receiptId)).toBe(0);
  });

  it("keeps standalone feedback, its facet, replay, review signal, and outbox atomic", () => {
    const producerRunId = `atomic-feedback-${randomUUID()}`;
    const receipt = acceptCodeReceipt(producerRunId, false);
    const packId = `atomic-pack-${randomUUID()}`;
    insertFeedbackPack({
      packId,
      producerRunId,
      repositoryRowId: receipt.repository.repository_row_id,
    });
    const payload = feedback({ packId, producerRunId });
    const first = appendMemoryFeedback({
      orgId: context.orgA.id,
      projectId: context.projectA,
      repository: receipt.repository,
      feedback: payload,
      now: NOW,
    });
    expect(count("SELECT COUNT(*) AS count FROM memory_v2_feedback_facets WHERE feedback_id = ?", first.feedback_id)).toBe(1);
    expect(count("SELECT COUNT(*) AS count FROM memory_review_signals WHERE feedback_id = ?", first.feedback_id)).toBe(1);
    const outboxAfterFirst = count("SELECT COUNT(*) AS count FROM memory_outbox");
    const replay = appendMemoryFeedback({
      orgId: context.orgA.id,
      projectId: context.projectA,
      repository: receipt.repository,
      feedback: payload,
      now: NOW,
    });
    expect(replay.feedback_id).toBe(first.feedback_id);
    expect(count("SELECT COUNT(*) AS count FROM memory_outbox")).toBe(outboxAfterFirst);

    const failingRunId = `atomic-feedback-failure-${randomUUID()}`;
    const failingReceipt = acceptCodeReceipt(failingRunId, false);
    const failingPackId = `atomic-pack-${randomUUID()}`;
    insertFeedbackPack({
      packId: failingPackId,
      producerRunId: failingRunId,
      repositoryRowId: failingReceipt.repository.repository_row_id,
    });
    const failingPayload = feedback({ packId: failingPackId, producerRunId: failingRunId });
    const feedbackBefore = count("SELECT COUNT(*) AS count FROM memory_feedback");
    const signalsBefore = count("SELECT COUNT(*) AS count FROM memory_review_signals");
    const outboxBefore = count("SELECT COUNT(*) AS count FROM memory_outbox");
    withFailingFacetInsert("memory_v2_feedback_facets", () => {
      expect(() => appendMemoryFeedback({
        orgId: context.orgA.id,
        projectId: context.projectA,
        repository: failingReceipt.repository,
        feedback: failingPayload,
        now: NOW,
      })).toThrow("injected v2 companion failure");
    });
    expect(count("SELECT COUNT(*) AS count FROM memory_feedback")).toBe(feedbackBefore);
    expect(count("SELECT COUNT(*) AS count FROM memory_review_signals")).toBe(signalsBefore);
    expect(count("SELECT COUNT(*) AS count FROM memory_outbox")).toBe(outboxBefore);
  });
});
