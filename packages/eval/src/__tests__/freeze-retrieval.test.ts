import { describe, expect, it, vi } from "vitest";
import type { FixtureLearnings } from "../arms/types.js";
import type { Task } from "../tasks/types.js";
import {
  KG_CANDIDATE_LIMIT,
  TASK_KG_QUERY_MAX_CHARS,
  assertKgContractSourceCompatibility,
  assertRequestedTaskRelevantContract,
  assertRetrievalSourceSupportsAsOf,
  buildExplicitKnowledgeQueryRequest,
  buildTaskKgQuery,
  fetchRequiredTaskLearnings,
} from "../cli/freeze-retrieval.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "internal-eval-id",
    type: "code",
    podId: "pod-x",
    prompt: [
      "Repair the upload validation flow for the existing endpoint.",
      "Preserve the caller-visible error contract.",
      "# Current source (evaluator-only source dump)",
      "```ts",
      "const secretImplementationHint = true;",
      "```",
      "# Output",
      "Return the hidden reference implementation.",
    ].join("\n"),
    tags: ["answer-shaping-tag"],
    expectedSignals: ["secretExpectedSymbol"],
    ...overrides,
  };
}

function emptyLearnings(): FixtureLearnings {
  return { nodes: [], total_matching: 0, truncated: false };
}

describe("eval KG freeze retrieval contract", () => {
  it("builds a concise query from caller-visible task text only", () => {
    const query = buildTaskKgQuery(task());

    expect(query).toContain("Repair the upload validation flow");
    expect(query).toContain("caller-visible error contract");
    expect(query).not.toContain("internal-eval-id");
    expect(query).not.toContain("answer-shaping-tag");
    expect(query).not.toContain("secretExpectedSymbol");
    expect(query).not.toContain("secretImplementationHint");
    expect(query).not.toContain("hidden reference implementation");
    expect(query.length).toBeLessThanOrEqual(TASK_KG_QUERY_MAX_CHARS);
  });

  it("bounds explicit semantic retrieval and disables graph expansion", () => {
    expect(buildExplicitKnowledgeQueryRequest(
      ["frontend"],
      "project-x",
      "upload validation endpoint",
    )).toEqual({
      filters: { scopes: ["frontend"], include_project_id: "project-x" },
      max_tokens: 4_000,
      include_details: true,
      limit: KG_CANDIDATE_LIMIT,
      expand_graph: false,
      include_explanations: true,
      record_retrievals: false,
      query_text: "upload validation endpoint",
    });
  });

  it("sends the task cutoff to explicit retrieval before ranking and limiting", () => {
    expect(buildExplicitKnowledgeQueryRequest(
      ["frontend"],
      undefined,
      "upload validation endpoint",
      "2026-04-01T00:00:00Z",
    )).toMatchObject({
      query_mode: "as_of",
      as_of: "2026-04-01T00:00:00Z",
      record_retrievals: false,
    });
  });

  it("rejects contract mode with the explicit-query source instead of silently ignoring it", () => {
    expect(() => assertKgContractSourceCompatibility("query", "task_relevant")).toThrow(
      /only applies when EVAL_PIM_KG_SOURCE=relevant/,
    );
    expect(() => assertKgContractSourceCompatibility("query", undefined)).not.toThrow();
    expect(() => assertKgContractSourceCompatibility("relevant", "task_relevant")).not.toThrow();
  });

  it("fails closed when the relevant route is asked for unsupported as-of retrieval", () => {
    expect(() => assertRetrievalSourceSupportsAsOf(
      "relevant",
      "2026-04-01T00:00:00Z",
      "pod-x",
    )).toThrow(/cannot honor as-of retrieval/);
    expect(() => assertRetrievalSourceSupportsAsOf(
      "query",
      "2026-04-01T00:00:00Z",
      "pod-x",
    )).not.toThrow();
  });

  it("preserves both ends of an overlong caller-visible prompt", () => {
    const query = buildTaskKgQuery(task({
      prompt: `opening intent ${"middle filler ".repeat(200)} final acceptance constraint`,
    }));

    expect(query).toContain("opening intent");
    expect(query).toContain("final acceptance constraint");
    expect(query.length).toBeLessThanOrEqual(TASK_KG_QUERY_MAX_CHARS);
  });

  it("keeps stable identifiers from caller-visible code blocks", () => {
    const query = buildTaskKgQuery(task({
      prompt: [
        "Preserve this public contract:",
        "```ts",
        "interface UploadContract { checksum: string }",
        "```",
        "# Current source",
        "```ts",
        "const evaluatorOnlyImplementation = true;",
        "```",
      ].join("\n"),
    }));

    expect(query).toContain("UploadContract");
    expect(query).toContain("checksum");
    expect(query).not.toContain("evaluatorOnlyImplementation");
  });

  it("rejects a legacy response when task_relevant was requested", () => {
    expect(() => assertRequestedTaskRelevantContract({
      context_contract: {
        mode: "task_relevant",
        returned_mode: "legacy",
        task_query_used: true,
      },
    }, {
      requestedMode: "task_relevant",
      taskQuery: "upload validation endpoint",
      podId: "pod-x",
    })).toThrow(/did not honor requested task_relevant contract/);
  });

  it("accepts an honored task_relevant response", () => {
    expect(() => assertRequestedTaskRelevantContract({
      context_contract: {
        mode: "task_relevant",
        returned_mode: "task_relevant",
        task_query_used: true,
      },
    }, {
      requestedMode: "task_relevant",
      taskQuery: "upload validation endpoint",
      podId: "pod-x",
    })).not.toThrow();
  });

  it("fails a live task retrieval instead of degrading to pod-level learnings", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("backend unavailable"));

    await expect(fetchRequiredTaskLearnings("pod-x", task(), fetcher)).rejects.toThrow(
      /refusing pod-level fallback/,
    );
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1]).not.toContain("secretExpectedSymbol");
  });

  it("returns a successful live task retrieval unchanged", async () => {
    const expected = emptyLearnings();
    const fetcher = vi.fn().mockResolvedValue(expected);

    await expect(fetchRequiredTaskLearnings("pod-x", task({
      asOf: "2026-04-01T00:00:00Z",
    }), fetcher)).resolves.toBe(expected);
    expect(fetcher).toHaveBeenCalledWith(
      "pod-x",
      expect.any(String),
      "2026-04-01T00:00:00Z",
    );
  });

  it("rejects an empty caller-visible task query before making a live request", async () => {
    const fetcher = vi.fn().mockResolvedValue(emptyLearnings());

    await expect(fetchRequiredTaskLearnings("pod-x", task({
      prompt: "# Current source\n```ts\nconst hidden = true;\n```",
    }), fetcher)).rejects.toThrow(/query is empty/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
