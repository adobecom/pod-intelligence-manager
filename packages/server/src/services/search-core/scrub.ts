/**
 * Secret-scrubbing helpers for search hit output.
 *
 * Both live (context search) and indexed (project search) modes must scrub
 * secrets from hit text before returning results or storing live-fallback
 * documents into the index.
 *
 * This module is a thin wrapper over secret-scan so callers import from one
 * place and the scrub step is guaranteed to be applied consistently.
 */
import { redactSecrets } from "../secret-scan.js";
import { redactProjectText, redactProjectUrl } from "../project-evidence-normalization.js";

export { redactSecrets };

/** Scrub `title` and `snippet` of every hit in-place (returns new objects).
 *  Generic over T so callers keep their concrete hit types.
 */
export function scrubHits<T extends {
  title: string;
  snippet: string;
  url?: string;
  source_url?: string;
  author?: string;
  metadata?: Record<string, unknown>;
  source_id?: string;
  status?: string;
}>(hits: T[]): T[] {
  return hits.map((hit) => {
    const scrubbed = {
      ...hit,
      title: redactProjectText(hit.title).text,
      snippet: redactProjectText(hit.snippet).text,
    };
    if (typeof scrubbed.url === "string") scrubbed.url = redactProjectUrl(scrubbed.url);
    if (typeof scrubbed.source_url === "string") scrubbed.source_url = redactProjectUrl(scrubbed.source_url);
    if (typeof scrubbed.author === "string") scrubbed.author = redactProjectText(scrubbed.author).text;
    if (typeof scrubbed.source_id === "string") scrubbed.source_id = redactProjectText(scrubbed.source_id).text;
    if (typeof scrubbed.status === "string") scrubbed.status = redactProjectText(scrubbed.status).text;
    if (scrubbed.metadata && typeof scrubbed.metadata === "object") {
      try {
        scrubbed.metadata = JSON.parse(
          redactProjectText(JSON.stringify(scrubbed.metadata)).text,
        ) as Record<string, unknown>;
      } catch {
        scrubbed.metadata = {};
      }
    }
    return scrubbed;
  });
}
