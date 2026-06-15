import { describe, it, expect } from "vitest";
import { deriveSerenaFixtureQuality, isSerenaFixtureQualityReady } from "../rigor/serena-quality.js";
import type { SerenaContextFixture, SerenaToolCall } from "../serena/types.js";
import type { Task } from "../tasks/types.js";

function makeTask(partial: Partial<Task> = {}): Task {
  return {
    id: "t-test",
    type: "code",
    podId: "pod-test",
    prompt: "# Fix the event form route handling for the edit flow",
    stratum: "S2",
    ...partial,
  };
}

function makeCall(partial: Partial<SerenaToolCall> & { tool: string }): SerenaToolCall {
  return {
    args: {},
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 1,
    ok: true,
    output: "",
    outputHash: "",
    ...partial,
  };
}

function makeFixture(partial: Partial<SerenaContextFixture> = {}): SerenaContextFixture {
  return {
    taskId: "t-test",
    stratum: "S2",
    generatedAt: "2026-01-01T00:00:00.000Z",
    serenaVersion: "serena 0.1.0",
    backend: "language-server",
    mcpCommand: ["serena", "start-mcp-server"],
    projectPath: "/tmp/worktree",
    indexSource: { kind: "parentSha", sha: "deadbeef", worktree: "/tmp/worktree" },
    toolAllowlist: ["find_symbol", "find_referencing_symbols"],
    toolDenylist: ["execute_shell_command"],
    toolInventory: ["find_symbol", "find_referencing_symbols"],
    configHash: "abc",
    recipe: ["find_symbol"],
    seed: { symbols: ["EventForm"], source: "lic-seed" },
    calls: [],
    renderedBlock: "",
    renderedBlockHash: "",
    ...partial,
  };
}

describe("deriveSerenaFixtureQuality", () => {
  it("grades symbol + reference evidence as strong", () => {
    const fixture = makeFixture({
      calls: [
        makeCall({ tool: "find_symbol", output: '[{"name_path":"EventForm","relative_path":"src/EventForm.tsx","body":"export function EventForm() {}"}]' }),
        makeCall({ tool: "find_referencing_symbols", output: '[{"relative_path":"src/Page.tsx","line":12}]' }),
      ],
      renderedBlock: "## Symbol Evidence\nEventForm in src/EventForm.tsx\n## Reference Evidence\nsrc/Page.tsx:12",
    });
    const q = deriveSerenaFixtureQuality(makeTask(), fixture);
    expect(q.symbolEvidenceRetrieved).toBe(true);
    expect(q.referencesRetrieved).toBe(true);
    expect(q.signal).toBe("strong");
    expect(isSerenaFixtureQualityReady(q)).toBe(true);
  });

  it("grades a symbol-only hit as medium", () => {
    const fixture = makeFixture({
      calls: [makeCall({ tool: "find_symbol", output: '[{"name_path":"EventForm","relative_path":"src/EventForm.tsx"}]' })],
      renderedBlock: "## Symbol Evidence\nEventForm",
    });
    const q = deriveSerenaFixtureQuality(makeTask(), fixture);
    expect(q.symbolEvidenceRetrieved).toBe(true);
    expect(q.signal).toBe("medium");
  });

  it("grades a no-seed, no-evidence fixture as none", () => {
    const fixture = makeFixture({
      seed: { symbols: [], source: "none" },
      calls: [makeCall({ tool: "find_symbol", ok: true, output: "no symbols found" })],
      renderedBlock: "## Retrieval Notes\n- nothing",
    });
    const q = deriveSerenaFixtureQuality(makeTask(), fixture);
    expect(q.symbolEvidenceRetrieved).toBe(false);
    expect(q.signal).toBe("none");
    expect(isSerenaFixtureQualityReady(q)).toBe(false);
  });

  it("flags a leaked post-merge answer symbol as leak", () => {
    const task = makeTask({
      groundTruth: {
        output: [
          "diff --git a/src/EventForm.tsx b/src/EventForm.tsx",
          "--- a/src/EventForm.tsx",
          "+++ b/src/EventForm.tsx",
          "+  const superSecretLeakedSymbol = computeRouteFromEventId(eventId);",
        ].join("\n"),
      },
    });
    const fixture = makeFixture({
      // Leak detection applies to a HEAD index (a parent-SHA worktree cannot
      // contain post-merge code, so it is immune by construction).
      indexSource: { kind: "head", repo: "/tmp/repo" },
      calls: [makeCall({ tool: "find_symbol", output: "found superSecretLeakedSymbol in the merged code" })],
      renderedBlock: "## Symbol Evidence\nsuperSecretLeakedSymbol appears here",
    });
    const q = deriveSerenaFixtureQuality(task, fixture);
    expect(q.answerLeak).toBe(true);
    expect(q.signal).toBe("leak");
    expect(isSerenaFixtureQualityReady(q)).toBe(false);
  });

  it("does not flag leak for a parent-SHA index (pre-merge tree cannot contain the answer)", () => {
    const task = makeTask({
      groundTruth: {
        output: [
          "diff --git a/src/EventForm.tsx b/src/EventForm.tsx",
          "+  const superSecretLeakedSymbol = computeRouteFromEventId(eventId);",
        ].join("\n"),
      },
    });
    const fixture = makeFixture({
      indexSource: { kind: "parentSha", sha: "deadbeef", worktree: "/tmp/wt" },
      calls: [makeCall({ tool: "find_symbol", output: "found superSecretLeakedSymbol in the body" })],
    });
    const q = deriveSerenaFixtureQuality(task, fixture);
    expect(q.answerLeak).toBe(false);
    expect(q.signal).not.toBe("leak");
  });

  it("ignores seed echoes (no evidence => none, not leak)", () => {
    const task = makeTask({
      groundTruth: { output: "diff --git a/x b/x\n+  const acknowledged = true;" },
    });
    const fixture = makeFixture({
      indexSource: { kind: "parentSha", sha: "x", worktree: "/tmp/wt" },
      seed: { symbols: ["metadataFieldAcknowledged"], source: "reviewed-derived" },
      calls: [makeCall({ tool: "find_symbol", ok: true, output: "[]" })],
      renderedBlock: "## Seed\n- Symbols: metadataFieldAcknowledged",
    });
    const q = deriveSerenaFixtureQuality(task, fixture);
    expect(q.answerLeak).toBe(false);
    expect(q.signal).toBe("none");
  });

  it("treats empty-array tool output as no result", () => {
    const fixture = makeFixture({
      calls: [makeCall({ tool: "find_symbol", output: "[]" })],
      renderedBlock: "## Retrieval Notes\n- no output",
      seed: { symbols: ["Nope"], source: "lic-seed" },
    });
    const q = deriveSerenaFixtureQuality(makeTask(), fixture);
    expect(q.symbolEvidenceRetrieved).toBe(false);
  });
});
