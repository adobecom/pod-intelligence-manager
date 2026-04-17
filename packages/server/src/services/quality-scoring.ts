import db from "../db/connection.js";
import type { ContextUpdateInput } from "./ingestion.js";

export interface QualityBreakdown {
  completeness: number;
  specificity: number;
  relationships: number;
  contextual_fit: number;
  total: number;
}

interface PriorUpdateRow {
  scope: string;
}

interface AreaRow {
  scope: string;
  owner: string;
}

const VAGUE_PHRASES = [
  "made progress",
  "working on it",
  "some updates",
  "various things",
  "misc work",
  "general progress",
  "stuff done",
  "moving forward",
  "continuing work",
];

const NAMED_ENTITY_RE = /\b[A-Z][a-z]+[A-Z]\w*\b|[a-z]+[A-Z]\w*|\b\w+[./]\w+/g;

export function scoreUpdate(input: ContextUpdateInput, podId: string): QualityBreakdown {
  const completeness = scoreCompleteness(input);
  const specificity = scoreSpecificity(input);
  const relationships = scoreRelationships(input);
  const contextual_fit = scoreContextualFit(input, podId);

  return {
    completeness,
    specificity,
    relationships,
    contextual_fit,
    total: Math.min(1.0, completeness + specificity + relationships + contextual_fit),
  };
}

export function scoreProjectUpdate(input: ContextUpdateInput, projectId: string): QualityBreakdown {
  const completeness = scoreCompleteness(input);
  const specificity = scoreSpecificity(input);
  const relationships = scoreRelationships(input);
  const contextual_fit = scoreContextualFitProject(input, projectId);

  return {
    completeness,
    specificity,
    relationships,
    contextual_fit,
    total: Math.min(1.0, completeness + specificity + relationships + contextual_fit),
  };
}

function scoreCompleteness(input: ContextUpdateInput): number {
  let score = 0;

  // Details substance
  if (input.details && input.details.length > 20) score += 0.08;
  if (input.details && input.details.length > 100) score += 0.04;

  // Artifacts provided
  if (input.artifacts.length > 0) score += 0.08;

  // Any relationship field populated
  if (input.blocks.length > 0 || input.blocked_by.length > 0 || input.needs_input_from.length > 0) {
    score += 0.06;
  }

  // Summary length
  if (input.summary.length > 15) score += 0.04;

  return Math.min(0.3, score);
}

function scoreSpecificity(input: ContextUpdateInput): number {
  let score = 0;
  const text = `${input.summary} ${input.details}`;

  // Word count in summary
  const words = input.summary.trim().split(/\s+/).length;
  if (words > 5) score += 0.05;
  if (words > 10) score += 0.05;

  // Named entities / technical tokens
  const entities = text.match(NAMED_ENTITY_RE) ?? [];
  if (entities.length > 0) score += 0.05;
  if (entities.length > 2) score += 0.05;

  // Absence of vague phrases
  const lower = input.summary.toLowerCase();
  const hasVague = VAGUE_PHRASES.some(phrase => lower.includes(phrase));
  if (!hasVague) score += 0.05;

  // Contains technical identifiers (file paths, function-like tokens)
  const hasTechnical = /\w+\.\w+/.test(text) || /\/\w+/.test(text) || /\w+\(\)/.test(text);
  if (hasTechnical) score += 0.05;

  return Math.min(0.3, score);
}

function scoreRelationships(input: ContextUpdateInput): number {
  let score = 0;

  const hasBlocks = input.blocks.length > 0;
  const hasBlockedBy = input.blocked_by.length > 0;
  const hasNeedsInput = input.needs_input_from.length > 0;
  const hasAnyRelationship = hasBlocks || hasBlockedBy || hasNeedsInput;

  // Type-appropriate relationship check
  if (input.type === "blocker" || input.status === "blocked") {
    score += hasBlockedBy ? 0.15 : 0;
  } else if (input.type === "question") {
    score += hasNeedsInput ? 0.15 : 0;
  } else {
    // Non-dependent types: some credit for having relationships, neutral otherwise
    score += hasAnyRelationship ? 0.10 : 0.05;
  }

  // Downstream awareness bonus
  if (hasBlocks) score += 0.05;

  return Math.min(0.2, score);
}

function scoreContextualFit(input: ContextUpdateInput, podId: string): number {
  let score = 0;

  // Query prior updates from this agent in this pod
  const priorUpdates = db.prepare(
    "SELECT scope FROM context_updates WHERE pod_id = ? AND agent_id = ? ORDER BY timestamp DESC LIMIT 5"
  ).all(podId, input.agent_id) as PriorUpdateRow[];

  if (priorUpdates.length > 0) {
    // Scope consistency: does this match the agent's usual scope?
    const scopeCounts = new Map<string, number>();
    for (const u of priorUpdates) {
      scopeCounts.set(u.scope, (scopeCounts.get(u.scope) ?? 0) + 1);
    }
    const majorityScope = [...scopeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    score += input.scope === majorityScope ? 0.10 : 0.03;

    // Established agent
    score += 0.05;
  } else {
    // First update — benefit of the doubt
    score += 0.10;
    score += 0.05;
  }

  // Bonus: agent's scope matches their pod_areas assignment
  const area = db.prepare(
    "SELECT scope, owner FROM pod_areas WHERE pod_id = ? AND owner = ?"
  ).get(podId, input.agent_id) as AreaRow | undefined;

  if (area && area.scope === input.scope) {
    score += 0.05;
  }

  return Math.min(0.2, score);
}

function scoreContextualFitProject(input: ContextUpdateInput, projectId: string): number {
  let score = 0;

  const priorUpdates = db.prepare(
    "SELECT scope FROM project_context_updates WHERE project_id = ? AND agent_id = ? ORDER BY timestamp DESC LIMIT 5",
  ).all(projectId, input.agent_id) as PriorUpdateRow[];

  if (priorUpdates.length > 0) {
    const scopeCounts = new Map<string, number>();
    for (const u of priorUpdates) {
      scopeCounts.set(u.scope, (scopeCounts.get(u.scope) ?? 0) + 1);
    }
    const majorityScope = [...scopeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    score += input.scope === majorityScope ? 0.10 : 0.03;
    score += 0.05;
  } else {
    score += 0.10;
    score += 0.05;
  }

  return Math.min(0.2, score);
}
