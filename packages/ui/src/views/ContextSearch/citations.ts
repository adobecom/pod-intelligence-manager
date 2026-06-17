/**
 * Client-side parsing of the synthesized summary_md returned by /api/context-search.
 *
 * The synthesis prompt produces two sections:
 *
 *   ## Summary
 *   ...prose with inline citations [J1] [S3] [K2]...
 *
 *   ## Sources
 *   1. [J1] **jira** — Title (author, 2024-01-01): https://...
 *   2. [S3] **slack** — Title (author, 2024-01-02)
 *
 * This module:
 *  1. Splits the "## Summary" body from the "## Sources" numbered list.
 *  2. Resolves each citation token to an index in result.hits[] (url match first,
 *     then normalized title — same dedup key the server uses).
 *  3. Rewrites [TOKEN] occurrences in the body to pim-cite:TOKEN markdown links
 *     so react-markdown can render them as interactive elements.
 *
 * All failures are caught and return the raw md unchanged — never throws.
 */

import type { ContextSearchHit } from "@pim/shared";

export interface CitationEntry {
  token: string;
  title: string;
  url?: string;
  /** Index into result.hits[], or -1 if unresolved. */
  hitIndex: number;
}

export interface ParsedSummary {
  /** Summary body text with [TOKEN] replaced by pim-cite: markdown links. */
  body: string;
  citations: Map<string, CitationEntry>;
}

// Matches a Sources list line, e.g.:
//   1. [J1] **jira** — PROJ-123: Fix the thing (alice, 2024-01-01): https://jira.example.com/browse/PROJ-123
//   2. [K2] **kg** — Some Knowledge Entry (bob, 2024-01-02)
// Capture groups: (1) token, (2) raw title+meta, (3) optional url
const SOURCES_LINE_RE =
  /^\d+\.\s+\[([^\]]+)\][^—]*—\s+(.+?)(?:\s*:\s*(https?:\/\/[^\s]+))?$/;

function splitSummary(md: string): { summaryBody: string; sourcesBlock: string } {
  const idx = md.search(/\n##\s+Sources\b/i);
  if (idx === -1) {
    return {
      summaryBody: md.replace(/^##\s+Summary\b\s*/i, "").trim(),
      sourcesBlock: "",
    };
  }
  return {
    summaryBody: md.slice(0, idx).replace(/^##\s+Summary\b\s*/i, "").trim(),
    sourcesBlock: md.slice(idx + 1), // skip the leading newline
  };
}

function parseSourcesBlock(block: string): Map<string, { title: string; url?: string }> {
  const map = new Map<string, { title: string; url?: string }>();
  for (const line of block.split("\n")) {
    const m = line.trim().match(SOURCES_LINE_RE);
    if (!m) continue;
    const token = m[1];
    // Strip trailing "(author, date)" metadata so we match on just the title
    const rawTitle = m[2].replace(/\s*\([^)]+\)\s*$/, "").trim();
    map.set(token, { title: rawTitle, url: m[3] });
  }
  return map;
}

function normalizeTitle(t: string): string {
  return t.toLowerCase().replace(/\s+/g, " ").trim();
}

function resolveToHits(
  entries: Map<string, { title: string; url?: string }>,
  hits: ContextSearchHit[],
): Map<string, CitationEntry> {
  // Build lookup indices — url match takes priority over title match
  const byUrl = new Map<string, number>();
  const byTitle = new Map<string, number>();
  hits.forEach((h, i) => {
    if (h.url) byUrl.set(h.url, i);
    byTitle.set(normalizeTitle(h.title), i);
  });

  const result = new Map<string, CitationEntry>();
  entries.forEach(({ title, url }, token) => {
    let hitIndex = -1;
    if (url && byUrl.has(url)) {
      hitIndex = byUrl.get(url)!;
    } else {
      const n = byTitle.get(normalizeTitle(title));
      if (n !== undefined) hitIndex = n;
    }
    result.set(token, { token, title, url, hitIndex });
  });
  return result;
}

function linkifyCitations(body: string, citations: Map<string, CitationEntry>): string {
  // Match citation tokens like [J1], [K2], [S3] — letter prefix + digits
  return body.replace(/\[([A-Za-z]+\d+)\]/g, (full, token) => {
    if (!citations.has(token)) return full; // unknown token — leave as-is
    return `[[${token}]](pim-cite:${encodeURIComponent(token)})`;
  });
}

/**
 * Parse a summary_md string and resolve its citations against the hits array.
 * Returns the linkified summary body and a token→CitationEntry map.
 * Never throws — returns the raw md on any parse failure.
 */
export function parseSummary(summaryMd: string, hits: ContextSearchHit[]): ParsedSummary {
  try {
    const { summaryBody, sourcesBlock } = splitSummary(summaryMd);
    const entries = parseSourcesBlock(sourcesBlock);
    const citations = resolveToHits(entries, hits);
    const body = linkifyCitations(summaryBody, citations);
    return { body, citations };
  } catch {
    return { body: summaryMd, citations: new Map() };
  }
}
