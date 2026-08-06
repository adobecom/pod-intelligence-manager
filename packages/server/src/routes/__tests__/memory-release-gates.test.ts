import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONTRACT_FIXTURES,
  parseMemoryContract,
  type MemoryReleaseGateEvaluationV1,
} from "@pim/shared";
import db from "../../db/connection.js";
import { createMemoryTestContext, type MemoryTestContext } from "./memory-test-app.js";

let context: MemoryTestContext;

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function evaluation(): MemoryReleaseGateEvaluationV1 {
  return structuredClone(
    MEMORY_CONTRACT_FIXTURES.MemoryReleaseGateEvaluationV1,
  ) as unknown as MemoryReleaseGateEvaluationV1;
}

beforeAll(async () => {
  context = await createMemoryTestContext();
});

afterAll(async () => {
  if (context) await context.app.close();
});

describe("Slice 5 release-gate control plane", () => {
  it("strictly validates an authenticated project-scoped evaluation and records the decision", async () => {
    const response = await context.app.inject({
      method: "POST",
      url: `/api/v1/memory/projects/${context.projectA}/release-gates/evaluate`,
      headers: auth(context.adminTokenA),
      payload: evaluation(),
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = parseMemoryContract("MemoryReleaseGateDecisionV1", response.json());
    expect(result).toMatchObject({
      project_id: context.projectA,
      stage: "expansion",
      status: "pass",
      decision: "continue",
    });
    expect(db.prepare(
      `SELECT status, decision, dataset_digest
       FROM memory_release_gate_decisions WHERE decision_id = ?`,
    ).get(result.decision_id)).toEqual({
      status: "pass",
      decision: "continue",
      dataset_digest: evaluation().dataset_digest,
    });
  });

  it("rejects unknown fields, wrong scope, and wrong project binding", async () => {
    const unknown = await context.app.inject({
      method: "POST",
      url: `/api/v1/memory/projects/${context.projectA}/release-gates/evaluate`,
      headers: auth(context.adminTokenA),
      payload: { ...evaluation(), fabricated_pass: true },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ code: "schema_invalid" });

    const wrongScope = await context.app.inject({
      method: "POST",
      url: `/api/v1/memory/projects/${context.projectA}/release-gates/evaluate`,
      headers: auth(context.tokenA),
      payload: evaluation(),
    });
    expect(wrongScope.statusCode).toBe(403);

    const wrongProject = await context.app.inject({
      method: "POST",
      url: `/api/v1/memory/projects/${context.projectA}/release-gates/evaluate`,
      headers: auth(context.adminTokenB),
      payload: evaluation(),
    });
    expect(wrongProject.statusCode).toBe(403);
  });
});
