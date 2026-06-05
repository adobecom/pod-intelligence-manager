import type { ContextUpdate } from "@pim/shared";
import { DEFAULT_ORG_TUNING } from "@pim/shared";
import { classifyUpdate, type Classification } from "./classifier.js";
import { deterministicMerge, llmMerge, type MergeResult } from "./agents/merge.js";
import { createConflict } from "./agents/conflict.js";
import { regenerateLivingDoc } from "./agents/summary.js";
import { detectOverlaps } from "./agents/cross-pod.js";
import { isLLMAvailable } from "./llm.js";
import {
  shouldRunConflictLic,
  runConflictLic,
  licSaysOpenConflict,
  licSuppressesMergeEscalate,
  type LicRecommendation,
} from "./agents/conflict-lic.js";
import { getOrgTuning } from "../services/org-settings.js";

export interface PimResult {
  classification: Classification;
  merged: boolean;
  conflictCreated: boolean;
  conflictId?: string;
  note?: string;
  lic_used?: boolean;
  lic_recommendation?: LicRecommendation | null;
  degraded?: boolean;
  error?: string;
}

export async function processUpdate(update: ContextUpdate, orgId?: string): Promise<PimResult> {
  const tuning = orgId ? getOrgTuning(orgId) : DEFAULT_ORG_TUNING;
  const licTuning = tuning.conflictLic;
  const classification = classifyUpdate(update, tuning.classifier);

  let lic_used = false;
  let lic_recommendation: LicRecommendation | null = null;
  let licResult = null as Awaited<ReturnType<typeof runConflictLic>>;

  if (shouldRunConflictLic(classification, update, licTuning)) {
    lic_used = true;
    try {
      licResult = await runConflictLic(update, classification, licTuning);
      if (licResult) {
        lic_recommendation = licResult.recommendation;
      }
    } catch (err) {
      console.error("[pim-master] Conflict lic failed (non-blocking):", err);
    }
  }

  let merged = false;
  let conflictCreated = false;
  let conflictId: string | undefined;
  let note: string | undefined;
  let degraded = false;
  let error: string | undefined;

  // lic-forced conflict on overlapping: skip merge LLM when lic is decisive
  if (
    classification === "overlapping" &&
    licSaysOpenConflict(licResult, licTuning.overlapForceMinConf)
  ) {
    const conflict = await tryCreateConflict(update);
    if (conflict) {
      conflictCreated = true;
      conflictId = conflict.id;
    }
    merged = true;
    note = licResult?.rationale;
  } else {
    switch (classification) {
      case "additive": {
        const result = deterministicMerge(update, classification);
        merged = result.merged;
        note = result.note;
        if (licSaysOpenConflict(licResult, licTuning.additiveMinConf)) {
          const conflict = await tryCreateConflict(update);
          if (conflict) {
            conflictCreated = true;
            conflictId = conflict.id;
            note = licResult?.rationale ?? note;
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
        if (result.escalate && !licSuppressesMergeEscalate(licResult, licTuning.suppressMergeMinConf)) {
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
    lic_used,
    lic_recommendation,
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
