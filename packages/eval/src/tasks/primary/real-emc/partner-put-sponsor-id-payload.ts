import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #92 — "fix(event-form): partner update sends sponsorId in PUT body"
 *   Parent:  f5db523f36ba8c1bf9807b7bc8dce132073a9e6a (state of payloadBuilders.ts BEFORE the merge)
 *   Merge:   bba1f6a56f4c35725870afa93dd686a732fcfb9b
 */

const SOURCE_FILE = `// payloadBuilders.ts — relevant excerpts at parent f5db523

// ============================================================================
// SPONSOR PAYLOAD BUILDER
// ============================================================================

/**
 * Build a sponsor payload for API submission
 *
 * This is async because it needs to fetch existing sponsor data to properly
 * merge localizations when updating an existing sponsor.
 *
 * @param sponsorData - The sponsor data from the form
 * @param locale - The current locale
 * @param seriesId - The series ID (sponsors belong to a series)
 * @returns The payload ready for API submission
 */
export async function getSponsorPayload(
  sponsorData: Record<string, any>,
  locale: string,
  seriesId: string
): Promise<Record<string, any>> {
  if (!sponsorData) return sponsorData

  // Fetch existing sponsor data to preserve other locale's localizations
  let existingSponsorPayload: Record<string, any> = {}
  if (sponsorData.sponsorId) {
    const result = await cachedApi.getSponsor(seriesId, sponsorData.sponsorId)
    if (!('error' in result)) {
      existingSponsorPayload = result
    }
  }

  // Split sponsor data into localizable and non-localizable fields
  const { localizableFields, nonLocalizableFields } = splitLocalizableFields(
    sponsorData,
    SPONSOR_DATA_FILTER,
    locale
  )

  // Filter to only submittable non-localizable fields
  const filteredGlobalPayload = Object.entries(nonLocalizableFields).reduce((acc, [key, value]) => {
    if (SPONSOR_DATA_FILTER[key]?.submittable && isValidAttribute(value)) {
      acc[key] = value
    }
    return acc
  }, {} as Record<string, any>)

  // Filter to only submittable localizable fields
  const filteredLocalePayload = Object.entries(localizableFields).reduce((acc, [key, value]) => {
    if (SPONSOR_DATA_FILTER[key]?.submittable && isValidAttribute(value)) {
      acc[key] = value
    }
    return acc
  }, {} as Record<string, any>)

  // Merge with existing localizations (preserves other locales)
  return {
    ...filteredGlobalPayload,
    localizations: {
      ...existingSponsorPayload.localizations,
      [locale]: filteredLocalePayload,
    },
  }
}
`;

const ISSUE_TEXT = `Series sponsor (partner) updates from the event form return 400 because
ESP's SponsorUpdateBody requires \`sponsorId\` and \`modificationTime\` in the
JSON body, not only in the URL.

\`getSponsorPayload\` currently returns just
\`{ ...filteredGlobalPayload, localizations: { ...existing, [locale]: filteredLocalePayload } }\`
without setting \`sponsorId\` or \`modificationTime\`, so PUTs fail validation.

A second bug: \`{ [locale]: filteredLocalePayload }\` overwrites the current
locale slice with an empty object when the user only edits non-localized
fields (name, link). The current locale's existing fields should be
preserved and patched.

Required behavior:
- When \`sponsorData.sponsorId\` is present, set \`sponsorId\` on the returned
  payload (this is an update) and backfill \`modificationTime\` from the
  existing sponsor when the form didn't provide one.
- For the current locale, merge \`filteredLocalePayload\` on top of the
  existing locale slice. Only add the locale key when there is actually
  localized data to write (don't add empty objects).
- Only include a \`localizations\` field on the output when the merged
  localizations map is non-empty.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/services/payloadBuilders.ts
+++ b/web-src/src/services/payloadBuilders.ts
@@ -141,13 +141,35 @@ export async function getSponsorPayload(
     return acc
   }, {} as Record<string, any>)

-  // Merge with existing localizations (preserves other locales)
-  return {
+  // Preserve existing locale slices; only patch current locale when there is localized data.
+  // Applying [locale]: {} would wipe that locale's fields when only name/link change.
+  const localizations: Record<string, any> = {
+    ...(existingSponsorPayload.localizations || {}),
+  }
+  if (Object.keys(filteredLocalePayload).length > 0) {
+    localizations[locale] = {
+      ...(existingSponsorPayload.localizations?.[locale] || {}),
+      ...filteredLocalePayload,
+    }
+  }
+
+  const merged: Record<string, any> = {
     ...filteredGlobalPayload,
-    localizations: {
-      ...existingSponsorPayload.localizations,
-      [locale]: filteredLocalePayload
-    },
   }
+  if (Object.keys(localizations).length > 0) {
+    merged.localizations = localizations
+  }
+
+  // SponsorUpdateBody (OpenAPI): Sponsor requires sponsorId + modificationTime in the body
+  if (sponsorData.sponsorId) {
+    merged.sponsorId = sponsorData.sponsorId
+    const modTime =
+      merged.modificationTime ?? existingSponsorPayload.modificationTime
+    if (modTime != null) {
+      merged.modificationTime = modTime
+    }
+  }
+
+  return merged
 }
`;

export const partnerPutSponsorIdPayload: Task = {
  id: "real-emc-partner-put-sponsor-id-payload",
  type: "content",
  podId: "pod-emc-sessions",
  asOf: "2026-03-30T21:55:20-07:00",
  tags: ["real-emc", "sponsors", "payload-builder", "esp-contract"],
  // Re-tiered to realistic-ticket (#8): "Required behavior" algorithm + pasted source removed.
  prompt: [
    "# Issue",
    "Series sponsor (partner) updates from the event form return 400.",
    "",
    "ESP's SponsorUpdateBody requires `sponsorId` and `modificationTime` in the JSON",
    "body (not just in the URL), but `getSponsorPayload` doesn't put them there on an",
    "update, so PUTs fail validation.",
    "",
    "There's also a data-loss bug: when the user edits only non-localized fields (name,",
    "link), the current locale's existing localized fields get wiped instead of",
    "preserved.",
    "",
    "Fix `getSponsorPayload` so sponsor updates validate and existing localizations are",
    "preserved/patched rather than clobbered. The builder lives in",
    "`web-src/src/services/payloadBuilders.ts`.",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against `web-src/src/services/payloadBuilders.ts`. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: [
    "sponsorId",
    "modificationTime",
    "existingSponsorPayload",
    "filteredLocalePayload",
    "localizations",
  ],
  kgExpectations: {
    requiredFacts: [
      "modificationTime for optimistic concurrency on PUT",
      "construct narrow association payloads",
    ],
    requiredSymbols: ["sponsorId", "modificationTime"],
  },
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #92, merge SHA bba1f6a. Parent file at f5db523.",
  },
  rubric: {
    id: "real-emc-partner-put-sponsor-id-payload-v1",
    criteria: [
      {
        id: "sets_sponsor_id_on_update",
        description:
          "Does the patch set `sponsorId` on the returned payload when `sponsorData.sponsorId` is present (so ESP's SponsorUpdateBody validation passes on PUT)? Boolean.",
        scale: "boolean",
        weight: 2,
      },
      {
        id: "backfills_modification_time",
        description:
          "Does the patch include `modificationTime` on the output, sourcing it from the form data when present and falling back to the existing sponsor's `modificationTime`? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "merges_current_locale_slice",
        description:
          "Does the patch merge `filteredLocalePayload` on top of the existing locale slice (e.g., `{ ...existing.localizations?.[locale], ...filteredLocalePayload }`) instead of replacing it wholesale? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "avoids_empty_locale_overwrite",
        description:
          "Does the patch avoid writing `[locale]: {}` when there is no localized data this submit (i.e., only adds the locale entry when `filteredLocalePayload` has at least one key)? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "omits_empty_localizations_field",
        description:
          "Does the patch only include the `localizations` field on the output when the merged map is non-empty? Boolean.",
        scale: "boolean",
        weight: 1,
      },
      {
        id: "preserves_other_locales",
        description:
          "Does the patch keep the existing behavior of preserving all other locales from `existingSponsorPayload.localizations`? Boolean.",
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
