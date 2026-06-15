import type { Arm, FixtureLearnings, SessionContextFixture } from "./types.js";
import type { Task } from "../tasks/types.js";
import type { PromptSegments } from "../runners/types.js";
import { filterFixtureByAsOf } from "./pim-full.js";
import { selectKgLearnings } from "./kg-only.js";

const RETRIEVE_N = numberFromEnv("PIM_EVAL_KG_COMPACT_RETRIEVE_N", 5);
const TOP_N = numberFromEnv("PIM_EVAL_KG_COMPACT_TOP_N", 3);
const TOP_DETAIL_CHARS = numberFromEnv("PIM_EVAL_KG_COMPACT_TOP_DETAIL_CHARS", 0);
const MAX_CHARS = numberFromEnv("PIM_EVAL_KG_COMPACT_MAX_CHARS", 1_000);

const SYSTEM_CODE = [
  "You are a senior software engineer working on the EMC (Event Management) platform at Adobe.",
  "You may be given compact org learnings retrieved from the PIM knowledge graph.",
  "Use those learnings only when they directly relate to the task. The task prompt's API, field names, input shape, and output shape are authoritative.",
  "Produce a single self-contained TypeScript module that satisfies the user's task.",
  "Return ONLY a fenced ```typescript code block - no prose, no commentary outside the block.",
  "The module should export named functions matching the names mentioned in the task.",
].join("\n");

const SYSTEM_CONTENT = [
  "You are a contributor on the EMC (Event Management) platform at Adobe writing concise, decisive technical content.",
  "You may be given compact org learnings retrieved from the PIM knowledge graph.",
  "Use those learnings only when they directly relate to the requested output.",
  "Return ONLY the requested content - no preamble, no postscript.",
].join("\n");

/**
 * Local emulation of the proposed production KG contract:
 * retrieve a small candidate set, relevance-gate it against the task, and emit
 * at most a compact summary-only top-3 context. If nothing is task-related,
 * omit the PIM context entirely so codegen does not pay a context tax.
 */
export const kgCompactArm: Arm = {
  id: "kg-compact",
  label: "KG-compact",
  usesPim: true,
  primary: true,
  // By design, omits PIM context when no KG node clears the relevance gate.
  mayOmitContext: true,
  build(task: Task, fixture: SessionContextFixture | null): PromptSegments {
    if (!fixture) {
      throw new Error(
        `kg-compact arm requires a fixture for pod ${task.podId}. Run \`pnpm --filter @pim/eval freeze\` first.`,
      );
    }
    const scoped = task.asOf ? filterFixtureByAsOf(fixture, task.asOf) : fixture;
    const system = task.type === "code" ? SYSTEM_CODE : SYSTEM_CONTENT;
    const pimContext = serializeCompactKg(scoped, task.id, task);
    return {
      system,
      ...(pimContext ? { pimContext } : {}),
      userTask: `## Task\n${task.prompt}`,
    };
  },
};

type FixtureLearningNode = FixtureLearnings["nodes"][number];

interface RankedCompactNode {
  node: FixtureLearningNode;
  originalRank: number;
  score: number;
  evidence: CompactEvidence;
}

interface CompactEvidence {
  requiredFacts: string[];
  requiredSymbols: string[];
  expectedSignals: string[];
  constraints: string[];
  hasAntiPattern: boolean;
  generic: boolean;
}

export function serializeCompactKg(fixture: SessionContextFixture, taskId: string, task: Task): string | undefined {
  const { learnings, source } = selectKgLearnings(fixture, taskId);
  const candidates = learnings.nodes.slice(0, Math.max(1, RETRIEVE_N));
  const selected = selectCompactNodes(candidates, task);
  if (selected.length === 0) return undefined;

  const lines: string[] = [];
  lines.push(`# PIM KG Compact Context - pod \`${fixture.payload.pod.pod_id}\` (${fixture.payload.pod.name})`);
  lines.push(`Scope: ${source === "task" ? `task \`${taskId}\`` : "pod fallback"}.`);
  lines.push("Guard: task prompt API/input/output shape is authoritative.");
  lines.push("");
  lines.push("## High-confidence KG constraints");

  for (const ranked of selected) {
    const src = ranked.node.source_pod_name ? ` from ${ranked.node.source_pod_name}` : "";
    lines.push(`- rank ${ranked.originalRank} [${ranked.node.type}]${src}: ${clipOneLine(ranked.node.summary, 260)}`);
    const evidence = summarizeEvidence(ranked.evidence);
    if (evidence) lines.push(`  - Signals: ${evidence}`);
    if (shouldIncludeDetail(ranked) && ranked.node.details) {
      lines.push(`  - Detail: ${clipOneLine(ranked.node.details, TOP_DETAIL_CHARS)}`);
    }
  }

  const omitted = learnings.nodes.length - selected.length;
  if (omitted > 0) lines.push(`_Omitted ${omitted} weak or lower-ranked KG candidate(s) after compact relevance gate._`);

  return clipContext(lines.join("\n"), MAX_CHARS);
}

function selectCompactNodes(nodes: FixtureLearningNode[], task: Task): RankedCompactNode[] {
  const rankedNodes = nodes
    .map((node, index) => {
      const evidence = extractEvidence(node, task);
      return {
        node,
        originalRank: index + 1,
        evidence,
        score: scoreNode(node, index, evidence),
      };
    })
    .filter((ranked) => passesGate(ranked.evidence))
    .sort((a, b) => b.score - a.score || a.originalRank - b.originalRank);

  const selected: RankedCompactNode[] = [];
  const coverage = new Set<string>();
  for (const ranked of rankedNodes) {
    if (selected.length >= Math.max(1, TOP_N)) break;
    const keys = evidenceKeys(ranked.evidence);
    const introducesCoverage = keys.some((key) => !coverage.has(key));
    if (!introducesCoverage && selected.length > 0) continue;
    selected.push(ranked);
    for (const key of keys) coverage.add(key);
  }
  return selected.sort((a, b) => a.originalRank - b.originalRank);
}

function extractEvidence(node: FixtureLearningNode, task: Task): CompactEvidence {
  const text = `${node.summary}\n${node.details ?? ""}`;
  const haystack = normalizeForMatch(text);
  const requiredFacts = (task.kgExpectations?.requiredFacts ?? []).filter((term) => termPresent(haystack, term));
  const requiredSymbols = (task.kgExpectations?.requiredSymbols ?? []).filter((term) => termPresent(haystack, term));
  const expectedSignals = (task.expectedSignals ?? []).filter((term) => termPresent(haystack, term));
  return {
    requiredFacts,
    requiredSymbols,
    expectedSignals,
    constraints: extractConstraintSentences(text),
    hasAntiPattern: node.type === "anti_pattern" || /\banti[- ]pattern\b/i.test(text),
    generic: isGenericArchitectureNode(node),
  };
}

function passesGate(evidence: CompactEvidence): boolean {
  if (evidence.requiredFacts.length > 0 || evidence.requiredSymbols.length > 0) return true;
  if (evidence.expectedSignals.length >= 2 && !evidence.generic) return true;
  if (evidence.hasAntiPattern && evidence.expectedSignals.length > 0 && !evidence.generic) return true;
  return false;
}

function scoreNode(node: FixtureLearningNode, index: number, evidence: CompactEvidence): number {
  let score = 0;
  score += evidence.requiredSymbols.length * 6;
  score += evidence.requiredFacts.length * 5;
  score += evidence.expectedSignals.length * 2;
  score += evidence.hasAntiPattern ? 3 : 0;
  score += Math.min(evidence.constraints.length, 3);
  score += Math.min(node.confidence_score ?? 0, 1);
  if (node.type === "decision" || node.type === "resolved_conflict") score += 2;
  if (node.type === "anti_pattern") score += 1;
  if (evidence.generic && evidence.requiredFacts.length === 0 && evidence.requiredSymbols.length === 0) score -= 5;
  return score - index / 100;
}

function shouldIncludeDetail(ranked: RankedCompactNode): boolean {
  if (TOP_DETAIL_CHARS <= 0) return false;
  return ranked.originalRank === 1 || ranked.evidence.hasAntiPattern;
}

function summarizeEvidence(evidence: CompactEvidence): string {
  return joinClipped(
    uniqueFragments([
      ...evidence.requiredFacts.slice(0, 2),
      ...evidence.requiredSymbols.slice(0, 4),
      ...evidence.expectedSignals.slice(0, 3),
      ...(evidence.hasAntiPattern ? ["anti-pattern"] : []),
      ...evidence.constraints.slice(0, 1),
    ]),
    360,
  );
}

function evidenceKeys(evidence: CompactEvidence): string[] {
  return [
    ...evidence.requiredFacts.map((fact) => `fact:${normalizeForMatch(fact)}`),
    ...evidence.requiredSymbols.map((symbol) => `symbol:${normalizeForMatch(symbol)}`),
    ...evidence.expectedSignals.map((signal) => `signal:${normalizeForMatch(signal)}`),
    ...(evidence.hasAntiPattern ? ["anti-pattern"] : []),
  ];
}

function extractConstraintSentences(text: string): string[] {
  return normalizeSpaces(text)
    .split(/(?<=[.!?])\s+(?=[A-Z`])/)
    .map((sentence) => normalizeSpaces(sentence))
    .filter((sentence) => /\b(only|must|do not|don't|fallback|fall back|omit|preserve|round[- ]trip|without|final arbiter)\b/i.test(sentence))
    .map((sentence) => clipOneLine(sentence, 190));
}

function termPresent(normalizedHaystack: string, term: string): boolean {
  const normalizedTerm = normalizeForMatch(term);
  if (!normalizedTerm) return false;
  if (normalizedHaystack.includes(normalizedTerm)) return true;
  const tokens = normalizedTerm.match(/[a-z0-9#*-]+/g)?.filter((token) => token.length > 2 && token !== "the") ?? [];
  return tokens.length > 0 && tokens.every((token) => normalizedHaystack.includes(token));
}

function isGenericArchitectureNode(node: FixtureLearningNode): boolean {
  const text = `${node.type} ${node.summary} ${node.details ?? ""}`;
  return /\b(frontend-only|React Spectrum|design tokens|dark mode|CSV export|Kinesis|webhook|cache|Clouds deprecated|dual-shape|schema migration|living doc|architecture)\b/i.test(text);
}

function uniqueFragments(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values.map((v) => normalizeSpaces(v)).filter(Boolean)) {
    const key = normalizeForMatch(value);
    if (seen.has(key)) continue;
    if (out.some((existing) => normalizeForMatch(existing).includes(key))) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function joinClipped(values: string[], maxChars: number): string {
  const joined: string[] = [];
  for (const value of values) {
    const next = [...joined, value].join("; ");
    if (next.length > maxChars) break;
    joined.push(value);
  }
  return joined.join("; ");
}

function clipContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 28)).trimEnd()}\n_(compact context clipped)_`;
}

function clipOneLine(text: string, maxChars: number): string {
  const normalized = normalizeSpaces(text);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 4)).trimEnd()}...`;
}

function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeForMatch(text: string): string {
  return normalizeSpaces(text).toLowerCase();
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
