import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONTRACT_FIXTURES,
  canonicalJsonSha256,
  parseMemoryContract,
  type MemoryPromptPolicyUpdateV1,
  type MemoryReleaseGateEvaluationV1,
  type MemorySearchV1,
} from "@pim/shared";
import { PimMemoryClient } from "../../../../sdk/src/memory-client.js";
import { importActiveMemoryRecord } from "../../services/memory-records.js";
import { resolveMemoryRepository } from "../../services/memory-repository-registry.js";
import { createMemoryTestContext, type MemoryTestContext } from "./memory-test-app.js";

const REPOSITORY_ID = "github.com/acme/checkout";
const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

let context: MemoryTestContext;
let searchClient: PimMemoryClient;
let adminClient: PimMemoryClient;
let previousGlobalFlag: string | undefined;

function policyUpdate(
  expectedRevision: number,
  killSwitch: boolean,
): MemoryPromptPolicyUpdateV1 {
  return parseMemoryContract("MemoryPromptPolicyUpdateV1", {
    schema_version: "pim.memory-prompt-policy-update.v1",
    expected_revision: expectedRevision,
    enabled: true,
    kill_switch: killSwitch,
    automatic_activation_enabled: false,
    canary_percentage: 100,
    allowed_repository_ids: [REPOSITORY_ID],
    allowed_kinds: ["constraint"],
    max_prompt_items: 1,
    max_prompt_tokens: 1200,
  });
}

function passingPreCanaryEvaluation(marker: string): MemoryReleaseGateEvaluationV1 {
  const fixture = structuredClone(
    MEMORY_CONTRACT_FIXTURES.MemoryReleaseGateEvaluationV1,
  ) as unknown as MemoryReleaseGateEvaluationV1;
  return parseMemoryContract("MemoryReleaseGateEvaluationV1", {
    ...fixture,
    stage: "pre_canary",
    dataset_digest: canonicalJsonSha256({ fixture: "prompt-kill-switch-live", marker }),
  });
}

function searchRequest(input: {
  marker: string;
  requestId: string;
  consumerRunId: string;
  path: string;
  symbol: string;
}): MemorySearchV1 {
  const fixture = structuredClone(
    MEMORY_CONTRACT_FIXTURES.MemorySearchV1,
  ) as unknown as MemorySearchV1;
  return parseMemoryContract("MemorySearchV1", {
    ...fixture,
    request_id: input.requestId,
    consumer: { ...fixture.consumer, consumer_run_id: input.consumerRunId },
    tenant: { project_id: context.projectA },
    applicability: {
      repository_id: REPOSITORY_ID,
      base_sha: BASE_SHA,
      paths: [input.path],
      symbols: [input.symbol],
      task_classes: ["bug_fix"],
    },
    task: {
      query: `live prompt kill switch ${input.marker}`,
      task_class: "bug_fix",
    },
  });
}

beforeAll(async () => {
  previousGlobalFlag = process.env.PIM_MEMORY_PROMPT_EXPOSURE_ENABLED;
  process.env.PIM_MEMORY_PROMPT_EXPOSURE_ENABLED = "1";
  context = await createMemoryTestContext();
  const baseUrl = await context.app.listen({ host: "127.0.0.1", port: 0 });
  searchClient = new PimMemoryClient({ baseUrl, authToken: context.tokenA });
  adminClient = new PimMemoryClient({ baseUrl, authToken: context.adminTokenA });
});

afterAll(async () => {
  if (previousGlobalFlag === undefined) delete process.env.PIM_MEMORY_PROMPT_EXPOSURE_ENABLED;
  else process.env.PIM_MEMORY_PROMPT_EXPOSURE_ENABLED = previousGlobalFlag;
  if (context) await context.app.close();
});

describe("live SDK prompt canary kill switch", () => {
  it("stops new prompt exposure without interrupting shadow search", async () => {
    const marker = randomUUID();
    const path = `src/prompt-live/${marker}.ts`;
    const symbol = `prompt_live_${marker.replaceAll("-", "_")}`;
    const repository = resolveMemoryRepository(
      context.orgA.id,
      context.projectA,
      REPOSITORY_ID,
    )!;
    const imported = importActiveMemoryRecord({
      orgId: context.orgA.id,
      projectId: context.projectA,
      repositoryRowId: repository.repository_row_id,
      kind: "constraint",
      content: {
        summary: `Live prompt kill switch ${marker}.`,
        details: `The ${marker} fixture must remain available to shadow retrieval after prompt exposure is killed.`,
        rationale: "The project kill switch controls exposure, not Fiesta execution or durable recall.",
      },
      applicability: {
        repository_id: REPOSITORY_ID,
        paths: [path],
        symbols: [symbol],
        task_classes: ["bug_fix"],
      },
      exceptions: [],
      compatibility: {
        harness_version_range: "*",
        workflow_version_range: "*",
        adapter_version_range: "*",
      },
      validation: { strategy: "repository_anchors" },
      evidence: [{
        evidence_ref_id: `prompt-live-review-${marker}`,
        type: "failure",
        digest: canonicalJsonSha256({ fixture: "reviewed-prompt-record", marker }),
        origin_id: `prompt-live:${marker}`,
        source_authority: "authorized_review",
      }],
      evidenceSummary: { strength: "reviewed", ref_count: 1 },
      freshness: { last_confirmed_at: new Date().toISOString(), expires_at: null },
      provenance: { producer: "prompt-policy-live-test", extractor_version: "test-v1" },
      promptEligible: true,
    });

    const gate = await adminClient.evaluateReleaseGates(
      context.projectA,
      passingPreCanaryEvaluation(marker),
    );
    expect(gate).toMatchObject({
      project_id: context.projectA,
      stage: "pre_canary",
      status: "pass",
      decision: "continue",
    });

    const enabled = await adminClient.updatePromptPolicy(
      context.projectA,
      policyUpdate(0, false),
    );
    expect(enabled).toMatchObject({
      policy_revision: 1,
      global_enabled: true,
      effective_enabled: true,
      kill_switch: false,
    });
    await expect(adminClient.getPromptPolicy(context.projectA)).resolves.toEqual(enabled);

    const exposed = await searchClient.search(searchRequest({
      marker,
      path,
      symbol,
      requestId: `prompt-live-on-${marker}`,
      consumerRunId: `fiesta:test:prompt-live-on:${marker}`,
    }));
    expect(exposed).toMatchObject({ evaluation_arm: "memory_on", prompt_eligible: true });
    expect(exposed.items.find((item) => item.record_id === imported.record_id)).toMatchObject({
      prompt_eligible: true,
    });
    expect(exposed.items.filter((item) => item.prompt_eligible)).toHaveLength(1);

    const killed = await adminClient.updatePromptPolicy(
      context.projectA,
      policyUpdate(1, true),
    );
    expect(killed).toMatchObject({
      policy_revision: 2,
      effective_enabled: false,
      kill_switch: true,
    });

    const shadow = await searchClient.search(searchRequest({
      marker,
      path,
      symbol,
      requestId: `prompt-live-killed-${marker}`,
      consumerRunId: `fiesta:test:prompt-live-killed:${marker}`,
    }));
    expect(shadow).toMatchObject({ evaluation_arm: "shadow", prompt_eligible: false });
    expect(shadow.items.map((item) => item.record_id)).toContain(imported.record_id);
    expect(shadow.items.every((item) => item.prompt_eligible === false)).toBe(true);
  });
});
