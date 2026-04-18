/**
 * Reads PIM config from .pim.json and/or environment variables.
 * Used by git hooks, Claude Code hooks, and CLI commands.
 *
 * Resolution order: env vars > .pim.json > undefined
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export interface PimConfig {
  /** Exactly one of pod or project mode is active. */
  mode: "pod" | "project";
  podId?: string;
  projectId?: string;
  agentId: string;
  scope: string;
  serverUrl: string;
  /** Slug of the org that owns this pod/project. Sent as X-Pim-Org on every request. */
  orgSlug?: string;
}

interface PimJsonFile {
  podId?: string;
  projectId?: string;
  agentId?: string;
  scope?: string;
  serverUrl?: string;
  orgSlug?: string;
  autoReport?: { gitHook?: boolean; claudeCodeHook?: boolean };
}

function findGitRoot(): string | null {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

function readPimJson(): PimJsonFile | null {
  const root = findGitRoot();
  if (!root) return null;
  try {
    const raw = readFileSync(path.join(root, ".pim.json"), "utf-8");
    return JSON.parse(raw) as PimJsonFile;
  } catch {
    return null;
  }
}

/** Git `user.name` for default agent id in prompts / resolved config. */
export function getGitUserName(): string | null {
  const r = spawnSync("git", ["config", "user.name"], { encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

/**
 * Resolve PIM config. Returns null if required fields are missing.
 * Requires either podId or projectId (pod wins if both are set).
 */
export function resolveConfig(): PimConfig | null {
  const json = readPimJson();

  const podId = process.env.PIM_POD_ID?.trim() || json?.podId;
  const projectId = process.env.PIM_PROJECT_ID?.trim() || json?.projectId;
  const scope = process.env.PIM_SCOPE?.trim() || json?.scope;
  const serverUrl = (process.env.PIM_SERVER_URL ?? json?.serverUrl ?? "http://localhost:4000").replace(/\/$/, "");
  const agentId = process.env.PIM_AGENT_ID?.trim() || json?.agentId || getGitUserName();
  const orgSlug = process.env.PIM_ORG_SLUG?.trim() || json?.orgSlug;

  if (!agentId || !scope) return null;

  if (podId) {
    return { mode: "pod", podId, agentId, scope, serverUrl, orgSlug };
  }
  if (projectId) {
    return { mode: "project", projectId, agentId, scope, serverUrl, orgSlug };
  }
  return null;
}

/** Org slug from env or .pim.json, independent of whether a full PimConfig can be resolved. */
export function resolveOrgSlug(): string | undefined {
  const env = process.env.PIM_ORG_SLUG?.trim();
  if (env) return env;
  const json = readPimJson();
  return json?.orgSlug?.trim() || undefined;
}

/**
 * Read just the .pim.json file (for checking autoReport flags etc.)
 */
export function readConfigFile(): PimJsonFile | null {
  return readPimJson();
}

export { findGitRoot };
