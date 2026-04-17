/**
 * Claude Code PostToolCall hook handler.
 *
 * Invoked by Claude Code after Bash tool calls. Detects git commits and
 * PR creation, then reports to the Council API automatically.
 *
 * Reads JSON from stdin: { tool_name, tool_input, tool_output }
 * Must be fast — Claude Code waits for hooks to complete.
 */
import { resolveConfig, readConfigFile, type CouncilConfig } from "../config.js";

interface HookInput {
  tool_name: string;
  tool_input: { command?: string };
  tool_output: string;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => chunks.push(String(chunk)));
    process.stdin.on("end", () => resolve(chunks.join("")));
    // Timeout after 1s if stdin doesn't close
    setTimeout(() => resolve(chunks.join("")), 1000);
  });
}

function extractCommitSha(output: string): string | null {
  // Match git commit output like: [main abc1234] commit message
  const match = output.match(/\[[\w/.-]+\s+([a-f0-9]{7,40})\]/);
  return match?.[1] ?? null;
}

function extractPrUrl(output: string): string | null {
  const match = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  return match?.[0] ?? null;
}

function contextUpdatesUrl(config: CouncilConfig): string {
  return config.mode === "pod"
    ? `${config.serverUrl}/api/pods/${encodeURIComponent(config.podId!)}/context-updates`
    : `${config.serverUrl}/api/projects/${encodeURIComponent(config.projectId!)}/context-updates`;
}

async function reportToCouncil(config: CouncilConfig, payload: Record<string, unknown>): Promise<void> {
  const url = contextUpdatesUrl(config);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: config.agentId,
        scope: config.scope,
        source: "claude-code-hook",
        ...payload,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Fire-and-forget — don't block Claude Code
  }
}

async function main(): Promise<void> {
  // Check if auto-reporting is enabled
  const configFile = readConfigFile();
  if (configFile?.autoReport?.claudeCodeHook === false) return;

  const config = resolveConfig();
  if (!config) return; // Not configured — skip silently

  let input: HookInput;
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;
    input = JSON.parse(raw);
  } catch {
    return; // Malformed input — skip
  }

  if (input.tool_name !== "Bash") return;

  const command = input.tool_input?.command ?? "";
  const output = input.tool_output ?? "";

  // Detect git commit
  if (/git\s+commit/.test(command) && !/ --dry-run/.test(command)) {
    const sha = extractCommitSha(output);
    if (!sha) return; // Commit might have failed

    // Extract commit subject from command or output
    const subjectMatch = output.match(/\[[\w/.-]+\s+[a-f0-9]+\]\s+(.+)/);
    const summary = subjectMatch?.[1]?.slice(0, 500) ?? "Code committed";

    await reportToCouncil(config, {
      type: "progress",
      summary,
      details: `Committed ${sha}`,
      status: "completed",
      artifacts: [{ type: "commit", sha }],
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    });
    return;
  }

  // Detect PR creation
  if (/gh\s+pr\s+create/.test(command)) {
    const prUrl = extractPrUrl(output);
    if (!prUrl) return;

    const titleMatch = /--title\s+['"]([^'"]+)['"]/.exec(command);
    const summary = titleMatch?.[1] ?? `Pull request created: ${prUrl}`;

    await reportToCouncil(config, {
      type: "progress",
      summary: summary.slice(0, 500),
      details: `PR created: ${prUrl}`,
      status: "in_progress",
      artifacts: [{ type: "pull_request", url: prUrl }],
      blocks: [],
      blocked_by: [],
      needs_input_from: [],
    });
    return;
  }
}

main().catch(() => {
  // Never crash — this is a non-blocking hook
});
