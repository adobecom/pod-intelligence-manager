import type { Arm, FixtureLearnings, SessionContextFixture } from "./types.js";
import type { Task } from "../tasks/types.js";
import type { PromptSegments } from "../runners/types.js";
import { filterFixtureByAsOf } from "./pim-full.js";

const TIGHT_KG_TOP_N = Number(process.env.PIM_EVAL_KG_TOP_N ?? 3);
const TIGHT_KG_DETAIL_CHARS = Number(process.env.PIM_EVAL_KG_DETAIL_CHARS ?? 0);
const CONTRACT_CARD_NODE_CAP = 3;
const DEFAULT_CONTRACT_CARD_MAX_CHARS = 1_800;

const SYSTEM_CODE = [
  "You are a senior software engineer working on the EMC (Event Management) platform at Adobe.",
  "You will be given relevant org learnings retrieved from the PIM knowledge graph.",
  "Use those learnings to align your output with already-made decisions and avoid known anti-patterns.",
  "Produce a single self-contained TypeScript module that satisfies the user's task.",
  "Return ONLY a fenced ```typescript code block — no prose, no commentary outside the block.",
  "The module should export named functions matching the names mentioned in the task.",
].join("\n");

const SYSTEM_CONTENT = [
  "You are a contributor on the EMC (Event Management) platform at Adobe writing concise, decisive technical content.",
  "You will be given relevant org learnings retrieved from the PIM knowledge graph.",
  "Use them only when relevant to the requested output.",
  "Return ONLY the requested content — no preamble, no postscript.",
].join("\n");

/**
 * KG-only arm: ships only the typed knowledge-graph retrieval portion of the
 * fixture. The living doc, open conflicts, and recent context updates are
 * omitted. Isolates the lift contribution of KG retrieval from the surrounding
 * pod fixtures, which are seed data in the eval rather than live PIM operations.
 *
 * Primary v2 arm for isolating the lift contribution of KG retrieval from the
 * surrounding full PIM bundle.
 */
export const kgOnlyArm: Arm = {
  id: "kg-only",
  label: "KG-only",
  usesPim: true,
  primary: true,
  build(task: Task, fixture: SessionContextFixture | null): PromptSegments {
    if (!fixture) {
      throw new Error(
        `kg-only arm requires a fixture for pod ${task.podId}. Run \`pnpm --filter @pim/eval freeze\` first.`,
      );
    }
    const scoped = task.asOf ? filterFixtureByAsOf(fixture, task.asOf) : fixture;
    const system = task.type === "code" ? SYSTEM_CODE : SYSTEM_CONTENT;
    return {
      system,
      pimContext: serializeKgOnly(scoped, task.id, task),
      userTask: `## Task\n${task.prompt}`,
    };
  },
};

export function selectKgLearnings(fixture: SessionContextFixture, taskId?: string): {
  learnings: FixtureLearnings;
  source: "task" | "pod";
} {
  const taskLearnings = taskId ? fixture.payload.taskRelevantLearnings?.[taskId] : undefined;
  if (taskLearnings) return { learnings: taskLearnings, source: "task" };
  return { learnings: fixture.payload.relevantLearnings, source: "pod" };
}

export function serializeKgOnly(fixture: SessionContextFixture, taskId?: string, task?: Task): string {
  const { pod } = fixture.payload;
  const { learnings: relevantLearnings, source } = selectKgLearnings(fixture, taskId);
  const kgContextMode = process.env.PIM_EVAL_KG_CONTEXT_MODE ?? "default";
  if (kgContextMode === "contract-card") {
    return serializeContractCard(fixture, relevantLearnings, source, taskId, task);
  }

  const tightMode = kgContextMode === "tight";
  const nodes = tightMode
    ? relevantLearnings.nodes.slice(0, Number.isFinite(TIGHT_KG_TOP_N) && TIGHT_KG_TOP_N > 0 ? TIGHT_KG_TOP_N : 3)
    : relevantLearnings.nodes;
  const lines: string[] = [];

  lines.push(`# PIM Knowledge-Graph Context — pod \`${pod.pod_id}\` (${pod.name})`);
  lines.push(`_Pulled at ${fixture.pulledAt}._`);
  if (fixture.asOf) lines.push(`_Point-in-time as of ${fixture.asOf}._`);
  if (taskId) {
    const scope = source === "task" ? `task \`${taskId}\`` : `pod fallback`;
    lines.push(`_KG retrieval scope: ${scope}._`);
  }
  if (tightMode) {
    lines.push("_Tight mode: use these as org conventions only; the task prompt's exported API, field names, input shape, and output shape are authoritative._");
  }
  lines.push("");

  lines.push("## Relevant Org Learnings");
  if (nodes.length > 0) {
    for (const n of nodes) {
      const src = n.source_pod_name ? ` (from ${n.source_pod_name})` : "";
      lines.push(`- **[${n.type}]${src}** ${n.summary}`);
      if (tightMode && nodes.indexOf(n) === 0 && n.details && TIGHT_KG_DETAIL_CHARS > 0) {
        lines.push(`  - ${clipOneLine(n.details, TIGHT_KG_DETAIL_CHARS)}`);
      } else if (!tightMode && n.details) {
        lines.push(`  - ${n.details}`);
      }
    }
    if (tightMode && relevantLearnings.nodes.length > nodes.length) {
      lines.push(`_(${relevantLearnings.nodes.length - nodes.length} lower-ranked frozen learnings omitted by tight KG mode)_`);
    } else if (relevantLearnings.truncated) {
      lines.push(
        `_(${relevantLearnings.total_matching - relevantLearnings.nodes.length} more matching learnings truncated by token budget)_`,
      );
    }
  } else {
    lines.push(`_(no learnings matched for ${source === "task" ? "this task" : "this pod"})_`);
  }
  lines.push("");

  return lines.join("\n");
}

type FixtureLearningNode = FixtureLearnings["nodes"][number];

interface RankedContractNode {
  node: FixtureLearningNode;
  originalRank: number;
  evidence: ContractEvidence;
  score: number;
}

interface ContractEvidence {
  requiredFacts: string[];
  requiredSymbols: string[];
  expectedSignals: string[];
  fields: string[];
  fallbacks: string[];
  helpers: string[];
  constraints: string[];
  formulas: string[];
  hasAntiPattern: boolean;
}

function serializeContractCard(
  fixture: SessionContextFixture,
  relevantLearnings: FixtureLearnings,
  source: "task" | "pod",
  taskId?: string,
  task?: Task,
): string {
  const { pod } = fixture.payload;
  const rankedNodes = selectContractCardNodes(relevantLearnings.nodes, task);
  const lines: string[] = [];

  lines.push(`# PIM KG Contract Card - pod \`${pod.pod_id}\` (${pod.name})`);
  if (taskId) {
    const scope = source === "task" ? `task \`${taskId}\`` : "pod fallback";
    lines.push(`Scope: ${scope}.`);
  }
  lines.push("Guard: task prompt API/input/output shape is authoritative");
  lines.push("");

  if (rankedNodes.length === 0) {
    lines.push(`No frozen KG learnings matched for ${source === "task" ? "this task" : "this pod"}.`);
    return lines.join("\n");
  }

  const top = rankedNodes[0];
  lines.push(`Top node (rank ${top.originalRank}): [${top.node.type}] ${clipOneLine(top.node.summary, 320)}`);
  appendEvidenceLines(lines, top.evidence);

  const antiPattern = rankedNodes.find((ranked) => ranked.evidence.hasAntiPattern);
  if (antiPattern) {
    lines.push(`Anti-pattern: ${clipOneLine(antiPattern.node.summary, 260)}`);
  }

  const secondary = rankedNodes.slice(1);
  if (secondary.length > 0) {
    lines.push("Secondary nodes:");
    for (const ranked of secondary) {
      const additions = summarizeSecondaryEvidence(ranked.evidence);
      lines.push(
        `- rank ${ranked.originalRank} [${ranked.node.type}] ${clipOneLine(ranked.node.summary, additions ? 220 : 260)}${additions ? ` (${additions})` : ""}`,
      );
    }
  }

  if (relevantLearnings.nodes.length > rankedNodes.length) {
    lines.push(`_Omitted ${relevantLearnings.nodes.length - rankedNodes.length} lower-signal frozen learning(s)._`);
  }

  return clipContractCard(lines.join("\n"), contractCardMaxChars());
}

function selectContractCardNodes(nodes: FixtureLearningNode[], task?: Task): RankedContractNode[] {
  if (nodes.length === 0) return [];
  const ranked = nodes.map((node, index) => {
    const evidence = extractContractEvidence(node, task);
    return {
      node,
      originalRank: index + 1,
      evidence,
      score: scoreContractNode(node, index, evidence),
    };
  });

  const selected: RankedContractNode[] = [ranked[0]];
  const coverage = new Set(evidenceKeys(ranked[0].evidence));
  const candidates = ranked.slice(1).sort((a, b) => b.score - a.score || a.originalRank - b.originalRank);

  for (const candidate of candidates) {
    if (selected.length >= CONTRACT_CARD_NODE_CAP) break;
    const keys = evidenceKeys(candidate.evidence);
    const introducesRequired = keys.some((key) => !coverage.has(key) && (key.startsWith("fact:") || key.startsWith("symbol:")));
    const hasTaskSignal =
      candidate.evidence.requiredFacts.length > 0 ||
      candidate.evidence.requiredSymbols.length > 0 ||
      candidate.evidence.expectedSignals.length > 0;
    const introducesAntiPattern = candidate.evidence.hasAntiPattern && hasTaskSignal && !coverage.has("anti-pattern");
    if (!introducesRequired && !introducesAntiPattern) continue;
    if (isGenericArchitectureNode(candidate.node) && !introducesRequired) continue;
    selected.push(candidate);
    for (const key of keys) coverage.add(key);
  }

  return selected;
}

function scoreContractNode(node: FixtureLearningNode, index: number, evidence: ContractEvidence): number {
  let score = 0;
  score += evidence.requiredSymbols.length * 6;
  score += evidence.requiredFacts.length * 5;
  score += evidence.expectedSignals.length * 2;
  score += evidence.hasAntiPattern ? 4 : 0;
  score += Math.min(evidence.fields.length + evidence.fallbacks.length + evidence.helpers.length + evidence.formulas.length, 4);
  score += Math.min(evidence.constraints.length, 3);
  if (isGenericArchitectureNode(node)) score -= 4;
  return score - index / 100;
}

function extractContractEvidence(node: FixtureLearningNode, task?: Task): ContractEvidence {
  const text = `${node.summary}\n${node.details ?? ""}`;
  const haystack = normalizeForMatch(text);
  const expectedSignals = (task?.expectedSignals ?? []).filter((term) => termPresent(haystack, term));
  const requiredFacts = (task?.kgExpectations?.requiredFacts ?? []).filter((term) => termPresent(haystack, term));
  const requiredSymbols = (task?.kgExpectations?.requiredSymbols ?? []).filter((term) => termPresent(haystack, term));
  const fields = [
    ...extractFieldLists(text),
    ...extractHashTokens(text),
    ...extractFieldIdentifiers(text),
    ...[...expectedSignals, ...requiredSymbols].filter((term) => isContractSymbol(term) && termPresent(haystack, term)),
  ];
  const constraints = extractConstraintSentences(text);

  return {
    requiredFacts,
    requiredSymbols,
    expectedSignals,
    fields: uniqueFragments(fields),
    fallbacks: uniqueFragments(extractFallbackRules(text)),
    helpers: uniqueFragments(extractHelperNames(text)),
    constraints,
    formulas: uniqueFragments(extractFormulas(text)),
    hasAntiPattern: node.type === "anti_pattern" || /\banti[- ]pattern\b/i.test(text),
  };
}

function appendEvidenceLines(lines: string[], evidence: ContractEvidence): void {
  if (evidence.fields.length > 0) lines.push(`Fields/signals: ${joinClipped(evidence.fields, 300)}`);
  if (evidence.fallbacks.length > 0) lines.push(`Fallbacks: ${joinClipped(evidence.fallbacks, 220)}`);
  if (evidence.helpers.length > 0) lines.push(`Helpers: ${joinClipped(evidence.helpers, 220)}`);
  if (evidence.constraints.length > 0) lines.push(`Constraints: ${joinClipped(evidence.constraints.slice(0, 3), 420)}`);
  if (evidence.formulas.length > 0) lines.push(`Expressions: ${joinClipped(evidence.formulas, 220)}`);
}

function summarizeSecondaryEvidence(evidence: ContractEvidence): string {
  const bits = [
    ...evidence.requiredFacts.slice(0, 1),
    ...evidence.requiredSymbols.slice(0, 2),
    ...(evidence.hasAntiPattern ? ["anti-pattern"] : []),
  ];
  return joinClipped(uniqueFragments(bits), 120);
}

function evidenceKeys(evidence: ContractEvidence): string[] {
  return [
    ...evidence.requiredFacts.map((fact) => `fact:${normalizeForMatch(fact)}`),
    ...evidence.requiredSymbols.map((symbol) => `symbol:${normalizeForMatch(symbol)}`),
    ...(evidence.hasAntiPattern ? ["anti-pattern"] : []),
  ];
}

function extractFieldLists(text: string): string[] {
  return Array.from(text.matchAll(/\{[^{}\n]{3,180}\}/g))
    .map((match) => normalizeSpaces(match[0]))
    .filter((fragment) => fragment.includes(",") && /[A-Za-z_$][\w$-]*/.test(fragment));
}

function extractHashTokens(text: string): string[] {
  return Array.from(text.matchAll(/\b[A-Za-z0-9][A-Za-z0-9-]*#[A-Za-z0-9][A-Za-z0-9-]*\b/g)).map((match) => match[0]);
}

function extractFieldIdentifiers(text: string): string[] {
  return Array.from(
    text.matchAll(/\b[A-Za-z_$][\w$]*(?:Id|Type|Time|Millis|Cms|Path|Methods|Sponsors|Ticket|Fields)\b/g),
  ).map((match) => match[0]);
}

function extractFallbackRules(text: string): string[] {
  return Array.from(
    text.matchAll(/\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])*\s*\?\?\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])*/g),
  ).map((match) => normalizeSpaces(match[0]));
}

function extractHelperNames(text: string): string[] {
  const prepareHelpers = Array.from(text.matchAll(/\bprepare[A-Z][A-Za-z0-9_]*\b/g)).map((match) => match[0]);
  const dottedCalls = Array.from(text.matchAll(/\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(\)/g)).map((match) => match[0]);
  return [...prepareHelpers, ...dottedCalls];
}

function extractConstraintSentences(text: string): string[] {
  const priority: string[] = [];
  if (/\bwithout an? photo field\b/i.test(text)) priority.push("without photo field");
  if (/\bUTC milliseconds?\b/i.test(text)) priority.push("UTC millis");
  const constraints = splitSentences(text)
    .map((sentence) => normalizeSpaces(sentence))
    .filter((sentence) => /\b(only|must|do not|don't|fallback|fall back|omit|preserve|round[- ]trip|without)\b/i.test(sentence))
    .map((sentence) => clipOneLine(sentence, 190));
  return uniqueFragments([...priority, ...constraints]);
}

function extractFormulas(text: string): string[] {
  return Array.from(text.matchAll(/\([^)]*(?:&&|\|\|)[^)]*\)/g))
    .map((match) => normalizeSpaces(match[0]))
    .filter((fragment) => /[<>!=]=?|&&|\|\|/.test(fragment));
}

function splitSentences(text: string): string[] {
  return normalizeSpaces(text)
    .split(/(?<=[.!?])\s+(?=[A-Z`])/)
    .filter(Boolean);
}

function termPresent(normalizedHaystack: string, term: string): boolean {
  const normalizedTerm = normalizeForMatch(term);
  if (!normalizedTerm) return false;
  if (normalizedHaystack.includes(normalizedTerm)) return true;
  const tokens = normalizedTerm.match(/[a-z0-9#*-]+/g)?.filter((token) => token.length > 2 && token !== "the") ?? [];
  return tokens.length > 0 && tokens.every((token) => normalizedHaystack.includes(token));
}

function isContractSymbol(term: string): boolean {
  return /[#.`(){}]|\b[A-Za-z_$][\w$]*(?:Id|Type|Time|Millis|Cms|Path|Methods|Sponsors|Ticket|Fields)\b/.test(term);
}

function isGenericArchitectureNode(node: FixtureLearningNode): boolean {
  const text = `${node.type} ${node.summary} ${node.details}`;
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

function contractCardMaxChars(): number {
  const max = Number(process.env.PIM_EVAL_KG_CONTRACT_CARD_MAX_CHARS ?? DEFAULT_CONTRACT_CARD_MAX_CHARS);
  return Number.isFinite(max) && max > 0 ? max : DEFAULT_CONTRACT_CARD_MAX_CHARS;
}

function clipContractCard(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 28)).trimEnd()}\n_(contract card clipped)_`;
}

function clipOneLine(text: string, maxChars: number): string {
  const normalized = normalizeSpaces(text);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeSpaces(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeForMatch(text: string): string {
  return normalizeSpaces(text).toLowerCase();
}
