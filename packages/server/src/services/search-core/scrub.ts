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

export { redactSecrets };

/** Scrub `title` and `snippet` of every hit in-place (returns new objects).
 *  Generic over T so callers keep their concrete hit types.
 */
export function scrubHits<T extends { title: string; snippet: string }>(hits: T[]): T[] {
  return hits.map((h) => ({
    ...h,
    title: redactSecrets(h.title).text,
    snippet: redactSecrets(h.snippet).text,
  }));
}
