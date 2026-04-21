export interface Conflict {
  id: string;
  pod_id: string;
  created_at: string;
  status: ConflictStatus;
  severity: ConflictSeverity;
  summary: string;
  sides: ConflictSide[];
  master_analysis: string;
  impact: string[];
  resolved_by: string | null;
  resolution: string | null;
  resolution_date: string | null;
  /**
   * Auto-incremented by the escalation service as open conflicts age
   * (L1 at 4h, L2 at 8h, L3 at 16h, L4 at 24h). 0 = no escalation yet.
   */
  escalation_level?: number;
}

export interface ConflictSide {
  contributor: string;
  position: string;
  context_update_id: string;
  timestamp: string;
}

export type ConflictStatus = "open" | "in_discussion" | "resolved";

export type ConflictSeverity = "blocking" | "non_blocking";

export interface PendingWork {
  context_update_id: string;
  agent_id: string;
  summary: string;
  presumes: string;
  rework_cost: string;
}
