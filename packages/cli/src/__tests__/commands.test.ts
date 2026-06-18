import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { getBaseUrl } from "../util.js";

const sdkMocks = vi.hoisted(() => ({
  report: vi.fn(),
}));

// Mock the SDK so commands don't make real HTTP calls
vi.mock("@pim/sdk", () => ({
  PimClient: vi.fn(function PimClient() {
    return {
      report: sdkMocks.report,
      getContext: vi.fn().mockResolvedValue("# Living Doc"),
      getPod: vi.fn().mockResolvedValue({ pod_id: "pod-1" }),
      getConflicts: vi.fn().mockResolvedValue([]),
      getUpdates: vi.fn().mockResolvedValue([]),
      pullSessionContext: vi.fn().mockResolvedValue({
        livingDocMarkdown: "# Doc",
        pod: { pod_id: "pod-1", name: "P", conflict_pressure: 0 },
        conflicts: [],
        relevantLearnings: {
          nodes: [],
          edges: [],
          total_matching: 0,
          token_estimate: 0,
          truncated: false,
        },
        recentUpdates: [],
        pulledAt: new Date().toISOString(),
      }),
    };
  }),
}));

beforeEach(() => {
  sdkMocks.report.mockReset();
  sdkMocks.report.mockResolvedValue({
    id: "ctx-001",
    pim: { classification: "additive", merged: true, conflictCreated: false },
  });
});

describe("getBaseUrl", () => {
  it("returns the server option value", () => {
    const program = new Command();
    program.option("-s, --server <url>", "Server URL", "http://localhost:4000");
    program.parse([], { from: "user" });
    expect(getBaseUrl(program)).toBe("http://localhost:4000");
  });

  it("uses custom server URL when provided", () => {
    const program = new Command();
    program.option("-s, --server <url>", "Server URL", "http://localhost:4000");
    program.parse(["--server", "http://staging:8080"], { from: "user" });
    expect(getBaseUrl(program)).toBe("http://staging:8080");
  });
});

describe("report command output", () => {
  async function runReportWithOutput(response: unknown): Promise<string> {
    sdkMocks.report.mockResolvedValueOnce(response);

    const { registerReportCommand } = await import("../commands/report.js");
    const program = new Command();
    program
      .name("pim")
      .option("-s, --server <url>", "Server URL", "http://localhost:4000");
    registerReportCommand(program);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await program.parseAsync([
        "report",
        "--pod",
        "pod-1",
        "--type",
        "progress",
        "--scope",
        "frontend",
        "--summary",
        "PR opened",
      ], { from: "user" });
      return logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    } finally {
      logSpy.mockRestore();
    }
  }

  it("prints submitted details for successful PIM results", async () => {
    const output = await runReportWithOutput({
      id: "ctx-001",
      pim: {
        classification: "additive",
        merged: true,
        conflictCreated: false,
        note: "Saved to living doc",
      },
    });

    expect(output).toContain("Context update submitted");
    expect(output).toContain("ID:");
    expect(output).toContain("ctx-001");
    expect(output).toContain("Classification:");
    expect(output).toContain("additive");
    expect(output).toContain("Merged:");
    expect(output).toContain("yes");
    expect(output).toContain("Saved to living doc");
  });

  it("prints queued details without reading PIM success fields", async () => {
    const output = await runReportWithOutput({
      queued: true,
      queue_id: "queue-1",
      queue_size: 2,
      conflict_pressure: 0.91,
      message: "Pod is in critical conflict state",
    });

    expect(output).toContain("Context update queued");
    expect(output).toContain("Queue ID:");
    expect(output).toContain("queue-1");
    expect(output).toContain("Queue size:");
    expect(output).toContain("2");
    expect(output).toContain("Conflict pressure:");
    expect(output).toContain("0.91");
    expect(output).toContain("Pod is in critical conflict state");
    expect(output).not.toContain("Classification:");
  });

  it("prints deduplicated details without reading PIM success fields", async () => {
    const output = await runReportWithOutput({
      deduplicated: true,
      message: "Duplicate context update ignored",
    });

    expect(output).toContain("Context update deduplicated");
    expect(output).toContain("Duplicate context update ignored");
    expect(output).not.toContain("Classification:");
  });
});

describe("CLI command registration", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program
      .name("pim")
      .option("-s, --server <url>", "Server URL", "http://localhost:4000");
  });

  it("report command has --pod or --project plus required --type, --scope, --summary", async () => {
    const { registerReportCommand } = await import("../commands/report.js");
    registerReportCommand(program);

    const reportCmd = program.commands.find(c => c.name() === "report");
    expect(reportCmd).toBeDefined();

    const longNames = reportCmd!.options.map(o => o.long);
    expect(longNames).toContain("--pod");
    expect(longNames).toContain("--project");
    const requiredOpts = reportCmd!.options.filter(o => o.mandatory);
    const requiredNames = requiredOpts.map(o => o.long);
    expect(requiredNames).toContain("--type");
    expect(requiredNames).toContain("--scope");
    expect(requiredNames).toContain("--summary");
  });

  it("pod command is registered", async () => {
    const { registerPodCommands } = await import("../commands/pod.js");
    registerPodCommands(program);

    const podCmd = program.commands.find(c => c.name() === "pod");
    expect(podCmd).toBeDefined();
  });

  it("doc command is registered", async () => {
    const { registerDocCommand } = await import("../commands/doc.js");
    registerDocCommand(program);

    const docCmd = program.commands.find(c => c.name() === "doc");
    expect(docCmd).toBeDefined();
  });

  it("tunnel command is registered", async () => {
    const { registerTunnelCommands } = await import("../commands/tunnel.js");
    registerTunnelCommands(program);

    const tunnelCmd = program.commands.find(c => c.name() === "tunnel");
    expect(tunnelCmd).toBeDefined();
  });

  it("lint command is registered", async () => {
    const { registerLintCommand } = await import("../commands/lint.js");
    registerLintCommand(program);

    const lintCmd = program.commands.find(c => c.name() === "lint");
    expect(lintCmd).toBeDefined();
  });

  it("context command is registered", async () => {
    const { registerContextCommand } = await import("../commands/context.js");
    registerContextCommand(program);

    const ctxCmd = program.commands.find(c => c.name() === "context");
    expect(ctxCmd).toBeDefined();
  });

  it("hooks command is registered with install and uninstall", async () => {
    const { registerHooksCommand } = await import("../commands/hooks.js");
    registerHooksCommand(program);

    const hooksCmd = program.commands.find(c => c.name() === "hooks");
    expect(hooksCmd).toBeDefined();
    const sub = hooksCmd!.commands.map(c => c.name());
    expect(sub).toContain("install");
    expect(sub).toContain("uninstall");
  });

  it("leave command is registered", async () => {
    const { registerLeaveCommand } = await import("../commands/leave.js");
    registerLeaveCommand(program);

    const leaveCmd = program.commands.find(c => c.name() === "leave");
    expect(leaveCmd).toBeDefined();
  });
});
