import type { ContextUpdate } from "@pim/shared";
import { DEFAULT_ORG_TUNING } from "@pim/shared";
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
  type ScoutRecommendation,
} from "./agents/conflict-scout.js";
import { getOrgTuning } from "../services/org-settings.js";

export interface PimResult {
  classification: Classification;
  merged: boolean;
  conflictCreated: boolean;
  conflictId?: string;
  note?: string;
  scout_used?: boolean;
  scout_recommendation?: ScoutRecommendation | null;
}

export async function processUpdate(update: ContextUpdate, orgId?: string): Promise<PimResult> {
  const tuning = orgId ? getOrgTuning(orgId) : DEFAULT_ORG_TUNING;
  const scoutTuning = tuning.conflictScout;
  const classification = classifyUpdate(update, tuning.classifier);

  let scout_used = false;
  let scout_recommendation: ScoutRecommendation | null = null;
  let scoutResult = null as Awaited<ReturnType<typeof runConflictScout>>;

  if (shouldRunConflictScout(classification, update, scoutTuning)) {
    scout_used = true;
    scoutResult = await runConflictScout(update, classification, scoutTuning);
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
    scoutSaysOpenConflict(scoutResult, scoutTuning.overlapForceMinConf)
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
        if (scoutSaysOpenConflict(scoutResult, scoutTuning.additiveMinConf)) {
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
          if (result.escalate && !scoutSuppressesMergeEscalate(scoutResult, scoutTuning.suppressMergeMinConf)) {
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
