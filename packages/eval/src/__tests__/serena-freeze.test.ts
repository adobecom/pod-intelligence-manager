import { describe, it, expect } from "vitest";
import { deriveSerenaSeed, runRecipe, type SerenaToolRunner } from "../serena/recipes.js";
import { renderSerenaBlock, SERENA_RENDERED_BLOCK_BUDGET } from "../serena/render.js";
import type { SerenaToolCall } from "../serena/types.js";
import type { Task } from "../tasks/types.js";

function makeTask(partial: Partial<Task> = {}): Task {
  return { id: "t", type: "code", podId: "pod", prompt: "# Do the thing", stratum: "S2", ...partial };
}

/** Fake tool runner: canned outputs by tool, records the calls it received. */
function fakeRunner(outputs: Record<string, string>): SerenaToolRunner & { calls: Array<{ tool: string; args: unknown }> } {
  const calls: Array<{ tool: string; args: unknown }> = [];
  return {
    calls,
    async call(tool: string, args: unknown): Promise<SerenaToolCall> {
      calls.push({ tool, args });
      const output = outputs[tool] ?? "";
      return { tool, args, startedAt: "t", durationMs: 1, ok: output !== "", output, outputHash: "h" };
    },
  };
}

describe("deriveSerenaSeed", () => {
  it("prefers a reviewed serenaSeed", () => {
    const seed = deriveSerenaSeed(makeTask({ serenaSeed: { symbols: ["Foo", "Bar"], files: ["a.ts"], note: "reviewed" } }));
    expect(seed.source).toBe("task-serena-seed");
    expect(seed.symbols).toEqual(["Foo", "Bar"]);
    expect(seed.files).toEqual(["a.ts"]);
    expect(seed.note).toBe("reviewed");
  });

  it("falls back to licSeed.symbol", () => {
    const seed = deriveSerenaSeed(makeTask({ licSeed: { symbol: "EventForm", investigateQuery: "route" } }));
    expect(seed.source).toBe("lic-seed");
    expect(seed.symbols).toEqual(["EventForm"]);
    expect(seed.naturalLanguageQuery).toBe("route");
  });

  it("derives stable identifiers from signals", () => {
    const seed = deriveSerenaSeed(makeTask({ licSignals: ["GroupContext", "the", "a"], expectedSignals: ["resolvePermission"] }));
    expect(seed.source).toBe("reviewed-derived");
    expect(seed.symbols).toContain("GroupContext");
    expect(seed.symbols).toContain("resolvePermission");
    expect(seed.symbols).not.toContain("the");
  });

  it("marks no-seed tasks as none", () => {
    const seed = deriveSerenaSeed(makeTask({ prompt: "# vague" }));
    expect(seed.source).toBe("none");
    expect(seed.symbols).toEqual([]);
  });
});

describe("runRecipe", () => {
  it("S2 chains find_symbol -> references/implementations/diagnostics using the discovered file", async () => {
    const runner = fakeRunner({
      find_symbol: '[{"name_path":"EventForm","relative_path":"src/EventForm.tsx","body":"x"}]',
      find_referencing_symbols: '[{"relative_path":"src/Page.tsx"}]',
      find_implementations: "[]",
      get_diagnostics_for_file: "[]",
    });
    const task = makeTask({ stratum: "S2", licSeed: { symbol: "EventForm" } });
    const { recipe, calls } = await runRecipe(runner, task, deriveSerenaSeed(task));
    expect(recipe).toContain("find_symbol");
    expect(recipe).toContain("find_referencing_symbols");
    expect(recipe).toContain("get_diagnostics_for_file");
    const diag = calls.find((c) => c.tool === "get_diagnostics_for_file");
    expect(diag?.args).toEqual({ relative_path: "src/EventForm.tsx" });
  });

  it("S3 does symbol lookup only (no references, no NL guessing)", async () => {
    const runner = fakeRunner({ find_symbol: '[{"name_path":"X","relative_path":"x.ts"}]' });
    const task = makeTask({ stratum: "S3", licSeed: { symbol: "X" } });
    const { recipe } = await runRecipe(runner, task, deriveSerenaSeed(task));
    expect(recipe).toEqual(["find_symbol"]);
  });

  it("emits no calls when there is no symbol seed", async () => {
    const runner = fakeRunner({});
    const task = makeTask({ stratum: "S3", prompt: "# vague" });
    const { calls } = await runRecipe(runner, task, deriveSerenaSeed(task));
    expect(calls).toHaveLength(0);
  });
});

describe("renderSerenaBlock", () => {
  it("renders provenance + sectioned evidence and respects the budget", () => {
    const block = renderSerenaBlock({
      taskId: "t",
      stratum: "S2",
      generatedAt: "2026-01-01T00:00:00.000Z",
      backend: "language-server",
      projectPath: "/tmp/wt",
      toolAllowlist: ["find_symbol"],
      seed: { symbols: ["EventForm"], source: "lic-seed", note: "n" },
      calls: [
        { tool: "find_symbol", args: { name_path: "EventForm" }, startedAt: "t", durationMs: 1, ok: true, output: "export function EventForm() {}", outputHash: "h" },
        { tool: "find_referencing_symbols", args: {}, startedAt: "t", durationMs: 1, ok: false, output: "", outputHash: "", error: "boom" },
      ],
    });
    expect(block).toContain("# Serena Code-Intelligence Context");
    expect(block).toContain("## Seed");
    expect(block).toContain("Symbols: EventForm");
    expect(block).toContain("## Symbol Evidence");
    expect(block).toContain("## Retrieval Notes");
    expect(block).toContain("Tool error: find_referencing_symbols");
  });

  it("clips to budget while preserving the provenance header", () => {
    // Several near-cap calls so the whole-block budget (not the per-call cap) bites.
    const chunk = "x".repeat(1200);
    const calls: SerenaToolCall[] = Array.from({ length: 6 }, (_, i) => ({
      tool: "find_symbol",
      args: { i },
      startedAt: "t",
      durationMs: 1,
      ok: true,
      output: chunk,
      outputHash: "h",
    }));
    const block = renderSerenaBlock({
      taskId: "t",
      generatedAt: "2026-01-01T00:00:00.000Z",
      backend: "language-server",
      projectPath: "/tmp/wt",
      toolAllowlist: ["find_symbol"],
      seed: { symbols: ["A"], source: "lic-seed" },
      calls,
    });
    expect(block.length).toBeLessThanOrEqual(SERENA_RENDERED_BLOCK_BUDGET + 60);
    expect(block).toContain("# Serena Code-Intelligence Context");
    expect(block).toContain("_[truncated to budget]_");
  });
});
