import { selectKgLearnings } from "../arms/kg-only.js";
import { filterFixtureByAsOf } from "../arms/pim-full.js";
import type { FixtureLearnings, SessionContextFixture } from "../arms/types.js";
import type { KgExpectations, Task } from "../tasks/types.js";

export interface KgMaterialityRow {
  taskId: string;
  kgNodeCount: number;
  totalMatching: number;
  truncated: boolean;
  requiredNodePresent?: boolean;
  requiredFactPresent?: boolean;
  requiredSymbolPresent?: boolean;
  forbiddenFactPresent?: boolean;
  topNodeSummary?: string;
  missingNodeRefs?: string[];
  missingFacts?: string[];
  missingSymbols?: string[];
  forbiddenFactsHit?: string[];
  eligible: boolean;
  reason: string;
}

export function evaluateKgMateriality(task: Task, fixture: SessionContextFixture | null): KgMaterialityRow {
  const scoped = fixture && task.asOf ? filterFixtureByAsOf(fixture, task.asOf) : fixture;
  const learnings = scoped ? selectKgLearnings(scoped, task.id).learnings : emptyLearnings();
  return evaluateLearnings(task.id, learnings, task.kgExpectations);
}

export function evaluateLearnings(taskId: string, learnings: FixtureLearnings, expectations?: KgExpectations): KgMaterialityRow {
  const haystack = learningText(learnings);
  const missingNodeRefs = missing(expectations?.requiredNodeRefs, haystack);
  const missingFacts = missing(expectations?.requiredFacts, haystack);
  const missingSymbols = missing(expectations?.requiredSymbols, haystack);
  const forbiddenFactsHit = hits(expectations?.forbiddenFacts, haystack);
  const requiredNodePresent = expectations?.requiredNodeRefs ? missingNodeRefs.length === 0 : undefined;
  const requiredFactPresent = expectations?.requiredFacts ? missingFacts.length === 0 : undefined;
  const requiredSymbolPresent = expectations?.requiredSymbols ? missingSymbols.length === 0 : undefined;
  const forbiddenFactPresent = expectations?.forbiddenFacts ? forbiddenFactsHit.length > 0 : undefined;

  const failures: string[] = [];
  if (learnings.nodes.length === 0) failures.push("scoped KG block has zero nodes");
  if (missingNodeRefs.length > 0) failures.push(`missing required node refs: ${missingNodeRefs.join(", ")}`);
  if (missingFacts.length > 0) failures.push(`missing required facts: ${missingFacts.join(", ")}`);
  if (missingSymbols.length > 0) failures.push(`missing required symbols: ${missingSymbols.join(", ")}`);
  if (forbiddenFactsHit.length > 0) failures.push(`forbidden facts present: ${forbiddenFactsHit.join(", ")}`);

  return {
    taskId,
    kgNodeCount: learnings.nodes.length,
    totalMatching: learnings.total_matching,
    truncated: learnings.truncated,
    requiredNodePresent,
    requiredFactPresent,
    requiredSymbolPresent,
    forbiddenFactPresent,
    topNodeSummary: learnings.nodes[0]?.summary,
    missingNodeRefs: missingNodeRefs.length > 0 ? missingNodeRefs : undefined,
    missingFacts: missingFacts.length > 0 ? missingFacts : undefined,
    missingSymbols: missingSymbols.length > 0 ? missingSymbols : undefined,
    forbiddenFactsHit: forbiddenFactsHit.length > 0 ? forbiddenFactsHit : undefined,
    eligible: failures.length === 0,
    reason: failures.length === 0 ? "scoped KG materiality satisfied" : failures.join("; "),
  };
}

function emptyLearnings(): FixtureLearnings {
  return { nodes: [], total_matching: 0, truncated: false };
}

function learningText(learnings: FixtureLearnings): string {
  return learnings.nodes
    .map((node) => [node.type, node.summary, node.details, node.source_pod_name, ...node.domains].filter(Boolean).join("\n"))
    .join("\n\n")
    .toLowerCase();
}

function missing(required: string[] | undefined, haystack: string): string[] {
  return (required ?? []).filter((value) => !haystack.includes(value.toLowerCase()));
}

function hits(values: string[] | undefined, haystack: string): string[] {
  return (values ?? []).filter((value) => haystack.includes(value.toLowerCase()));
}
