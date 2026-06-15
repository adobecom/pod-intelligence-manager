import type { Stratum } from "../tasks/types.js";

/**
 * Serena code-intelligence fixture frozen to disk by `serena-freeze`
 * (packages/eval/fixtures/serena/<taskId>.json). Arms consume `renderedBlock`,
 * a pre-rendered, budget-clipped markdown block of Serena symbol/reference/
 * diagnostics evidence for the task.
 *
 * Kept deliberately parallel to the LIC fixture (`LicContextFixture`) so the
 * runner, report, and audits can treat the two code-intelligence providers
 * symmetrically — but a dedicated type, not an overload, so Serena-specific
 * provenance (backend, tool allowlist, live tool inventory) is first-class.
 */
export interface SerenaContextFixture {
  taskId: string;
  stratum?: Stratum;
  generatedAt: string;
  /** `serena --version`, sanitized. */
  serenaVersion: string;
  backend: "language-server" | "jetbrains";
  /** The argv used to launch the local MCP server, for reproducibility. */
  mcpCommand: string[];
  /** Absolute path Serena indexed (a parent-SHA worktree or repo HEAD). */
  projectPath: string;
  repoSha?: string;
  indexSource: SerenaIndexSource;
  /** Tools the freezer was permitted to call this run. */
  toolAllowlist: string[];
  /** Tools that must never be exposed/called for a headline Track-A run. */
  toolDenylist: string[];
  /**
   * The live tool inventory Serena actually exposed (from MCP listTools), so the
   * audit can prove no write/shell/memory/refactor tool was reachable.
   */
  toolInventory?: string[];
  /** Hash of the effective Serena config captured via get_current_config. */
  configHash: string;
  /** Ordered names of the recipe steps executed. */
  recipe: string[];
  seed: SerenaSeed;
  calls: SerenaToolCall[];
  renderedBlock: string;
  renderedBlockHash: string;
  quality?: SerenaFixtureQuality;
}

export type SerenaIndexSource =
  | { kind: "head"; repo: string }
  | { kind: "parentSha"; sha: string; worktree: string };

export interface SerenaSeed {
  symbols: string[];
  files?: string[];
  patterns?: string[];
  naturalLanguageQuery?: string;
  /** Where the seed came from, for auditing seed quality. */
  source: "task-serena-seed" | "lic-seed" | "reviewed-derived" | "none";
  /** Reviewed note carried from `task.serenaSeed.note`, when present. */
  note?: string;
}

export interface SerenaToolCall {
  tool: string;
  args: unknown;
  startedAt: string;
  durationMs: number;
  ok: boolean;
  output: string;
  outputHash: string;
  error?: string;
}

export type SerenaFixtureSignal = "none" | "weak" | "medium" | "strong" | "leak";

export interface SerenaFixtureQuality {
  signal: SerenaFixtureSignal;
  answerLeak: boolean;
  primaryFileRetrieved: boolean;
  symbolEvidenceRetrieved: boolean;
  referencesRetrieved: boolean;
  diagnosticsCaptured: boolean;
  intentMatch: boolean;
  notes: string[];
}
