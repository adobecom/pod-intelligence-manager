import type { ContextUpdate } from "@council/shared";
import { classifyUpdate, type Classification } from "./classifier.js";
import { deterministicMerge, llmMerge } from "./agents/merge.js";
import { createConflict } from "./agents/conflict.js";
import { regenerateLivingDoc } from "./agents/summary.js";
import { detectOverlaps } from "./agents/cross-pod.js";
import { isLLMAvailable } from "./llm.js";

export interface CouncilResult {
  classification: Classification;
  merged: boolean;
  conflictCreated: boolean;
  conflictId?: string;
  note?: string;
}

export async function processUpdate(update: ContextUpdate): Promise<CouncilResult> {
  // 1. Classify the update
  const classification = classifyUpdate(update);

  let merged = false;
  let conflictCreated = false;
  let conflictId: string | undefined;
  let note: string | undefined;

  // 2. Route based on classification
  switch (classification) {
    case "additive": {
      const result = deterministicMerge(update, classification);
      merged = result.merged;
      note = result.note;
      break;
    }
    case "overlapping": {
      // Use LLM merge if available, otherwise deterministic
      if (isLLMAvailable()) {
        const result = await llmMerge(update);
        merged = result.merged;
        note = result.note;
        // If LLM says to escalate, create a conflict
        if (result.escalate) {
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
      // Create a conflict record (with LLM analysis if available)
      const conflict = await createConflict(update);
      if (conflict) {
        conflictCreated = true;
        conflictId = conflict.id;
      }
      merged = true;
      break;
    }
  }

  // 3. Regenerate the living doc from current DB state
  regenerateLivingDoc(update.pod_id);

  // 4. Detect cross-pod overlaps (lightweight, runs on every update)
  try {
    detectOverlaps();
  } catch {
    // Non-critical — don't block the update pipeline
  }

  return { classification, merged, conflictCreated, conflictId, note };
}
