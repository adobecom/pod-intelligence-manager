import db from "../db/connection.js";
import type { ContextUpdate, OrgTuning } from "@pim/shared";
import type { MergeResult } from "./agents/merge.js";

export interface OpenConflictRow {
  id: string;
  summary: string;
  impact_json: string;
  sides_json: string;
}

export function getOpenConflicts(podId: string): OpenConflictRow[] {
  return db.prepare(
    "SELECT id, summary, impact_json, sides_json FROM conflicts WHERE pod_id = ? AND status != 'resolved'",
  ).all(podId) as unknown as OpenConflictRow[];
}

/** Open conflict ids whose summary/impact mention this scope. */
export function contestedConflictIdsForScope(scope: string, conflicts: OpenConflictRow[]): string[] {
  const scopeLower = scope.toLowerCase();
  const ids: string[] = [];
  for (const c of conflicts) {
    if (c.summary.toLowerCase().includes(scopeLower)) {
      ids.push(c.id);
      continue;
    }
    try {
      const impact = JSON.parse(c.impact_json) as string[];
      if (Array.isArray(impact) && impact.some((line) => line.toLowerCase().includes(scopeLower))) {
        ids.push(c.id);
      }
    } catch {
      // ignore malformed impact
    }
  }
  return ids;
}

export function isCautiousPressure(pressure: number, thresholds: OrgTuning["pressure"]): boolean {
  return pressure > thresholds.normalMax && pressure <= thresholds.cautiousMax;
}

export function isDegradedPressure(pressure: number, thresholds: OrgTuning["pressure"]): boolean {
  return pressure > thresholds.cautiousMax && pressure < thresholds.degradedMax;
}

export function cautiousMergeResult(update: ContextUpdate, conflictIds: string[]): MergeResult {
  const refs = conflictIds.length > 0 ? conflictIds.join(", ") : "open conflicts";
  return {
    merged: true,
    note: `Merged with caution — pod pressure is elevated; ${refs} may affect ${update.scope}. Review before relying on this merge.`,
  };
}

export function degradedHoldResult(update: ContextUpdate, conflictIds: string[]): MergeResult {
  return {
    merged: true,
    held: true,
    note: `Held — ${update.scope} overlaps open conflict(s) ${conflictIds.join(", ")} while pod pressure is degraded. Resolve conflicts before treating this update as canonical.`,
  };
}
