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

// Node's undici surfaces network errors as TypeError("fetch failed") with
// the real cause hidden in `err.cause.code` (e.g. ENOTFOUND, ETIMEDOUT,
// CERT_HAS_EXPIRED). The bare message is opaque, so callers can't tell
// whether they need to start their VPN or rotate credentials. This helper
// flattens the cause chain into a one-liner with a triage hint.
export function describeFetchError(err: unknown, base?: string): string {
  if (!(err instanceof Error)) return String(err);
  const message = err.message || "fetch failed";
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code;
  if (!code) return message;

  const host = (() => {
    try {
      return base ? new URL(base).host : undefined;
    } catch {
      return undefined;
    }
  })();
  const target = host ? ` to ${host}` : "";

  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `${message}${target}: DNS lookup failed (${code}) — VPN may be required for corp/on-prem hosts`;
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      return `${message}${target}: connection timed out (${code}) — VPN/proxy issue or host unreachable`;
    case "ECONNREFUSED":
      return `${message}${target}: connection refused (${code}) — service down or wrong port`;
    case "CERT_HAS_EXPIRED":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
      return `${message}${target}: TLS error (${code}) — certificate chain not trusted`;
    case "UND_ERR_SOCKET":
      return `${message}${target}: socket reset (${code})`;
    default:
      return `${message}${target}: ${code}${cause?.message ? ` — ${cause.message}` : ""}`;
  }
}
