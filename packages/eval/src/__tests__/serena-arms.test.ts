import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serenaFullArm, serenaClippedArm, serenaPimCombinedArm } from "../arms/index.js";
import type { SessionContextFixture } from "../arms/types.js";
import type { SerenaContextFixture } from "../serena/types.js";
import type { Task } from "../tasks/types.js";

const __filename = fileURLToPath(import.meta.url);
const FIXTURE_DIR = join(dirname(__filename), "..", "..", "fixtures", "session-contexts");

async function loadPim(): Promise<SessionContextFixture> {
  return JSON.parse(await readFile(join(FIXTURE_DIR, "pod-emc-rbac.json"), "utf8")) as SessionContextFixture;
}

function makeTask(partial: Partial<Task> = {}): Task {
  return { id: "t", type: "code", podId: "pod-emc-rbac", prompt: "# Implement the thing", stratum: "S2", ...partial };
}

function makeSerena(renderedBlock = "# Serena Code-Intelligence Context\n## Symbol Evidence\nEventForm"): SerenaContextFixture {
  return {
    taskId: "t",
    stratum: "S2",
    generatedAt: "2026-01-01T00:00:00.000Z",
    serenaVersion: "serena 0.1.0",
    backend: "language-server",
    mcpCommand: ["serena", "start-mcp-server"],
    projectPath: "/tmp/wt",
    indexSource: { kind: "parentSha", sha: "deadbeef", worktree: "/tmp/wt" },
    toolAllowlist: ["find_symbol"],
    toolDenylist: ["execute_shell_command"],
    configHash: "abc",
    recipe: ["find_symbol"],
    seed: { symbols: ["EventForm"], source: "lic-seed" },
    calls: [],
    renderedBlock,
    renderedBlockHash: "h",
  };
}

describe("serena arms", () => {
  it("serena-full ships only the Serena block and no PIM context", () => {
    const seg = serenaFullArm.buildWithInputs!(makeTask(), { pim: null, lic: null, serena: makeSerena() });
    expect(seg.pimContext).toContain("# Serena Code-Intelligence Context");
    expect(seg.pimContext).not.toContain("PIM Session Context");
    expect(seg.pimContext).not.toMatch(/Living Doc|Open Conflicts/);
    expect(seg.userTask).toContain("Implement the thing");
  });

  it("serena-full throws without a serena fixture", () => {
    expect(() => serenaFullArm.buildWithInputs!(makeTask(), { pim: null, lic: null, serena: null })).toThrow(/serena fixture/);
  });

  it("serena-clipped truncates to the matched budget", () => {
    const big = "y".repeat(5000);
    const seg = serenaClippedArm.buildWithInputs!(makeTask(), { pim: null, lic: null, serena: makeSerena(big) });
    expect((seg.pimContext ?? "").length).toBeLessThanOrEqual(2001);
  });

  it("serena-pim-combined fuses both sources", async () => {
    const pim = await loadPim();
    const seg = serenaPimCombinedArm.buildWithInputs!(makeTask(), { pim, lic: null, serena: makeSerena() });
    expect(seg.pimContext).toContain("=== PIM Session Context ===");
    expect(seg.pimContext).toContain("=== Serena Code-Intelligence Context ===");
  });

  it("serena-pim-combined requires both fixtures", async () => {
    const pim = await loadPim();
    expect(() => serenaPimCombinedArm.buildWithInputs!(makeTask(), { pim, lic: null, serena: null })).toThrow(/serena fixture/);
    expect(() => serenaPimCombinedArm.buildWithInputs!(makeTask(), { pim: null, lic: null, serena: makeSerena() })).toThrow(/PIM fixture/);
  });
});
