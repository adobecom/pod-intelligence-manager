import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { getBaseUrl } from "../util.js";

// Mock the SDK so commands don't make real HTTP calls
vi.mock("@council/sdk", () => ({
  CouncilClient: vi.fn().mockImplementation(() => ({
    report: vi.fn().mockResolvedValue({ id: "ctx-001", council: { classification: "additive", merged: true, conflictCreated: false } }),
    getContext: vi.fn().mockResolvedValue("# Living Doc"),
    getPod: vi.fn().mockResolvedValue({ pod_id: "pod-1" }),
    getConflicts: vi.fn().mockResolvedValue([]),
    getUpdates: vi.fn().mockResolvedValue([]),
  })),
}));

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

describe("CLI command registration", () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program
      .name("council")
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

  it("leave command is registered", async () => {
    const { registerLeaveCommand } = await import("../commands/leave.js");
    registerLeaveCommand(program);

    const leaveCmd = program.commands.find(c => c.name() === "leave");
    expect(leaveCmd).toBeDefined();
  });
});
