export interface Pod {
  pod_id: string;
  /** Owning initiative; optional for legacy pods. */
  project_id?: string | null;
  name: string;
  sprint_start: string;
  sprint_end: string;
  day_number: number;
  total_days: number;
  conflict_pressure: number;
  milestone: Milestone;
  areas: PodArea[];
}

export interface Milestone {
  name: string;
  target_date: string;
  percent_complete: number;
}

export interface PodArea {
  scope: Scope;
  owner: string;
  status: AreaStatus;
  last_activity: string | null;
}

export type AreaStatus = "done" | "in_progress" | "waiting" | "blocked";

/** Org-defined scope id (see `OrgConfig.scopes`); stored on pod areas and context updates. */
export type Scope = string;
