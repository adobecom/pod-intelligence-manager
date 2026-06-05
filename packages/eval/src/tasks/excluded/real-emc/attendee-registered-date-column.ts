import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #139 — "MWPW-194033: Registered Date column on attendee report"
 *   Parent:  bd85c2e (state of AttendeeTableComponent.tsx BEFORE the merge)
 *   Merge:   13fb4ce
 *
 * Scope of THIS task file:
 *   Only the rendering and column-label logic in
 *   web-src/src/pages/Registrations/AttendeeTableComponent.tsx. The
 *   matching changes in types/attendee (which exports the new
 *   formatRegisteredDateMmDdYyyy helper and adds the label/sort
 *   metadata on AttendeeColumnConfig) and the registrations RSVP
 *   config plumbing are intentionally out of scope here.
 */

const SOURCE_FILE = `import React, { useMemo } from 'react'
import type { Attendee, AttendeeColumnConfig } from '../../types/attendee'
import { getAttendeeName } from '../../types/attendee'
import { DataTable, TableColumn } from '../../components/shared'

// ... renderCellValue ...
function renderCellValue(attendee: Attendee, config: AttendeeColumnConfig): React.ReactNode {
  const { key, fallback } = config

  switch (key) {
    case 'name':
      return getAttendeeName(attendee)

    case 'checkedIn':
      return attendee.checkedIn ? 'yes' : 'no'

    case 'registrationStatus':
      return attendee.registrationStatus || fallback || 'registered'

    case 'creationTime':
    case 'modificationTime':
      const timestamp = attendee[key]
      if (timestamp) {
        return new Date(timestamp).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric'
        })
      }
      return fallback || '-'

    default:
      // ... unchanged ...
  }
}

// ... AttendeeTableComponent: column construction ...
    const buildColumn = (config: AttendeeColumnConfig): TableColumn<Attendee> => ({
      key: config.key,
      name: camelToSentenceCase(config.key).toUpperCase(),
      width: config.width || 150,
      sortable: config.sortable !== false,
      render: (item) => renderCellValue(item, config),
      isSticky: config.isSticky
    })
`;

const ISSUE_TEXT = `MWPW-194033: Registered Date column on attendee report

We are adding a "Registered Date" column to the event Registrations
attendee table. The column re-uses the existing \\\`creationTime\\\`
attendee field but renders it as MM/DD/YYYY rather than the localized
"Apr 6, 2026" style the table currently uses.

A new helper \\\`formatRegisteredDateMmDdYyyy(creationTime)\\\` is already
exported from \\\`../../types/attendee\\\` alongside the existing
\\\`getAttendeeName\\\` helper. It returns either a MM/DD/YYYY string or
an empty/falsy value when the timestamp is missing.

In \\\`web-src/src/pages/Registrations/AttendeeTableComponent.tsx\\\`:

1. Import \\\`formatRegisteredDateMmDdYyyy\\\` from the existing
   \\\`../../types/attendee\\\` import (do not add a new import line).
2. In \\\`renderCellValue\\\`, separate the \\\`creationTime\\\` case from
   the \\\`modificationTime\\\` case (they currently fall through to a
   shared block). For \\\`creationTime\\\`, return
   \\\`formatRegisteredDateMmDdYyyy(attendee.creationTime)\\\`, falling
   back to \\\`fallback || '-'\\\` if the helper returns empty.
   Leave \\\`modificationTime\\\` rendering unchanged.
3. In \\\`buildColumn\\\`, the header text should use the configured
   \\\`config.label\\\` (uppercased) when it is a non-empty trimmed
   string; otherwise fall back to the current \\\`camelToSentenceCase\\\`
   behavior. This lets the new column ship a user-facing
   "Registered Date" label without renaming the underlying key.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/pages/Registrations/AttendeeTableComponent.tsx
+++ b/web-src/src/pages/Registrations/AttendeeTableComponent.tsx
@@ -4,7 +4,7 @@

 import React, { useMemo } from 'react'
 import type { Attendee, AttendeeColumnConfig } from '../../types/attendee'
-import { getAttendeeName } from '../../types/attendee'
+import { formatRegisteredDateMmDdYyyy, getAttendeeName } from '../../types/attendee'
 import { DataTable, TableColumn } from '../../components/shared'

 interface AttendeeTableComponentProps {
@@ -41,7 +41,11 @@ function renderCellValue(attendee: Attendee, config: AttendeeColumnConfig): Reac
     case 'registrationStatus':
       return attendee.registrationStatus || fallback || 'registered'

-    case 'creationTime':
+    case 'creationTime': {
+      const formatted = formatRegisteredDateMmDdYyyy(attendee.creationTime)
+      return formatted || fallback || '-'
+    }
+
     case 'modificationTime':
       const timestamp = attendee[key]
       if (timestamp) {
@@ -81,7 +85,10 @@ export const AttendeeTableComponent: React.FC<AttendeeTableComponentProps> = ({

     const buildColumn = (config: AttendeeColumnConfig): TableColumn<Attendee> => ({
       key: config.key,
-      name: camelToSentenceCase(config.key).toUpperCase(),
+      name: (config.label?.trim()
+        ? config.label
+        : camelToSentenceCase(config.key)
+      ).toUpperCase(),
       width: config.width || 150,
       sortable: config.sortable !== false,
       render: (item) => renderCellValue(item, config),
`;

export const attendeeRegisteredDateColumn: Task = {
  id: "real-emc-attendee-registered-date-column",
  type: "content",
  podId: "pod-emc-configs",
  asOf: "2026-05-08T09:30:41-07:00",
  tags: ["real-emc", "ui", "configs"],
  prompt: [
    "# Issue",
    ISSUE_TEXT,
    "",
    "# Current source (web-src/src/pages/Registrations/AttendeeTableComponent.tsx, parent commit bd85c2e)",
    "```tsx",
    SOURCE_FILE,
    "```",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against `web-src/src/pages/Registrations/AttendeeTableComponent.tsx`. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: [
    "formatRegisteredDateMmDdYyyy",
    "creationTime",
    "config.label",
    "camelToSentenceCase",
  ],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #139, merge SHA 13fb4ce. Parent file at bd85c2e. (Other files in this PR (types/attendee, Registrations.tsx, RegistrationsTab.tsx, ExportDialog, RSVP-config plumbing) are intentionally out of scope here.)",
  },
  rubric: {
    id: "real-emc-attendee-registered-date-column-v1",
    criteria: [
      {
        id: "imports_helper_from_existing_module",
        description:
          "Does the patch add formatRegisteredDateMmDdYyyy to the EXISTING import line from '../../types/attendee' (rather than introducing a separate import line, or importing from a wrong path)? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "splits_creation_modification_cases",
        description:
          "Does the patch separate the creationTime case from the modificationTime case so they no longer share the same fall-through block? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "uses_helper_for_creation_time",
        description:
          "Does the new creationTime case call formatRegisteredDateMmDdYyyy(attendee.creationTime) and fall back to fallback || '-' when the helper returns empty? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "preserves_modification_time_rendering",
        description:
          "Is the modificationTime case left rendering through the existing toLocaleDateString block (it must NOT be rewritten to use the new helper)? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "label_overrides_camel_case",
        description:
          "Does buildColumn prefer config.label (trimmed, non-empty) over camelToSentenceCase(config.key) when constructing the column header, and still uppercase the final result? Score 0-5.",
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
      {
        id: "no_invented_formatter",
        description:
          "Does the patch avoid inventing an inline date formatter (e.g., a hand-rolled MM/DD/YYYY printf) instead of calling the existing formatRegisteredDateMmDdYyyy helper? Boolean.",
        scale: "boolean",
        weight: 1,
      },
    ],
  },
};
