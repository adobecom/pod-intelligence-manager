import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #125 — "feat: attendee & campaign export enhancements"
 *   Parent:  a56f8f6 (state of csvExport.ts BEFORE the merge)
 *   Merge:   1c4a4c1
 *
 * Scope of THIS task file:
 *   Only the two new helpers added to web-src/src/utils/csvExport.ts.
 *   The full PR also touched ExportDialog.tsx, CampaignsTab.tsx,
 *   Registrations.tsx, and RegistrationsTab.tsx are intentionally out
 *   of scope here.
 */

const SOURCE_FILE = `/**
 * CSV export utilities (attendees, campaigns, etc.).
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

const ISSUE_TEXT = `feat: helpers for editable export filenames

The attendee and campaign export dialogs are gaining editable filename
fields, pre-populated as \\\`[event-title]_[YYYY-MM-DD_HH-MM-SS]\\\` and
\\\`[event-title]_campaigns_[YYYY-MM-DD_HH-MM-SS]\\\` respectively. The
dialog code needs two reusable helpers in
\\\`web-src/src/utils/csvExport.ts\\\` (and nothing else in this file
should change):

1. \\\`export function sanitizeFilename(s: string): string\\\`
   - Replaces any character that is NOT \`[a-zA-Z0-9_\\\\-]\` with an
     underscore.
   - Collapses consecutive underscores into a single underscore.
   - Trims leading and trailing underscores.
   - If the result is the empty string, returns the literal
     \\\`'export'\\\` so the download still has a filename stem.

2. \\\`export function exportDatetime(): string\\\`
   - Returns the current datetime formatted as
     \\\`YYYY-MM-DD_HH-MM-SS\\\` (UTC, derived from
     \\\`new Date().toISOString()\\\`).
   - Use string replacement only: replace the 'T' separator with '_',
     replace ':' with '-', and slice off the milliseconds + 'Z' tail.

Both helpers should be added at the bottom of the file. Do NOT touch
the existing \\\`escapeCsvValue\\\`, \\\`generateCsv\\\`, or
\\\`downloadCsv\\\` exports, and do NOT add new imports.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/utils/csvExport.ts
+++ b/web-src/src/utils/csvExport.ts
@@ -38,3 +38,23 @@ export function downloadCsv(csvContent: string, filename: string): void {
   document.body.removeChild(link)
   URL.revokeObjectURL(url)
 }
+
+/**
+ * Sanitizes a string for use as a filename stem.
+ * Replaces spaces and special characters with underscores and collapses runs.
+ */
+export function sanitizeFilename(s: string): string {
+  return (
+    s
+      .replace(/[^a-zA-Z0-9_\\-]/g, '_')
+      .replace(/_+/g, '_')
+      .replace(/^_|_$/g, '') || 'export'
+  )
+}
+
+/**
+ * Returns the current datetime formatted for a filename: YYYY-MM-DD_HH-MM-SS
+ */
+export function exportDatetime(): string {
+  return new Date().toISOString().replace('T', '_').replace(/:/g, '-').slice(0, 19)
+}
`;

export const attendeeExportCsvEnhancements: Task = {
  id: "real-emc-attendee-export-csv-enhancements",
  type: "content",
  podId: "pod-emc-configs",
  asOf: "2026-04-13T14:17:51-07:00",
  tags: ["real-emc", "utility", "configs"],
  prompt: [
    "# Issue",
    ISSUE_TEXT,
    "",
    "# Current source (web-src/src/utils/csvExport.ts, parent commit a56f8f6)",
    "```ts",
    SOURCE_FILE,
    "```",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against `web-src/src/utils/csvExport.ts`. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: [
    "sanitizeFilename",
    "exportDatetime",
    "toISOString",
  ],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #125, merge SHA 1c4a4c1. Parent file at a56f8f6. (Other files in this PR (Registrations/ExportDialog.tsx, RegistrationsTab.tsx, Registrations.tsx, CampaignsTab.tsx) are intentionally out of scope here.)",
  },
  rubric: {
    id: "real-emc-attendee-export-csv-enhancements-v1",
    criteria: [
      {
        id: "adds_sanitize_filename_export",
        description:
          "Does the patch add a new exported function `sanitizeFilename(s: string): string`? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "sanitize_filename_behavior",
        description:
          "Does sanitizeFilename do all three transformations: (a) replace characters outside [a-zA-Z0-9_-] with underscore, (b) collapse consecutive underscores, (c) trim leading/trailing underscores; AND fall back to the literal 'export' when the result is empty? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "adds_export_datetime_export",
        description:
          "Does the patch add a new exported function `exportDatetime(): string`? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "export_datetime_format",
        description:
          "Does exportDatetime produce a YYYY-MM-DD_HH-MM-SS shape from new Date().toISOString() by replacing 'T' with '_', replacing ':' with '-', and slicing off the trailing milliseconds + 'Z'? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "preserves_existing_exports",
        description:
          "Does the patch leave escapeCsvValue, generateCsv, downloadCsv, and the CsvColumn interface untouched (no removed or modified lines in those exports)? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "no_new_imports",
        description:
          "Does the patch avoid adding new import lines (the helpers can be written entirely with standard string and Date methods)? Boolean.",
        scale: "boolean",
        weight: 1,
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
