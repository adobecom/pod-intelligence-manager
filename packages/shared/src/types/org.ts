import type { ProjectAnatomy } from "./project.js";

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
  /** Number of graph nodes added under legacy authority or candidates submitted after freeze. */
  learnings_extracted?: number;
  /** Present when `learnings_extracted` counts pending canonical candidates. */
  canonical_memory_intake?: CanonicalMemoryIntakeSummary;
  /** False while archival knowledge extraction still needs to complete or be retried. */
  extraction_completed?: boolean;
}

export type PodArchiveJobStatus = "running" | "completed" | "failed";

export interface CanonicalMemoryIntakeSummary {
  project_id: string;
  used_system_project: boolean;
  candidates_submitted: number;
  candidates_created: number;
  total: number;
  selected: number;
  dropped_low_confidence: number;
  dropped_unmappable: number;
  dropped_over_cap: number;
}

export interface PodArchiveJob {
  job_id: string;
  pod_id: string;
  status: PodArchiveJobStatus;
  started_at: string;
  completed_at?: string;
  status_url: string;
  archived?: ArchivedPod;
  /** Present when frozen legacy output was submitted to canonical review intake. */
  canonical_memory_intake?: CanonicalMemoryIntakeSummary;
  error?: string;
  error_code?: string;
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
