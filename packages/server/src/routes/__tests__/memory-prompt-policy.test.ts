import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONTRACT_FIXTURES,
  parseMemoryContract,
  type MemoryPromptPolicyUpdateV1,
  type MemorySearchV1,
} from "@pim/shared";
import db from "../../db/connection.js";
import { importActiveMemoryRecord } from "../../services/memory-records.js";
import {
  getMemoryPromptPolicy,
  memoryPromptBucket,
} from "../../services/memory-prompt-policy.js";
import { resolveMemoryRepository } from "../../services/memory-repository-registry.js";
import { executeMemorySearch } from "../../services/memory-search.js";
import { createMemoryTestContext, type MemoryTestContext } from "./memory-test-app.js";

let context: MemoryTestContext;
let requestCounter = 0;
const originalGlobalFlag = process.env.PIM_MEMORY_PROMPT_EXPOSURE_ENABLED;

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function searchRequest(consumerRunId: string): MemorySearchV1 {
  const fixture = structuredClone(MEMORY_CONTRACT_FIXTURES.MemorySearchV1) as unknown as MemorySearchV1;
  return {
    ...fixture,
    request_id: `prompt-policy-search-${++requestCounter}`,
    consumer: { ...fixture.consumer, consumer_run_id: consumerRunId },
    tenant: { project_id: context.projectA },
  };
}

function policyUpdate(
  expectedRevision: number,
  overrides: Partial<MemoryPromptPolicyUpdateV1> = {},
): MemoryPromptPolicyUpdateV1 {
  return {
    schema_version: "pim.memory-prompt-policy-update.v1",
    expected_revision: expectedRevision,
    enabled: true,
    kill_switch: false,
    automatic_activation_enabled: false,
    canary_percentage: 100,
    allowed_repository_ids: ["github.com/acme/checkout"],
    allowed_kinds: ["constraint"],
    max_prompt_items: 1,
    max_prompt_tokens: 1200,
    ...overrides,
  };
}

beforeAll(async () => {
  delete process.env.PIM_MEMORY_PROMPT_EXPOSURE_ENABLED;
  context = await createMemoryTestContext();
  const repository = resolveMemoryRepository(
    context.orgA.id,
    context.projectA,
    "github.com/acme/checkout",
  )!;
  for (const marker of ["first", "second"] as const) {
    importActiveMemoryRecord({
      orgId: context.orgA.id,
      projectId: context.projectA,
      repositoryRowId: repository.repository_row_id,
      kind: "constraint",
      content: {
        summary: `Payment retry prompt canary ${marker} constraint.`,
        details: `The ${marker} checkout canary record requires retryCharge to preserve its provider idempotency key.`,
        rationale: "This reviewed fixture exercises bounded prompt exposure.",
      },
      applicability: {
        repository_id: repository.repository_id,
        components: ["payments"],
        paths: ["src/payments/retry.ts"],
        symbols: ["retryCharge"],
        task_classes: ["bug_fix"],
      },
      exceptions: [],
      compatibility: { harness_version_range: "*", workflow_version_range: "*", adapter_version_range: "*" },
      validation: { strategy: "repository_anchors" },
      evidence: [{
        evidence_ref_id: `prompt-canary-${marker}`,
        type: "failure",
        digest: `sha256:${(marker === "first" ? "a" : "b").repeat(64)}`,
        origin_id: `prompt-canary:${marker}`,
        source_authority: "authorized_review",
      }],
      evidenceSummary: { strength: "reviewed", ref_count: 1 },
      freshness: { last_confirmed_at: new Date().toISOString(), expires_at: null },
      provenance: { producer: "prompt-policy-test", extractor_version: "test-v1" },
      promptEligible: true,
    });
  }
});

afterAll(async () => {
  if (originalGlobalFlag === undefined) delete process.env.PIM_MEMORY_PROMPT_EXPOSURE_ENABLED;
  else process.env.PIM_MEMORY_PROMPT_EXPOSURE_ENABLED = originalGlobalFlag;
  if (context) await context.app.close();
});

describe("Slice 5 prompt policy and canary exposure", () => {
  it("uses insertion order when gate decisions share a timestamp", async () => {
    process.env.PIM_MEMORY_PROMPT_EXPOSURE_ENABLED = "1";
    try {
      const configured = await context.app.inject({
        method: "PUT",
        url: `/api/v1/memory/projects/${context.projectB}/prompt-policy`,
        headers: auth(context.adminTokenB),
        payload: policyUpdate(0),
      });
      expect(configured.statusCode).toBe(200);

      const timestamp = "2026-08-03T19:00:00.000Z";
      const insertDecision = db.prepare(
        `INSERT INTO memory_release_gate_decisions
           (decision_id, org_id, project_id, stage, decision, status,
            metric_snapshot_json, dataset_digest, reasons_json, created_at)
         VALUES (?, ?, ?, 'pre_canary', ?, ?, '{}', ?, ?, ?)`,
      );
      insertDecision.run(
        `same-time-z-pass-${context.projectB}`,
        context.orgB.id,
        context.projectB,
        "continue",
        "pass",
        `sha256:${"a".repeat(64)}`,
        "[]",
        timestamp,
      );
      expect(getMemoryPromptPolicy(context.orgB.id, context.projectB).effective_enabled).toBe(true);

      insertDecision.run(
        `same-time-a-fail-${context.projectB}`,
        context.orgB.id,
        context.projectB,
        "pause",
        "fail",
        `sha256:${"b".repeat(64)}`,
        '["safety_regressed"]',
        timestamp,
      );
      expect(getMemoryPromptPolicy(context.orgB.id, context.projectB).effective_enabled).toBe(false);
    } finally {
      delete process.env.PIM_MEMORY_PROMPT_EXPOSURE_ENABLED;
    }
  });

  it("is fail-closed and enforces memory:admin plus exact project binding", async () => {
    const response = await context.app.inject({
      method: "GET",
      url: `/api/v1/memory/projects/${context.projectA}/prompt-policy`,
      headers: auth(context.adminTokenA),
    });
    expect(response.statusCode).toBe(200);
    expect(parseMemoryContract("MemoryPromptPolicyV1", response.json())).toMatchObject({
      policy_revision: 0,
      enabled: false,
      kill_switch: true,
      automatic_activation_enabled: false,
      global_enabled: false,
      effective_enabled: false,
    });

    const wrongScope = await context.app.inject({
      method: "GET",
      url: `/api/v1/memory/projects/${context.projectA}/prompt-policy`,
      headers: auth(context.tokenA),
    });
    expect(wrongScope.statusCode).toBe(403);

    const wrongProject = await context.app.inject({
      method: "GET",
      url: `/api/v1/memory/projects/${context.projectA}/prompt-policy`,
      headers: auth(context.adminTokenB),
    });
    expect(wrongProject.statusCode).toBe(403);

    const unknownField = await context.app.inject({
      method: "PUT",
      url: `/api/v1/memory/projects/${context.projectA}/prompt-policy`,
      headers: auth(context.adminTokenA),
      payload: { ...policyUpdate(0), widened_repository_match: true },
    });
    expect(unknownField.statusCode).toBe(400);
    expect(unknownField.json()).toMatchObject({ code: "schema_invalid" });

    const unboundRepository = await context.app.inject({
      method: "PUT",
      url: `/api/v1/memory/projects/${context.projectA}/prompt-policy`,
      headers: auth(context.adminTokenA),
      payload: policyUpdate(0, { allowed_repository_ids: ["github.com/acme/not-bound"] }),
    });
    expect(unboundRepository.statusCode).toBe(403);
    expect(unboundRepository.json()).toMatchObject({ code: "resource_binding_mismatch" });
  });

  it("preserves shadow results, caps prompt items, snapshots policy, and stops new exposure on kill", async () => {
    const blockedAutomatic = await context.app.inject({
      method: "PUT",
      url: `/api/v1/memory/projects/${context.projectA}/prompt-policy`,
      headers: auth(context.adminTokenA),
      payload: policyUpdate(0, { automatic_activation_enabled: true }),
    });
    expect(blockedAutomatic.statusCode).toBe(409);
    expect(blockedAutomatic.json()).toMatchObject({ code: "activation_requirement_unsatisfied" });

    const configured = await context.app.inject({
      method: "PUT",
      url: `/api/v1/memory/projects/${context.projectA}/prompt-policy`,
      headers: auth(context.adminTokenA),
      payload: policyUpdate(0),
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toMatchObject({ policy_revision: 1, effective_enabled: false });

    const globalOff = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/search",
      headers: auth(context.tokenA),
      payload: searchRequest("prompt-global-off"),
    });
    expect(globalOff.statusCode).toBe(200);
    expect(globalOff.json()).toMatchObject({ evaluation_arm: "shadow", prompt_eligible: false });
    expect(globalOff.json().items.length).toBeGreaterThan(0);
    expect(globalOff.json().items.every((item: { prompt_eligible: boolean }) => !item.prompt_eligible)).toBe(true);

    process.env.PIM_MEMORY_PROMPT_EXPOSURE_ENABLED = "1";
    const noSafetyGate = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/search",
      headers: auth(context.tokenA),
      payload: searchRequest("prompt-no-safety-gate"),
    });
    expect(noSafetyGate.statusCode).toBe(200);
    expect(noSafetyGate.json()).toMatchObject({ evaluation_arm: "shadow", prompt_eligible: false });

    db.prepare(
      `INSERT INTO memory_release_gate_decisions
         (decision_id, org_id, project_id, stage, decision, status,
          metric_snapshot_json, dataset_digest, reasons_json, created_at)
       VALUES (?, ?, ?, 'pre_canary', 'continue', 'pass', '{}', ?, '[]', ?)`,
    ).run(
      `pre-canary-pass-${context.projectA}`,
      context.orgA.id,
      context.projectA,
      `sha256:${"c".repeat(64)}`,
      "2026-08-03T20:00:00.000Z",
    );
    const exposed = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/search",
      headers: auth(context.tokenA),
      payload: searchRequest("prompt-memory-on"),
    });
    expect(exposed.statusCode).toBe(200);
    const exposedBody = parseMemoryContract("MemorySearchResultV1", exposed.json());
    expect(exposedBody.evaluation_arm).toBe("memory_on");
    expect(exposedBody.prompt_eligible).toBe(true);
    expect(exposedBody.items.length).toBeGreaterThan(1);
    expect(exposedBody.items.filter((item) => item.prompt_eligible)).toHaveLength(1);

    const stored = db.prepare(
      `SELECT prompt_eligible, evaluation_arm, prompt_policy_revision,
              prompt_policy_snapshot_json, prompt_item_count, prompt_token_count,
              response_json
       FROM memory_retrieval_packs WHERE retrieval_pack_id = ?`,
    ).get(exposedBody.retrieval_pack_id) as {
      prompt_eligible: number;
      evaluation_arm: string;
      prompt_policy_revision: number;
      prompt_policy_snapshot_json: string;
      prompt_item_count: number;
      prompt_token_count: number;
      response_json: string;
    };
    expect(stored).toMatchObject({
      prompt_eligible: 1,
      evaluation_arm: "memory_on",
      prompt_policy_revision: 1,
      prompt_item_count: 1,
    });
    expect(stored.prompt_token_count).toBeGreaterThan(0);
    expect(JSON.parse(stored.prompt_policy_snapshot_json)).toMatchObject({
      evaluation_arm: "memory_on",
      policy: { project_id: context.projectA, policy_revision: 1, max_prompt_items: 1 },
    });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM memory_retrieval_pack_items WHERE retrieval_pack_id = ? AND prompt_eligible = 1",
    ).get(exposedBody.retrieval_pack_id)).toEqual({ count: 1 });

    const killed = await context.app.inject({
      method: "PUT",
      url: `/api/v1/memory/projects/${context.projectA}/prompt-policy`,
      headers: auth(context.adminTokenA),
      payload: policyUpdate(1, { kill_switch: true }),
    });
    expect(killed.statusCode).toBe(200);
    expect(killed.json()).toMatchObject({ policy_revision: 2, effective_enabled: false });

    const afterKill = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/search",
      headers: auth(context.tokenA),
      payload: searchRequest("prompt-after-kill"),
    });
    expect(afterKill.statusCode).toBe(200);
    expect(afterKill.json()).toMatchObject({ evaluation_arm: "shadow", prompt_eligible: false });
    expect(afterKill.json().items).toHaveLength(exposedBody.items.length);
    expect(afterKill.json().items.every((item: { prompt_eligible: boolean }) => !item.prompt_eligible)).toBe(true);
    expect(JSON.parse(stored.response_json)).toEqual(exposedBody);

    const staleRevision = await context.app.inject({
      method: "PUT",
      url: `/api/v1/memory/projects/${context.projectA}/prompt-policy`,
      headers: auth(context.adminTokenA),
      payload: policyUpdate(1),
    });
    expect(staleRevision.statusCode).toBe(409);
    expect(staleRevision.json()).toMatchObject({ code: "idempotency_conflict" });
  });

  it("uses exact repository/kind allowlists and revision-scoped sticky arms", async () => {
    const wrongKind = await context.app.inject({
      method: "PUT",
      url: `/api/v1/memory/projects/${context.projectA}/prompt-policy`,
      headers: auth(context.adminTokenA),
      payload: policyUpdate(2, { allowed_kinds: ["anti_pattern"] }),
    });
    expect(wrongKind.statusCode).toBe(200);
    const wrongKindSearch = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/search",
      headers: auth(context.tokenA),
      payload: searchRequest("prompt-wrong-kind"),
    });
    expect(wrongKindSearch.statusCode).toBe(200);
    expect(wrongKindSearch.json()).toMatchObject({ evaluation_arm: "memory_on", prompt_eligible: false });

    const wrongRepository = await context.app.inject({
      method: "PUT",
      url: `/api/v1/memory/projects/${context.projectA}/prompt-policy`,
      headers: auth(context.adminTokenA),
      payload: policyUpdate(3, { allowed_repository_ids: ["github.com/acme/empty"] }),
    });
    expect(wrongRepository.statusCode).toBe(200);
    const wrongRepositorySearch = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/search",
      headers: auth(context.tokenA),
      payload: searchRequest("prompt-wrong-repository"),
    });
    expect(wrongRepositorySearch.statusCode).toBe(200);
    expect(wrongRepositorySearch.json()).toMatchObject({ evaluation_arm: "shadow", prompt_eligible: false });

    const memoryOff = await context.app.inject({
      method: "PUT",
      url: `/api/v1/memory/projects/${context.projectA}/prompt-policy`,
      headers: auth(context.adminTokenA),
      payload: policyUpdate(4, { canary_percentage: 0 }),
    });
    expect(memoryOff.statusCode).toBe(200);
    const memoryOffSearch = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/search",
      headers: auth(context.tokenA),
      payload: searchRequest("prompt-memory-off"),
    });
    expect(memoryOffSearch.statusCode).toBe(200);
    expect(memoryOffSearch.json()).toMatchObject({ evaluation_arm: "memory_off", prompt_eligible: false });

    const restoredCanary = await context.app.inject({
      method: "PUT",
      url: `/api/v1/memory/projects/${context.projectA}/prompt-policy`,
      headers: auth(context.adminTokenA),
      payload: policyUpdate(5),
    });
    expect(restoredCanary.statusCode).toBe(200);
    db.prepare(
      `INSERT INTO memory_release_gate_decisions
         (decision_id, org_id, project_id, stage, decision, status,
          metric_snapshot_json, dataset_digest, reasons_json, created_at)
       VALUES (?, ?, ?, 'pre_canary', 'pause', 'fail', '{}', ?, '["safety_regressed"]', ?)`,
    ).run(
      `pre-canary-pause-${context.projectA}`,
      context.orgA.id,
      context.projectA,
      `sha256:${"d".repeat(64)}`,
      "2026-08-03T21:00:00.000Z",
    );
    const afterGatePause = await context.app.inject({
      method: "POST",
      url: "/api/v1/memory/search",
      headers: auth(context.tokenA),
      payload: searchRequest("prompt-after-gate-pause"),
    });
    expect(afterGatePause.statusCode).toBe(200);
    expect(afterGatePause.json()).toMatchObject({ evaluation_arm: "shadow", prompt_eligible: false });

    expect(memoryPromptBucket(context.projectA, 6, "sticky-run")).toBe(
      memoryPromptBucket(context.projectA, 6, "sticky-run"),
    );
    expect(Array.from({ length: 100 }, (_, index) => `run-${index}`).some((consumerRunId) =>
      memoryPromptBucket(context.projectA, 6, consumerRunId)
      !== memoryPromptBucket(context.projectA, 7, consumerRunId))).toBe(true);
  });

  it("reads a kill changed during async scoring before committing the pack", async () => {
    const repository = resolveMemoryRepository(
      context.orgA.id,
      context.projectA,
      "github.com/acme/checkout",
    )!;
    importActiveMemoryRecord({
      orgId: context.orgA.id,
      projectId: context.projectA,
      repositoryRowId: repository.repository_row_id,
      kind: "constraint",
      content: {
        summary: "Async scoring prompt policy serialization constraint.",
        details: "The pack must read the kill state after asynchronous embedding work and before its immutable commit.",
        rationale: "This closes the stale pre-transaction policy-read window.",
      },
      applicability: {
        repository_id: repository.repository_id,
        paths: ["src/payments/retry.ts"],
        symbols: ["retryCharge"],
        task_classes: ["bug_fix"],
      },
      exceptions: [],
      compatibility: { harness_version_range: "*", workflow_version_range: "*", adapter_version_range: "*" },
      validation: { strategy: "repository_anchors" },
      evidence: [{
        evidence_ref_id: "prompt-policy-async-scoring",
        type: "failure",
        digest: `sha256:${"e".repeat(64)}`,
        origin_id: "prompt-policy:async-scoring",
        source_authority: "authorized_review",
      }],
      evidenceSummary: { strength: "reviewed", ref_count: 1 },
      freshness: { last_confirmed_at: new Date().toISOString(), expires_at: null },
      provenance: { producer: "prompt-policy-test", extractor_version: "test-v1" },
      promptEligible: true,
      embedding: [1, 0],
    });
    db.prepare(
      `INSERT INTO memory_release_gate_decisions
         (decision_id, org_id, project_id, stage, decision, status,
          metric_snapshot_json, dataset_digest, reasons_json, created_at)
       VALUES (?, ?, ?, 'pre_canary', 'continue', 'pass', '{}', ?, '[]', ?)`,
    ).run(
      `pre-canary-resume-${context.projectA}`,
      context.orgA.id,
      context.projectA,
      `sha256:${"f".repeat(64)}`,
      "2026-08-03T22:00:00.000Z",
    );

    let markEmbeddingStarted!: () => void;
    const embeddingStarted = new Promise<void>((resolve) => { markEmbeddingStarted = resolve; });
    let releaseEmbedding!: () => void;
    const embeddingRelease = new Promise<void>((resolve) => { releaseEmbedding = resolve; });
    const pendingSearch = executeMemorySearch({
      orgId: context.orgA.id,
      principalId: "prompt-policy-concurrency-test",
      repository,
      request: searchRequest("prompt-concurrent-kill"),
    }, {
      generateQueryEmbedding: async () => {
        markEmbeddingStarted();
        await embeddingRelease;
        return [1, 0];
      },
    });
    await embeddingStarted;

    const killed = await context.app.inject({
      method: "PUT",
      url: `/api/v1/memory/projects/${context.projectA}/prompt-policy`,
      headers: auth(context.adminTokenA),
      payload: policyUpdate(6, { kill_switch: true }),
    });
    expect(killed.statusCode).toBe(200);
    releaseEmbedding();

    const result = await pendingSearch;
    expect(result).toMatchObject({ evaluation_arm: "shadow", prompt_eligible: false });
    expect(result.items.every((item) => !item.prompt_eligible)).toBe(true);
    expect(db.prepare(
      `SELECT prompt_policy_revision, evaluation_arm
       FROM memory_retrieval_packs WHERE retrieval_pack_id = ?`,
    ).get(result.retrieval_pack_id)).toEqual({
      prompt_policy_revision: 7,
      evaluation_arm: "shadow",
    });
  });
});
