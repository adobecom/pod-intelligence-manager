export interface LivingDocViewerStat {
  viewer_id: string;
  last_viewed_at: string;
  view_count: number;
  regens_since_last_view: number;
}

export interface LivingDocStats {
  pod_id: string;
  last_regenerated_at: string | null;
  regen_count: number;
  viewers: LivingDocViewerStat[];
}
