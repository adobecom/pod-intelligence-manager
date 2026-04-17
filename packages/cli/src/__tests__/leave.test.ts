import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  PROTOCOL_MARKER_BEGIN,
  PROTOCOL_MARKER_END,
} from "../templates/pod-agent-protocol.md.js";

describe("pim leave", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pim-leave-"));
    spawnSync("git", ["init"], { cwd: tmp, encoding: "utf-8" });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("strips protocol markers from CLAUDE.md and removes podId from .pim.json", async () => {
    const prev = process.cwd();
    process.chdir(tmp);

    fs.writeFileSync(
      path.join(tmp, "CLAUDE.md"),
      `# Hi\n\n${PROTOCOL_MARKER_BEGIN}\nold\n${PROTOCOL_MARKER_END}\n`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(tmp, ".pim.json"),
      JSON.stringify({ podId: "pod-x", serverUrl: "http://localhost:4000", scope: "backend" }, null, 2),
      "utf-8",
    );

    const { registerLeaveCommand } = await import("../commands/leave.js");
    const { Command } = await import("commander");
    const program = new Command();
    program.name("pim");
    registerLeaveCommand(program);

    try {
      await program.parseAsync(["leave"], { from: "user" });
    } finally {
      process.chdir(prev);
    }

    const md = fs.readFileSync(path.join(tmp, "CLAUDE.md"), "utf-8");
    expect(md).not.toContain(PROTOCOL_MARKER_BEGIN);
    expect(md).not.toContain("pod-x");

    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, ".pim.json"), "utf-8")) as Record<string, unknown>;
    expect(cfg.podId).toBeUndefined();
    expect(cfg.serverUrl).toBe("http://localhost:4000");
    expect(cfg.scope).toBe("backend");
  });
});
