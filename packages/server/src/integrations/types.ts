import type {
  ContextSearchActor,
  ContextSearchHit,
  ContextSource,
  ProjectResources,
} from "@pim/shared";

export interface IntegrationSearchOpts {
  query: string;
  time_window_days: number;
  max_hits_per_source: number;
  pod_id?: string;
  project_id?: string;
  project_name?: string;
  project_resources?: ProjectResources;
  actor?: ContextSearchActor;
}

export interface IntegrationResult {
  source: ContextSource;
  hits: ContextSearchHit[];
  // When set, this source was skipped or failed. Surfaced as missing_sources in the response.
  missing?: string;
}

export function truncate(text: string, max = 400): string {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + "\u2026";
}

export function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
