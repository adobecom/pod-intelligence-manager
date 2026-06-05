import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #99 — "Campaigns dashboard: search, CSV export, configurable page size"
 *   Parent:  a693ca5fba04b289a18110265f051100c739754e
 *   Merge:   cde40faa406f8cb2036dfeb23b4107aa540b3a58
 *
 * Why this PR was chosen:
 *   - The csvExport.ts change is a single-line documentation update that
 *     promotes a previously attendee-only helper to a shared CSV utility
 *     (now consumed by the Campaigns tab). Models should produce the
 *     minimal docstring rewording without inventing new helpers or APIs.
 */

const SOURCE_FILE = `/**
 * CSV export utilities for attendee data.
 */

export function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
  // Wrap in quotes if the value contains commas, quotes, or newlines
  if (str.includes(',') || str.includes('"') || str.includes('\\n') || str.includes('\\r')) {
    return \`"\${str.replace(/"/g, '""')}"\`
  }
  return str
}

export interface CsvColumn {
  key: string
  label: string
}

export function generateCsv(data: Record<string, unknown>[], columns: CsvColumn[]): string {
  const header = columns.map(c => escapeCsvValue(c.label)).join(',')
  const rows = data.map(row =>
    columns.map(c => escapeCsvValue(row[c.key])).join(',')
  )
  // BOM for Excel compatibility
  return '\\uFEFF' + [header, ...rows].join('\\r\\n')
}

export function downloadCsv(csvContent: string, filename: string): void {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
`;

const ISSUE_TEXT = `Generalize csvExport.ts so it is no longer described as attendee-only.

The Registrations Campaigns tab is adopting the same helpers (escapeCsvValue,
generateCsv, downloadCsv) to export filtered campaign rows. The helpers are
already data-shape agnostic; only the top-of-file docstring still claims the
module is "CSV export utilities for attendee data." Update the docstring to
reflect the broader use (attendees, campaigns, etc.) without touching the
helper signatures or behavior.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/utils/csvExport.ts
+++ b/web-src/src/utils/csvExport.ts
@@ -1,5 +1,5 @@
 /**
- * CSV export utilities for attendee data.
+ * CSV export utilities (attendees, campaigns, etc.).
  */

 export function escapeCsvValue(value: unknown): string {
`;

export const campaignCsvExportHelper: Task = {
  id: "real-emc-campaign-csv-export-helper",
  type: "content",
  podId: "pod-emc-configs",
  asOf: "2026-04-02T10:45:52-07:00",
  tags: ["real-emc", "docs", "csv"],
  prompt: [
    "# Issue",
    ISSUE_TEXT,
    "",
    "# Current source (web-src/src/utils/csvExport.ts, parent commit a693ca5)",
    "```ts",
    SOURCE_FILE,
    "```",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against `web-src/src/utils/csvExport.ts`. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: ["CSV export utilities", "attendees", "campaigns", "docstring"],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #99, merge SHA cde40fa. Parent file at a693ca5.",
  },
  rubric: {
    id: "real-emc-campaign-csv-export-helper-v1",
    criteria: [
      {
        id: "edits_only_docstring",
        description:
          "Does the patch only modify the top-of-file docstring (lines 1-3) and leave escapeCsvValue, generateCsv, and downloadCsv untouched? Score 0-5: 0=changes helper bodies or signatures, 5=docstring-only.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "removes_attendee_only_phrasing",
        description:
          "Does the new docstring drop the 'for attendee data' phrasing so the module is no longer described as attendee-specific? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "broadens_scope_in_text",
        description:
          "Does the new docstring indicate the helpers apply to multiple data shapes (e.g., mentions campaigns or 'attendees, campaigns, etc.' or equivalent broadening)? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "no_new_helpers_or_imports",
        description:
          "Does the patch avoid introducing new helpers, exports, imports, or types that the issue did not request? Boolean.",
        scale: "boolean",
        weight: 1,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference patch, does the agent's diff achieve the same effect regardless of exact wording? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "valid_unified_diff",
        description:
          "Is the output a parseable unified diff with --- / +++ / @@ headers and proper +/- prefixes (not prose, not a full-file rewrite)? Boolean.",
        scale: "boolean",
        weight: 1,
      },
    ],
  },
};
