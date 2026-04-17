/**
 * Reads Council config from .council.json and/or environment variables.
 * Used by git hooks, Claude Code hooks, and CLI commands.
 *
 * Resolution order: env vars > .council.json > undefined
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const SCOPES = new Set(["frontend", "backend", "design", "qa", "infra", "pm"]);

export interface CouncilConfig {
  /** Exactly one of pod or project mode is active. */
  mode: "pod" | "project";
  podId?: string;
  projectId?: string;
  agentId: string;
  scope: string;
  serverUrl: string;
}

interface CouncilJsonFile {
  podId?: string;
  projectId?: string;
  agentId?: string;
  scope?: string;
  serverUrl?: string;
  autoReport?: { gitHook?: boolean; claudeCodeHook?: boolean };
}

function findGitRoot(): string | null {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

function readCouncilJson(): CouncilJsonFile | null {
  const root = findGitRoot();
  if (!root) return null;
  try {
    const raw = readFileSync(path.join(root, ".council.json"), "utf-8");
    return JSON.parse(raw) as CouncilJsonFile;
  } catch {
    return null;
  }
}

function gitUserName(): string | null {
  const r = spawnSync("git", ["config", "user.name"], { encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

/**
 * Resolve council config. Returns null if required fields are missing.
 * Requires either podId or projectId (pod wins if both are set).
 */
export function resolveConfig(): CouncilConfig | null {
  const json = readCouncilJson();

  const podId = process.env.COUNCIL_POD_ID?.trim() || json?.podId;
  const projectId = process.env.COUNCIL_PROJECT_ID?.trim() || json?.projectId;
  const scope = process.env.COUNCIL_SCOPE?.trim() || json?.scope;
  const serverUrl = (process.env.COUNCIL_SERVER_URL ?? json?.serverUrl ?? "http://localhost:4000").replace(/\/$/, "");
  const agentId = process.env.COUNCIL_AGENT_ID?.trim() || json?.agentId || gitUserName();

  if (!agentId || !scope) return null;
  if (!SCOPES.has(scope)) return null;

  if (podId) {
    return { mode: "pod", podId, agentId, scope, serverUrl };
  }
  if (projectId) {
    return { mode: "project", projectId, agentId, scope, serverUrl };
  }
  return null;
}

/**
 * Read just the .council.json file (for checking autoReport flags etc.)
 */
export function readConfigFile(): CouncilJsonFile | null {
  return readCouncilJson();
}

export { findGitRoot };
