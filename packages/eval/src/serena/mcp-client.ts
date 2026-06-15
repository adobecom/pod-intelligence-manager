import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import type { SerenaToolCall } from "./types.js";
import type { SerenaToolRunner } from "./recipes.js";
import { isSerenaErrorOutput } from "./render.js";

/**
 * Local, stdio-only MCP client for Serena. PIM is the MCP *client*; Serena is a
 * local *server* process spawned over a pipe. No hosted Serena/Oraios endpoint is
 * ever contacted, and the only tools called are read-only LSP-backed lookups
 * (no LLM call happens inside Serena). Data isolation is enforced here:
 *  - `preflightSerenaEnv()` fails fast unless usage reporting is disabled;
 *  - `SERENA_HOME` (run-scoped) is passed through so state never lands in ~/.serena;
 *  - `call()` refuses any tool outside the allowlist;
 *  - the live tool inventory is captured so a denylisted tool can be detected.
 */

export interface SerenaClientOptions {
  serenaBin?: string;
  context?: string;
  projectPath: string;
  /** Run-scoped SERENA_HOME (holds serena_config.yml + redirected project state). */
  serenaHome: string;
  backend: "language-server" | "jetbrains";
  allowlist: string[];
  denylist: string[];
  /** Extra argv appended to `start-mcp-server` (e.g. backend flags). */
  extraArgs?: string[];
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
}

export interface SerenaClientHandle extends SerenaToolRunner {
  command: string[];
  toolInventory: string[];
  /** Tools that are both exposed by the server AND on the denylist (gate input). */
  deniedExposed: string[];
  configRaw: string;
  configHash: string;
  close(): Promise<void>;
}

/** Fail-fast guard: the headline eval must never let Serena phone home. */
export function preflightSerenaEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.SERENA_USAGE_REPORTING !== "false") {
    throw new Error(
      "SERENA_USAGE_REPORTING must be \"false\" for eval runs (data-isolation gate). " +
        "Export SERENA_USAGE_REPORTING=false before freezing.",
    );
  }
}

function buildEnv(opts: SerenaClientOptions): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") base[k] = v;
  base.SERENA_HOME = opts.serenaHome;
  base.SERENA_USAGE_REPORTING = "false";
  return base;
}

function resultText(result: { content?: Array<{ type?: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function connectSerena(opts: SerenaClientOptions): Promise<SerenaClientHandle> {
  preflightSerenaEnv();
  const bin = opts.serenaBin ?? process.env.SERENA_BIN ?? "serena";
  const context = opts.context ?? "codex";
  // Read-only retrieval over stdio, no dashboard/browser, quiet logs. Tool gating
  // and modes come from the run-scoped serena_config.yml in SERENA_HOME; these flags
  // are belt-and-suspenders so a stray default config can't open a browser or expose
  // the wrong backend during a batch freeze.
  const args = [
    "start-mcp-server",
    "--context", context,
    "--project", opts.projectPath,
    "--transport", "stdio",
    "--language-backend", opts.backend === "jetbrains" ? "JetBrains" : "LSP",
    "--enable-web-dashboard", "False",
    "--enable-gui-log-window", "False",
    "--log-level", "ERROR",
    ...(opts.extraArgs ?? []),
  ];
  const command = [bin, ...args];
  const connectTimeoutMs = opts.connectTimeoutMs ?? 60_000;
  const callTimeoutMs = opts.callTimeoutMs ?? 120_000;

  const transport = new StdioClientTransport({ command: bin, args, env: buildEnv(opts), stderr: "pipe" });
  const client = new Client({ name: "pim-eval-serena-freezer", version: "0.1.0" }, { capabilities: {} });
  await withTimeout(client.connect(transport), connectTimeoutMs, "serena connect");

  const listed = await withTimeout(client.listTools(), connectTimeoutMs, "serena listTools");
  const toolInventory = (listed.tools ?? []).map((t) => t.name);
  const allowed = new Set(opts.allowlist);
  const deniedExposed = toolInventory.filter((name) => opts.denylist.includes(name));

  let configRaw = "";
  if (toolInventory.includes("get_current_config")) {
    try {
      const cfg = await withTimeout(
        client.callTool({ name: "get_current_config", arguments: {} }),
        callTimeoutMs,
        "get_current_config",
      );
      configRaw = resultText(cfg as { content?: Array<{ type?: string; text?: string }> });
    } catch (err) {
      configRaw = `get_current_config failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const configHash = createHash("sha256").update(configRaw).digest("hex").slice(0, 16);

  const call = async (tool: string, args: unknown): Promise<SerenaToolCall> => {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    if (!allowed.has(tool)) {
      return {
        tool,
        args,
        startedAt,
        durationMs: 0,
        ok: false,
        output: "",
        outputHash: "",
        error: `tool ${tool} is not in the allowlist`,
      };
    }
    try {
      const result = (await withTimeout(
        client.callTool({ name: tool, arguments: (args ?? {}) as Record<string, unknown> }),
        callTimeoutMs,
        tool,
      )) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
      const output = resultText(result);
      // Serena reports some failures as in-band text with isError unset; treat those as failed.
      const ok = result.isError !== true && !isSerenaErrorOutput(output);
      return {
        tool,
        args,
        startedAt,
        durationMs: Date.now() - t0,
        ok,
        output,
        outputHash: createHash("sha256").update(output).digest("hex").slice(0, 16),
        ...(ok ? {} : { error: output.trim().split(/\r?\n/)[0] || "tool returned isError" }),
      };
    } catch (err) {
      return {
        tool,
        args,
        startedAt,
        durationMs: Date.now() - t0,
        ok: false,
        output: "",
        outputHash: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  return {
    command,
    toolInventory,
    deniedExposed,
    configRaw,
    configHash,
    call,
    close: async () => {
      await client.close().catch(() => {});
    },
  };
}
