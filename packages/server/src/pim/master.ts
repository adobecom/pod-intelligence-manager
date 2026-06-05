import type { ContextUpdate } from "@pim/shared";
import { DEFAULT_ORG_TUNING } from "@pim/shared";
import db from "../db/connection.js";
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
import { runKgPatternScout, type KgPatternScoutResult } from "./agents/kg-pattern-scout.js";
import { getOrgTuning } from "../services/org-settings.js";
import {
  contestedConflictIdsForScope,
  getOpenConflicts,
  isCautiousPressure,
  isDegradedPressure,
  cautiousMergeResult,
  degradedHoldResult,
} from "./pressure-behavior.js";

export interface PimResult {
  classification: Classification;
  merged: boolean;
  conflictCreated: boolean;
  conflictId?: string;
  note?: string;
  held?: boolean;
  scout_used?: boolean;
  scout_recommendation?: ScoutRecommendation | null;
  degraded?: boolean;
  error?: string;
  kg_scout_used?: boolean;
  kg_hits?: number;
  kg_recommendation?: KgPatternScoutResult["kg_recommendation"];
  kg_primary_node_id?: string;
  kg_conflict_created?: boolean;
  kg_conflict_id?: string;
  kg_lint_finding_id?: string;
  kg_rationale?: string;
}

export async function processUpdate(update: ContextUpdate, orgId?: string): Promise<PimResult> {
  const tuning = orgId ? getOrgTuning(orgId) : DEFAULT_ORG_TUNING;
  const scoutTuning = tuning.conflictScout;

  const classification = classifyUpdate(
    update,
    tuning.classifier,
    tuning.pressure.cautiousMax,
  );

  const podRow = db.prepare("SELECT conflict_pressure FROM pods WHERE pod_id = ?").get(update.pod_id) as {
    conflict_pressure: number;
  } | undefined;
  const podPressure = podRow?.conflict_pressure ?? 0;
  const openConflicts = getOpenConflicts(update.pod_id);
  const openConflictCount = openConflicts.length;
  const contestedIds = contestedConflictIdsForScope(update.scope, openConflicts);

  let kgFields: Partial<PimResult> = {};
  try {
    const kgResult = await runKgPatternScout(
      update,
      orgId,
      tuning.kgPatternScout,
      podPressure,
      openConflictCount,
    );
    kgFields = {
      kg_scout_used: kgResult.kg_scout_used,
      kg_hits: kgResult.kg_hits,
      kg_recommendation: kgResult.kg_recommendation,
      kg_primary_node_id: kgResult.kg_primary_node_id,
      kg_conflict_created: kgResult.kg_conflict_created,
      kg_conflict_id: kgResult.kg_conflict_id,
      kg_lint_finding_id: kgResult.kg_lint_finding_id,
      kg_rationale: kgResult.kg_rationale,
    };
    if (kgResult.kg_conflict_created) {
      return {
        classification,
        merged: true,
        conflictCreated: true,
        conflictId: kgResult.kg_conflict_id,
        note: kgResult.kg_rationale,
        ...kgFields,
      };
    }
  } catch (err) {
    console.error("[pim-master] KG pattern scout failed (non-blocking):", err);
  }

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
      console.error("[pim-master] Conflict Scout failed (non-blocking):", err);
    }
  }

  let merged = false;
  let conflictCreated = false;
  let conflictId: string | undefined;
  let note: string | undefined;
  let held = false;
  let degraded = false;
  let error: string | undefined;

  const degradedHold =
    isDegradedPressure(podPressure, tuning.pressure) &&
    contestedIds.length > 0 &&
    classification !== "contradictory";

  if (degradedHold) {
    const hold = degradedHoldResult(update, contestedIds);
    merged = hold.merged;
    note = hold.note;
    held = hold.held ?? true;
  } else if (
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
        if (isCautiousPressure(podPressure, tuning.pressure) && openConflictCount > 0) {
          const result = cautiousMergeResult(
            update,
            openConflicts.map((c) => c.id),
          );
          merged = result.merged;
          note = result.note;
        } else {
          const result = deterministicMerge(update, classification);
          merged = result.merged;
          note = result.note;
        }
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
        let result: MergeResult;
        if (isCautiousPressure(podPressure, tuning.pressure) && openConflictCount > 0) {
          result = cautiousMergeResult(update, openConflicts.map((c) => c.id));
        } else {
          result = isLLMAvailable()
            ? await tryLlmMerge(update, tuning.pressure.normalMax, podPressure, openConflictCount)
            : degradedOverlapMerge(update, "LLM merge unavailable; overlapping conflict detection was bypassed");
        }
        merged = result.merged;
        note = result.note;
        held = result.held ?? false;
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
    held: held || undefined,
    scout_used,
    scout_recommendation,
    ...kgFields,
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

async function tryLlmMerge(
  update: ContextUpdate,
  normalMax: number,
  podPressure: number,
  openConflictCount: number,
): Promise<MergeResult> {
  try {
    return await llmMerge(update, { normalMax, podPressure, openConflictCount });
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
