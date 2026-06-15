import { createHash } from "node:crypto";
import type { SerenaSeed, SerenaToolCall } from "./types.js";

/** Matches `lic-full`'s 4000-char rendered-block budget so the arms are comparable. */
export const SERENA_RENDERED_BLOCK_BUDGET = 4000;
/** Per-call output cap before the whole-block budget is applied. */
const PER_CALL_CAP = 1500;

export interface SerenaRenderInput {
  taskId: string;
  stratum?: string;
  generatedAt: string;
  backend: string;
  projectPath: string;
  toolAllowlist: string[];
  seed: SerenaSeed;
  calls: SerenaToolCall[];
}

const SECTION_FOR_TOOL: Record<string, string> = {
  get_symbols_overview: "Symbol Evidence",
  find_symbol: "Symbol Evidence",
  find_referencing_symbols: "Reference Evidence",
  find_declaration: "Declaration / Implementation Evidence",
  find_implementations: "Declaration / Implementation Evidence",
  get_diagnostics_for_file: "Diagnostics",
  get_diagnostics_for_symbol: "Diagnostics",
};

const SECTION_ORDER = [
  "Symbol Evidence",
  "Reference Evidence",
  "Declaration / Implementation Evidence",
  "Diagnostics",
];

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Serena returns some failures as in-band text with MCP `isError=false`
 * (e.g. "Error executing tool: ValueError - Found multiple 3 symbols matching ...").
 * These must be treated as failed calls, not evidence. The reliable marker is the
 * "Error executing tool" prefix; anchoring to the start avoids matching a symbol
 * body that merely mentions an error type.
 */
export function isSerenaErrorOutput(output: string): boolean {
  return /^error executing tool/i.test((output ?? "").trimStart());
}

function trimCall(call: SerenaToolCall): string {
  const out = (call.output ?? "").trim();
  return out.length > PER_CALL_CAP ? out.slice(0, PER_CALL_CAP) + "\n… [call output truncated]" : out;
}

/**
 * Render a Serena fixture into a compact, sectioned markdown block. Provenance
 * (header + seed) is always preserved; only the evidence body is clipped to the
 * budget, so a truncated fixture is still auditable.
 */
export function renderSerenaBlock(input: SerenaRenderInput): string {
  const preamble: string[] = [];
  preamble.push("# Serena Code-Intelligence Context");
  preamble.push(`_Generated at ${input.generatedAt}._`);
  preamble.push(`_Backend: ${input.backend}._`);
  preamble.push(`_Project: ${input.projectPath}._`);
  preamble.push(`_Tool allowlist: ${input.toolAllowlist.join(", ")}._`);
  preamble.push(`_Task: ${input.taskId}${input.stratum ? ` (${input.stratum})` : ""}._`);
  preamble.push("");
  preamble.push("## Seed");
  preamble.push(`- Symbols: ${input.seed.symbols.length ? input.seed.symbols.join(", ") : "(none)"}`);
  if (input.seed.files?.length) preamble.push(`- Files: ${input.seed.files.join(", ")}`);
  if (input.seed.patterns?.length) preamble.push(`- Patterns: ${input.seed.patterns.join(", ")}`);
  preamble.push(`- Seed source: ${input.seed.source}`);
  if (input.seed.note) preamble.push(`- Reviewed note: ${input.seed.note}`);
  preamble.push("");

  const notes: string[] = [];
  const bySection = new Map<string, string[]>();
  for (const call of input.calls) {
    const section = SECTION_FOR_TOOL[call.tool] ?? "Other Evidence";
    const argStr = typeof call.args === "string" ? call.args : JSON.stringify(call.args);
    if (!call.ok || isSerenaErrorOutput(call.output)) {
      const detail = call.error ?? (isSerenaErrorOutput(call.output) ? call.output.trim().split(/\r?\n/)[0] : "failed");
      notes.push(`Tool error: ${call.tool} ${argStr} — ${detail}`);
      continue;
    }
    const body = trimCall(call);
    if (body.length === 0) {
      notes.push(`No output: ${call.tool} ${argStr}`);
      continue;
    }
    const lines = bySection.get(section) ?? [];
    lines.push(`### ${call.tool} ${argStr}`);
    lines.push("```");
    lines.push(body);
    lines.push("```");
    lines.push("");
    bySection.set(section, lines);
  }

  const bodyLines: string[] = [];
  for (const section of [...SECTION_ORDER, "Other Evidence"]) {
    const lines = bySection.get(section);
    if (!lines || lines.length === 0) continue;
    bodyLines.push(`## ${section}`);
    bodyLines.push(...lines);
  }
  if (notes.length > 0) {
    bodyLines.push("## Retrieval Notes");
    for (const n of notes) bodyLines.push(`- ${n}`);
    bodyLines.push("");
  }

  const preambleText = preamble.join("\n");
  const bodyText = bodyLines.join("\n");
  const full = `${preambleText}\n${bodyText}`;
  if (full.length <= SERENA_RENDERED_BLOCK_BUDGET) return full;
  const room = SERENA_RENDERED_BLOCK_BUDGET - preambleText.length - 30;
  const clippedBody = room > 0 ? bodyText.slice(0, room) : "";
  return `${preambleText}\n${clippedBody}\n\n_[truncated to budget]_\n`;
}
