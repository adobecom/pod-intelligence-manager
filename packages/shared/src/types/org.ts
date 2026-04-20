import type { ProjectAnatomy } from "./project";

export interface OrgPodSummary {
  pod_id: string;
  name: string;
  day_number: number;
  total_days: number;
  conflict_pressure: number;
  open_conflicts: number;
  active_tunnels: number;
  agent_count: number;
}

export interface CrossPodOverlap {
  id: string;
  pod_a: string;
  pod_b: string;
  description: string;
  advisory: string;
}

export interface ArchivedPod {
  pod_id: string;
  name: string;
  completed_date: string;
  duration_days: number;
  final_pressure: number;
  /** Present on archive API response when knowledge extraction ran. */
  learnings_extracted?: number;
}

/** Initiative removed from the active list; context updates are deleted at archive time. */
export interface ArchivedProject {
  project_id: string;
  name: string;
  description: string | null;
  created_at: string;
  archived_date: string;
  anatomy: ProjectAnatomy;
}
