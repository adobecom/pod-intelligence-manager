import type { ContextUpdate } from "@pim/shared";
import { DEFAULT_ORG_TUNING } from "@pim/shared";
import { classifyUpdate, type Classification } from "./classifier.js";
import { deterministicMerge, llmMerge, type MergeResult } from "./agents/merge.js";
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
  degraded?: boolean;
  error?: string;
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
    try {
      scoutResult = await runConflictScout(update, classification, scoutTuning);
      if (scoutResult) {
        scout_recommendation = scoutResult.recommendation;
      }
    } catch (err) {
      console.error("[pim-master] Conflict scout failed (non-blocking):", err);
    }
  }

  let merged = false;
  let conflictCreated = false;
  let conflictId: string | undefined;
  let note: string | undefined;
  let degraded = false;
  let error: string | undefined;

  // Scout-forced conflict on overlapping: skip merge LLM when scout is decisive
  if (
    classification === "overlapping" &&
    scoutSaysOpenConflict(scoutResult, scoutTuning.overlapForceMinConf)
  ) {
    const conflict = await tryCreateConflict(update);
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
          const conflict = await tryCreateConflict(update);
          if (conflict) {
            conflictCreated = true;
            conflictId = conflict.id;
            note = scoutResult?.rationale ?? note;
          }
        }
        break;
      }
      case "overlapping": {
        const result = isLLMAvailable()
          ? await tryLlmMerge(update)
          : degradedOverlapMerge(update, "LLM merge unavailable; overlapping conflict detection was bypassed");
        merged = result.merged;
        note = result.note;
        if (result.degraded) {
          degraded = true;
          error = result.error;
        }
        if (result.escalate && !scoutSuppressesMergeEscalate(scoutResult, scoutTuning.suppressMergeMinConf)) {
          const conflict = await tryCreateConflict(update);
          if (conflict) {
            conflictCreated = true;
            conflictId = conflict.id;
          }
        }
        break;
      }
      case "contradictory": {
        const conflict = await tryCreateConflict(update);
        if (conflict) {
          conflictCreated = true;
          conflictId = conflict.id;
        }
        merged = true;
        break;
      }
    }
  }

  void regenerateLivingDoc(update.pod_id).catch((err) => {
    console.error("[pim-master] Living doc regeneration failed (non-blocking):", err);
  });

  void detectOverlaps().catch((err) => {
    console.error("[pim-master] Cross-pod overlap detection failed (non-blocking):", err);
  });

  return {
    classification,
    merged,
    conflictCreated,
    conflictId,
    note,
    scout_used,
    scout_recommendation,
    ...(degraded ? { degraded } : {}),
    ...(error ? { error } : {}),
  };
}

async function tryCreateConflict(update: ContextUpdate): Promise<Awaited<ReturnType<typeof createConflict>>> {
  try {
    return await createConflict(update);
  } catch (err) {
    console.error("[pim-master] Conflict creation failed (non-blocking):", err);
    return null;
  }
}

async function tryLlmMerge(update: ContextUpdate): Promise<MergeResult> {
  try {
    return await llmMerge(update);
  } catch (err) {
    console.error("[pim-master] LLM merge failed, using deterministic merge:", err);
    return degradedOverlapMerge(update, err instanceof Error ? err.message : "LLM merge failed");
  }
}

function degradedOverlapMerge(update: ContextUpdate, error: string): MergeResult {
  const result = deterministicMerge(update, "overlapping");
  return {
    ...result,
    escalate: true,
    degraded: true,
    error,
    conflictIndicators: ["llm_merge_unavailable"],
  };
}
