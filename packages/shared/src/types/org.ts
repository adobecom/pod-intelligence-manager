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
}
