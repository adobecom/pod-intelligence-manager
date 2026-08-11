import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONTRACT_FIXTURES,
  canonicalJsonSha256,
  parseMemoryContract,
  type CodeEvidenceManifestV2,
  type MemoryCandidateDecisionResultV1,
  type MemoryCandidateDecisionV1,
  type MemoryCandidateV1,
  type MemorySearchV1,
  type RunReceiptResultV1,
  type RunReceiptV1,
} from "@pim/shared";
import db from "../../db/connection.js";
import { createMemoryTestContext, type MemoryTestContext } from "./memory-test-app.js";

const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const TREE_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const REPOSITORY_ID = "github.com/acme/checkout";
const EVENT_TIME = "2025-08-03T20:00:00.000Z";

type CandidateVariant = "valid_anti_pattern" | "missing_failure" | "invalid_structure" | "positive";

interface CandidateFixture {
  candidateId: string;
  candidate: MemoryCandidateV1;
  evidenceRefId: string;
  expectedStatus: "pending_review" | "pending_merge" | "rejected";
}

let context: MemoryTestContext;

function uniqueId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function createCandidate(variant: CandidateVariant): Promise<CandidateFixture> {
  const suffix = randomUUID();
  const marker = suffix.replaceAll("-", "_");
  const producerRunId = `fiesta:test:decision:${suffix}`;
  const evidenceRefId = `decision-evidence-${suffix}`;
  const antiPattern = variant !== "positive";
  const evidenceType = variant === "missing_failure" ? "git_diff" : antiPattern ? "failure" : "git_diff";
  const manifestBody: Omit<CodeEvidenceManifestV2, "digest"> = {
    schema_version: "pim.memory-code-evidence.v2",
    manifest_id: `decision-manifest-${suffix}`,
    refs: [{
      id: evidenceRefId,
      type: evidenceType,
      uri: `https://github.com/acme/checkout/commit/${TREE_SHA}.diff`,
      digest: canonicalJsonSha256({ variant, suffix }),
      origin_id: `${REPOSITORY_ID}:${TREE_SHA}:${evidenceRefId}`,
      occurred_at: EVENT_TIME,
      source_authority: "observed",
    }],
  };
  const manifest = parseMemoryContract("CodeEvidenceManifestV2", {
    ...manifestBody,
    digest: canonicalJsonSha256(manifestBody),
  });
  const candidate = parseMemoryContract("MemoryCandidateV1", {
    schema_version: "pim.memory-candidate.v1",
    client_candidate_id: `decision-candidate-${suffix}`,
    plane: "codebase",
    kind: antiPattern ? "anti_pattern" : "constraint",
    content: {
      summary: `${antiPattern ? "Avoid" : "Preserve"} the reviewed ${variant} invariant ${suffix}.`,
      details: `The ${variant} fixture ${suffix} preserves a bounded claim so reviewer authority cannot bypass structural or evidence policy.`,
      rationale: `This ${variant} fixture proves that review decisions remain subordinate to the canonical activation validator.`,
    },
    applicability: {
      repository_id: REPOSITORY_ID,
      base_sha: BASE_SHA,
      paths: [`src/review/${marker}.ts`],
      symbols: [`review_${marker}`],
      task_classes: ["bug_fix"],
    },
    validation: antiPattern
      ? {
          strategy: "stable_failure_fingerprint",
          failure_fingerprint: `review-failure-${suffix}`,
        }
      : { strategy: "repository_anchors" },
    exceptions: variant === "invalid_structure"
      ? []
      : [`Does not apply outside the exact ${marker} checkout path.`],
    source_run_ids: [producerRunId],
    evidence_refs: [evidenceRefId],
    extraction: {
      method: "model_then_deterministic_validation",
      extractor_version: "fiesta-candidate-extractor.decision-test-v1",
      confidence: 0.94,
    },
    activation_requirement_requested: antiPattern ? "authorized_review" : "verified_merge",
  }) as MemoryCandidateV1;
  const receipt = parseMemoryContract("RunReceiptV1", {
    schema_version: "pim.run-receipt.v1",
    external_session_id: `fiesta-review-thread-${suffix}`,
    producer: {
      harness_id: "fiesta",
      harness_version: "decision-test",
      workflow_version: "code-change.v3",
      adapter_version: "fiesta-pim-adapter.v1",
    },
    tenant: { project_id: context.projectA },
    repository: {
      repository_id: REPOSITORY_ID,
      display_slug: "Acme/Checkout",
      base_sha: BASE_SHA,
      candidate_tree_sha: TREE_SHA,
      provider_pull_request_id: `github:acme/checkout#${suffix}`,
      pr_head_sha: TREE_SHA,
      pull_request_url: `https://github.com/acme/checkout/pull/${suffix}`,
    },
    task: { task_class: "bug_fix", summary: `Review candidate policy fixture ${suffix}.` },
    outcome: {
      status: "completed",
      terminal_stage: "close",
      reason_code: "completed",
      verification_status: "passed",
      publication_status: "pr_open",
      gate_attestation_ids: [],
      failure_fingerprint: antiPattern ? `review-failure-${suffix}` : null,
    },
    retrieval_feedback: [],
    evidence_manifest: manifest,
    candidates: [candidate],
  }) as RunReceiptV1;
  const response = await context.app.inject({
    method: "PUT",
    url: `/api/v1/memory/run-receipts/${encodeURIComponent(producerRunId)}`,
    headers: {
      ...auth(context.receiptTokenA),
      "idempotency-key": `decision-receipt-${producerRunId}`,
    },
    payload: receipt,
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = parseMemoryContract("RunReceiptResultV1", response.json()) as RunReceiptResultV1;
  const expectedStatus = variant === "valid_anti_pattern"
    ? "pending_review"
    : variant === "positive"
      ? "pending_merge"
      : "rejected";
  expect(result.candidate_results[0]).toMatchObject({
    client_candidate_id: candidate.client_candidate_id,
    status: expectedStatus,
  });
  return {
    candidateId: result.candidate_results[0]!.candidate_id,
    candidate,
    evidenceRefId,
    expectedStatus,
  };
}

function decisionFor(
  fixture: CandidateFixture,
  overrides: Partial<MemoryCandidateDecisionV1> = {},
): MemoryCandidateDecisionV1 {
  return parseMemoryContract("MemoryCandidateDecisionV1", {
    schema_version: "pim.memory-candidate-decision.v1",
    decision_revision: 1,
    decision: "approve",
    reason_code: "authorized_failure_evidence_reviewed",
    explanation: "The bounded failure evidence and stated exception were reviewed for this exact repository claim.",
    evidence_refs: [fixture.evidenceRefId],
    event_time: EVENT_TIME,
    ...overrides,
  });
}

async function postDecision(
  fixture: CandidateFixture,
  body: MemoryCandidateDecisionV1,
  token = context.reviewerTokenA,
) {
  return context.app.inject({
    method: "POST",
    url: `/api/v1/memory/candidates/${encodeURIComponent(fixture.candidateId)}/decisions`,
    headers: auth(token),
    payload: body,
  });
}

async function searchFor(fixture: CandidateFixture): Promise<string[]> {
  const request = structuredClone(
    MEMORY_CONTRACT_FIXTURES.MemorySearchV1,
  ) as unknown as MemorySearchV1;
  request.request_id = uniqueId("decision-search");
  request.consumer = {
    ...request.consumer,
    harness_version: "decision-test",
    workflow_version: "code-change.v3",
    adapter_version: "fiesta-pim-adapter.v1",
    consumer_run_id: uniqueId("decision-consumer"),
  };
  request.tenant = { project_id: context.projectA };
  request.applicability = fixture.candidate.applicability;
  request.task = {
    query: fixture.candidate.content.summary,
    task_class: "bug_fix",
  };
  request.temporal = { mode: "current" };
  const response = await context.app.inject({
    method: "POST",
    url: "/api/v1/memory/search",
    headers: auth(context.tokenA),
    payload: parseMemoryContract("MemorySearchV1", request),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().items.map((item: { record_id: string }) => item.record_id);
}

beforeAll(async () => {
  context = await createMemoryTestContext();
});

afterAll(async () => {
  if (context) await context.app.close();
});

describe("Slice 4 reviewed candidate decisions", () => {
  it("requires reviewer scope and returns a non-enumerating cross-tenant 404", async () => {
    const fixture = await createCandidate("valid_anti_pattern");
    const body = decisionFor(fixture);

    const wrongScope = await postDecision(fixture, body, context.receiptTokenA);
    expect(wrongScope.statusCode).toBe(403);
    expect(wrongScope.json()).toMatchObject({
      schema_version: "pim.error.v1",
      code: "resource_binding_mismatch",
    });

    const crossTenant = await postDecision(fixture, body, context.reviewerTokenB);
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json()).toMatchObject({
      schema_version: "pim.error.v1",
      code: "resource_not_found",
    });
    expect(crossTenant.body).not.toContain(fixture.candidate.content.summary);
    expect(crossTenant.body).not.toContain(context.orgA.id);
    expect((db.prepare(
      "SELECT COUNT(*) AS count FROM memory_candidate_decisions WHERE candidate_id = ?",
    ).get(fixture.candidateId) as { count: number }).count).toBe(0);
    expect(db.prepare(
      "SELECT current_status FROM memory_candidates_v1 WHERE candidate_id = ?",
    ).get(fixture.candidateId)).toEqual({ current_status: "pending_review" });
  });

  it("keeps rejection append-only, replays it stably, and rejects a changed revision body", async () => {
    const fixture = await createCandidate("valid_anti_pattern");
    const body = decisionFor(fixture, {
      decision: "reject",
      reason_code: "failure_scope_overgeneralized",
      explanation: "The failure is real but the proposed applicability is too broad for reuse.",
    });
    const first = await postDecision(fixture, body);
    const replay = await postDecision(fixture, body);
    expect(first.statusCode, first.body).toBe(200);
    expect(replay.statusCode, replay.body).toBe(200);
    const result = parseMemoryContract(
      "MemoryCandidateDecisionResultV1",
      first.json(),
    ) as MemoryCandidateDecisionResultV1;
    expect(result).toMatchObject({
      candidate_id: fixture.candidateId,
      decision_revision: 1,
      decision: "reject",
      candidate_status: "rejected",
      duplicate: false,
    });
    expect(replay.json()).toEqual(first.json());

    const changed = await postDecision(fixture, decisionFor(fixture, {
      decision: "reject",
      reason_code: "same_revision_changed_body",
      explanation: "This changed immutable decision body must conflict.",
    }));
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({
      schema_version: "pim.error.v1",
      code: "idempotency_conflict",
    });

    const row = db.prepare(
      `SELECT decision_id, reviewer_principal_id, decision_revision, decision,
              reason_code, decision_json
       FROM memory_candidate_decisions WHERE candidate_id = ?`,
    ).get(fixture.candidateId) as {
      decision_id: string;
      reviewer_principal_id: string;
      decision_revision: number;
      decision: string;
      reason_code: string;
      decision_json: string;
    } | undefined;
    expect(row).toMatchObject({
      decision_id: result.decision_id,
      decision_revision: 1,
      decision: "reject",
      reason_code: "failure_scope_overgeneralized",
    });
    expect(JSON.parse(row!.decision_json)).toEqual(body);
    expect(db.prepare(
      `SELECT from_status, to_status, actor_type, actor_id, reason_code,
              decision_refs_json
       FROM memory_transitions
       WHERE aggregate_type = 'candidate' AND aggregate_id = ?
       ORDER BY committed_at DESC, rowid DESC LIMIT 1`,
    ).get(fixture.candidateId)).toEqual({
      from_status: "pending_review",
      to_status: "rejected",
      actor_type: "reviewer",
      actor_id: row!.reviewer_principal_id,
      reason_code: "failure_scope_overgeneralized",
      decision_refs_json: JSON.stringify([result.decision_id]),
    });
    expect((db.prepare(
      "SELECT COUNT(*) AS count FROM memory_candidate_decisions WHERE candidate_id = ?",
    ).get(fixture.candidateId) as { count: number }).count).toBe(1);
    expect(db.prepare(
      `SELECT current_status, active_record_id, active_record_version, candidate_json
       FROM memory_candidates_v1 WHERE candidate_id = ?`,
    ).get(fixture.candidateId)).toEqual({
      current_status: "rejected",
      active_record_id: null,
      active_record_version: null,
      candidate_json: JSON.stringify(fixture.candidate),
    });
  });

  it("activates a valid reviewed anti-pattern without automatic reverification enrollment while disabled", async () => {
    const fixture = await createCandidate("valid_anti_pattern");
    const body = decisionFor(fixture);
    const first = await postDecision(fixture, body);
    const replay = await postDecision(fixture, body);
    expect(first.statusCode, first.body).toBe(200);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(first.json());
    const result = parseMemoryContract(
      "MemoryCandidateDecisionResultV1",
      first.json(),
    ) as MemoryCandidateDecisionResultV1;
    expect(result).toMatchObject({
      candidate_id: fixture.candidateId,
      decision: "approve",
      candidate_status: "active",
      active_record: { record_version: 1 },
      duplicate: false,
    });
    const recordId = result.active_record!.record_id;

    expect((db.prepare(
      `SELECT COUNT(*) AS count FROM memory_transitions
       WHERE aggregate_type = 'candidate' AND aggregate_id = ? AND to_status = 'active'`,
    ).get(fixture.candidateId) as { count: number }).count).toBe(1);
    expect((db.prepare(
      "SELECT COUNT(*) AS count FROM memory_records WHERE record_id = ?",
    ).get(recordId) as { count: number }).count).toBe(1);
    expect(db.prepare(
      `SELECT current_status, current_version, shadow_recall_eligible
       FROM memory_records WHERE record_id = ?`,
    ).get(recordId)).toEqual({
      current_status: "active",
      current_version: 1,
      shadow_recall_eligible: 1,
    });
    expect(db.prepare(
      `SELECT trust_status, trust_basis, cutover_decided_at, evidence_verified_at
       FROM memory_v2_record_trust
       WHERE record_id = ? AND record_version = 1`,
    ).get(recordId)).toEqual({
      trust_status: "trusted",
      trust_basis: "evidence_verified",
      cutover_decided_at: null,
      evidence_verified_at: EVENT_TIME,
    });
    expect((db.prepare(
      `SELECT COUNT(*) AS count FROM memory_v2_reverification_policies
       WHERE record_id = ? AND record_version = 1`,
    ).get(recordId) as { count: number }).count).toBe(0);
    expect((db.prepare(
      `SELECT COUNT(*) AS count FROM memory_v2_reverification_state
       WHERE record_id = ? AND record_version = 1`,
    ).get(recordId) as { count: number }).count).toBe(0);
    expect(db.prepare(
      `SELECT source_type, source_authority, source_identity, decision_id
       FROM memory_origins WHERE source_type = 'authorized_review'
         AND source_identity LIKE ?`,
    ).get(`%:${result.decision_id}`)).toMatchObject({
      source_type: "authorized_review",
      source_authority: "authorized_review",
      decision_id: result.decision_id,
    });
    expect(await searchFor(fixture)).toContain(recordId);
  });

  it("cannot review candidates missing failure proof, failing structure, or requiring merge", async () => {
    const cases: Array<[CandidateVariant, string]> = [
      ["missing_failure", "failure evidence"],
      ["invalid_structure", "structural validation"],
      ["positive", "verified merge"],
    ];
    for (const [variant, label] of cases) {
      const fixture = await createCandidate(variant);
      const response = await postDecision(fixture, decisionFor(fixture));
      expect(response.statusCode, label).toBe(409);
      expect(response.json(), label).toMatchObject({
        schema_version: "pim.error.v1",
        code: "activation_requirement_unsatisfied",
      });
      expect((db.prepare(
        "SELECT COUNT(*) AS count FROM memory_candidate_decisions WHERE candidate_id = ?",
      ).get(fixture.candidateId) as { count: number }).count).toBe(0);
      expect((db.prepare(
        "SELECT COUNT(*) AS count FROM memory_records WHERE record_id = ?",
      ).get(`mem_${fixture.candidateId.slice("candidate_".length)}`) as { count: number }).count).toBe(0);
      expect(db.prepare(
        `SELECT current_status, active_record_id, active_record_version
         FROM memory_candidates_v1 WHERE candidate_id = ?`,
      ).get(fixture.candidateId)).toMatchObject({
        current_status: fixture.expectedStatus,
        active_record_id: null,
        active_record_version: null,
      });
    }
  });

  it("rolls back the reviewed activation when reverification admission is misconfigured", async () => {
    const fixture = await createCandidate("valid_anti_pattern");
    const recordId = `mem_${fixture.candidateId.slice("candidate_".length)}`;
    const previousEnabled = process.env.MEMORY_V2_REVERIFICATION_ENABLED;
    const previous = process.env.MEMORY_V2_REVERIFICATION_POLICY_INTERVAL_SECONDS;
    process.env.MEMORY_V2_REVERIFICATION_ENABLED = "1";
    process.env.MEMORY_V2_REVERIFICATION_POLICY_INTERVAL_SECONDS = "invalid";
    try {
      const response = await postDecision(fixture, decisionFor(fixture));
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: "temporarily_unavailable" });
      expect((db.prepare(
        "SELECT COUNT(*) AS count FROM memory_candidate_decisions WHERE candidate_id = ?",
      ).get(fixture.candidateId) as { count: number }).count).toBe(0);
      expect((db.prepare(
        "SELECT COUNT(*) AS count FROM memory_records WHERE record_id = ?",
      ).get(recordId) as { count: number }).count).toBe(0);
      expect((db.prepare(
        "SELECT COUNT(*) AS count FROM memory_v2_reverification_policies WHERE record_id = ?",
      ).get(recordId) as { count: number }).count).toBe(0);
      expect(db.prepare(
        `SELECT current_status, active_record_id, active_record_version
         FROM memory_candidates_v1 WHERE candidate_id = ?`,
      ).get(fixture.candidateId)).toEqual({
        current_status: "pending_review",
        active_record_id: null,
        active_record_version: null,
      });
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.MEMORY_V2_REVERIFICATION_ENABLED;
      } else {
        process.env.MEMORY_V2_REVERIFICATION_ENABLED = previousEnabled;
      }
      if (previous === undefined) {
        delete process.env.MEMORY_V2_REVERIFICATION_POLICY_INTERVAL_SECONDS;
      } else {
        process.env.MEMORY_V2_REVERIFICATION_POLICY_INTERVAL_SECONDS = previous;
      }
    }
  });
});
