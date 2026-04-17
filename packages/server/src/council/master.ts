import type { ContextUpdate } from "@council/shared";
import { classifyUpdate, type Classification } from "./classifier.js";
import { deterministicMerge, llmMerge } from "./agents/merge.js";
import { createConflict } from "./agents/conflict.js";
import { regenerateLivingDoc } from "./agents/summary.js";
import { detectOverlaps } from "./agents/cross-pod.js";
import { isLLMAvailable } from "./llm.js";
import {
  shouldRunConflictScout,
  runConflictScout,
  scoutSaysOpenConflict,
  scoutSuppressesMergeEscalate,
  ADDITIVE_SCOUT_CONFLICT_MIN_CONF,
  OVERLAP_SCOUT_FORCE_CONFLICT_MIN_CONF,
  type ScoutRecommendation,
} from "./agents/conflict-scout.js";

export interface CouncilResult {
  classification: Classification;
  merged: boolean;
  conflictCreated: boolean;
  conflictId?: string;
  note?: string;
  scout_used?: boolean;
  scout_recommendation?: ScoutRecommendation | null;
}

export async function processUpdate(update: ContextUpdate): Promise<CouncilResult> {
  const classification = classifyUpdate(update);

  let scout_used = false;
  let scout_recommendation: ScoutRecommendation | null = null;
  let scoutResult = null as Awaited<ReturnType<typeof runConflictScout>>;

  if (shouldRunConflictScout(classification, update)) {
    scout_used = true;
    scoutResult = await runConflictScout(update, classification);
    if (scoutResult) {
      scout_recommendation = scoutResult.recommendation;
    }
  }

  let merged = false;
  let conflictCreated = false;
  let conflictId: string | undefined;
  let note: string | undefined;

  // Scout-forced conflict on overlapping: skip merge LLM when scout is decisive
  if (
    classification === "overlapping" &&
    scoutSaysOpenConflict(scoutResult, OVERLAP_SCOUT_FORCE_CONFLICT_MIN_CONF)
  ) {
    const conflict = await createConflict(update);
    if (conflict) {
      conflictCreated = true;
      conflictId = conflict.id;
    }
    merged = true;
    note = scoutResult?.rationale;
  } else {
    switch (classification) {
      case "additive": {
        const result = deterministicMerge(update, classification);
        merged = result.merged;
        note = result.note;
        if (scoutSaysOpenConflict(scoutResult, ADDITIVE_SCOUT_CONFLICT_MIN_CONF)) {
          const conflict = await createConflict(update);
          if (conflict) {
            conflictCreated = true;
            conflictId = conflict.id;
            note = scoutResult?.rationale ?? note;
          }
        }
        break;
      }
      case "overlapping": {
        if (isLLMAvailable()) {
          const result = await llmMerge(update);
          merged = result.merged;
          note = result.note;
          if (result.escalate && !scoutSuppressesMergeEscalate(scoutResult)) {
            const conflict = await createConflict(update);
            if (conflict) {
              conflictCreated = true;
              conflictId = conflict.id;
            }
          }
        } else {
          const result = deterministicMerge(update, classification);
          merged = result.merged;
          note = result.note;
        }
        break;
      }
      case "contradictory": {
        const conflict = await createConflict(update);
        if (conflict) {
          conflictCreated = true;
          conflictId = conflict.id;
        }
        merged = true;
        break;
      }
    }
  }

  regenerateLivingDoc(update.pod_id);

  try {
    detectOverlaps();
  } catch {
    // Non-critical
  }

  return {
    classification,
    merged,
    conflictCreated,
    conflictId,
    note,
    scout_used,
    scout_recommendation,
  };
}
