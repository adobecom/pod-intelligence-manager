import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #114 — "[HOTFIX] Fix event form speaker role display (speakerType mapping + hydration)"
 *   Parent:  5bf9313fe73e5355d9f9fcc58f5861424cb26b39 (state of eventFormMappers.ts BEFORE the merge)
 *   Merge:   3e449eb02cb9a585abf10765f54bb0b9d7f87bae
 */

const SOURCE_FILE = `/*
 * Event form data mappers for API response <-> form state
 * Extracted for reuse when switching locale and re-mapping form data
 */

import {
  EventFormData,
  ProfileData,
  SponsorData,
  EventApiResponse,
  SeriesSpeaker,
} from '../types/domain'
import { getLanguageKeyFromLocale } from '../config/localeMapping'
import { fromApiSocialLink } from './socialPlatformDetector'

/**
 * Check if a speaker has localized content (at least title) for the given locale.
 * Requires explicit localizations[locale].title — no fallback to top-level title.
 */
export function speakerHasLocalization(speaker: SeriesSpeaker, locale: string): boolean {
  const loc = speaker.localizations?.[locale]
  return !!(loc?.title && String(loc.title).trim())
}

/**
 * Get a localized value from an object, falling back to direct property
 */
export function getLocalizedValue(obj: any, fieldName: string, locale: string): any {
  const localized = obj?.localizations?.[locale]?.[fieldName]
  if (localized !== undefined && localized !== null && localized !== '') {
    return localized
  }
  return obj?.[fieldName]
}

/**
 * Map API speaker data to ProfileData format
 */
export function mapSpeakersToProfiles(speakers: any[], locale: string = 'en-US'): ProfileData[] {
  return speakers.map(speaker => ({
    type: speaker.speakerType === 'host' ? 'host' : 'speaker',
    speakerId: speaker.speakerId,
    firstName: getLocalizedValue(speaker, 'firstName', locale) || speaker.firstName || '',
    lastName: getLocalizedValue(speaker, 'lastName', locale) || speaker.lastName || '',
    title: getLocalizedValue(speaker, 'title', locale) || speaker.title || '',
    bio: getLocalizedValue(speaker, 'bio', locale) || speaker.bio || '',
    imageUrl: speaker.photo?.imageUrl || speaker.imageUrl || '',
    imageId: speaker.photo?.imageId || speaker.imageId || '',
    socialLinks: (speaker.socialLinks || []).map((link: any) => fromApiSocialLink(link)),
    isSaved: true,
    isFromSeries: true
  }))
}
`;

const ISSUE_TEXT = `Fix event form Speakers step "Role" values when editing an existing event.

ESP sends \`speakerType\` in PascalCase per the OpenAPI spec (e.g. "Host",
"GuestSpeaker", "PortfolioReviewer"), but the form's SpeakerType Picker
uses kebab-case keys ("host", "guest-speaker", "portfolio-reviewer").
\`mapSpeakersToProfiles\` currently compares to lowercase 'host' and falls
through to 'speaker' for everything else, so every non-host role displays
as "Speaker".

Add an \`apiSpeakerTypeToFormSpeakerType\` helper that maps every supported
PascalCase value (and accepts legacy lowercase / kebab-case inputs) to the
form's SpeakerType. Unknown / empty values default to 'speaker'. Use it
inside \`mapSpeakersToProfiles\` instead of the inline ternary.

Supported types: Host, Presenter, Speaker, GuestSpeaker, Keynote, Judge,
PortfolioReviewer, CareerAdvisor, ProductDemonstrator.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/utils/eventFormMappers.ts
+++ b/web-src/src/utils/eventFormMappers.ts
@@ -9,6 +9,7 @@ import {
   SponsorData,
   EventApiResponse,
   SeriesSpeaker,
+  SpeakerType,
 } from '../types/domain'
 import { getLanguageKeyFromLocale } from '../config/localeMapping'
 import { fromApiSocialLink } from './socialPlatformDetector'
@@ -33,12 +34,42 @@ export function getLocalizedValue(obj: any, fieldName: string, locale: string):
   return obj?.[fieldName]
 }

+/**
+ * Map ESP event speakerType (PascalCase per OpenAPI) to form ProfileData SpeakerType (kebab-case Picker keys).
+ * Accepts lowercase legacy values. Unknown values default to 'speaker'.
+ */
+export function apiSpeakerTypeToFormSpeakerType(apiType: string | undefined | null): SpeakerType {
+  if (apiType == null || apiType === '') return 'speaker'
+  const key = String(apiType).trim()
+  const map: Record<string, SpeakerType> = {
+    Host: 'host',
+    Presenter: 'presenter',
+    Speaker: 'speaker',
+    GuestSpeaker: 'guest-speaker',
+    Keynote: 'keynote',
+    Judge: 'judge',
+    PortfolioReviewer: 'portfolio-reviewer',
+    CareerAdvisor: 'career-advisor',
+    ProductDemonstrator: 'product-demonstrator',
+    host: 'host',
+    presenter: 'presenter',
+    speaker: 'speaker',
+    'guest-speaker': 'guest-speaker',
+    keynote: 'keynote',
+    judge: 'judge',
+    'portfolio-reviewer': 'portfolio-reviewer',
+    'career-advisor': 'career-advisor',
+    'product-demonstrator': 'product-demonstrator',
+  }
+  return map[key] ?? 'speaker'
+}
+
 /**
  * Map API speaker data to ProfileData format
  */
 export function mapSpeakersToProfiles(speakers: any[], locale: string = 'en-US'): ProfileData[] {
   return speakers.map(speaker => ({
-    type: speaker.speakerType === 'host' ? 'host' : 'speaker',
+    type: apiSpeakerTypeToFormSpeakerType(speaker.speakerType),
     speakerId: speaker.speakerId,
     firstName: getLocalizedValue(speaker, 'firstName', locale) || speaker.firstName || '',
     lastName: getLocalizedValue(speaker, 'lastName', locale) || speaker.lastName || '',
`;

export const speakerTypeMappingHotfix: Task = {
  id: "real-emc-speaker-type-mapping-hotfix",
  type: "content",
  podId: "pod-emc-sessions",
  asOf: "2026-04-02T12:32:42-07:00",
  tags: ["real-emc", "speakers", "form-mapping", "esp-contract"],
  // Re-tiered to realistic-ticket (#8): exact helper name + nine-type mapping table + pasted source removed.
  prompt: [
    "# Issue",
    "Fix event form Speakers step \"Role\" values when editing an existing event.",
    "",
    "ESP returns `speakerType` in PascalCase per the OpenAPI spec (e.g. \"Host\",",
    "\"GuestSpeaker\", \"PortfolioReviewer\"), but the form's SpeakerType Picker uses",
    "kebab-case keys (\"host\", \"guest-speaker\", \"portfolio-reviewer\"). The mapper that",
    "builds the form's speaker rows only special-cases \"host\" and falls through to",
    "\"speaker\" for everything else, so every non-host role shows up as \"Speaker\".",
    "",
    "Map the API speakerType values onto the form's SpeakerType keys correctly for all",
    "supported roles, tolerate legacy lowercase/kebab-case inputs, and fall back to",
    "'speaker' for anything unknown or empty.",
    "",
    "The mapper is in `web-src/src/utils/eventFormMappers.ts`.",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against `web-src/src/utils/eventFormMappers.ts`. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: [
    "apiSpeakerTypeToFormSpeakerType",
    "SpeakerType",
    "GuestSpeaker",
    "guest-speaker",
    "PortfolioReviewer",
    "portfolio-reviewer",
    "mapSpeakersToProfiles",
  ],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #114, merge SHA 3e449eb. Parent file at 5bf9313.",
  },
  rubric: {
    id: "real-emc-speaker-type-mapping-hotfix-v1",
    criteria: [
      {
        id: "introduces_mapping_helper",
        description:
          "Does the patch introduce a new function (e.g., `apiSpeakerTypeToFormSpeakerType`) that converts the API speakerType string into the form's SpeakerType? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "imports_speaker_type_from_domain",
        description:
          "Does the patch add `SpeakerType` to the import from `../types/domain` so the helper's return type is the union (not `string`)? Boolean.",
        scale: "boolean",
        weight: 1,
      },
      {
        id: "covers_pascalcase_inputs",
        description:
          "Does the mapping cover all PascalCase ESP inputs (Host, Presenter, Speaker, GuestSpeaker, Keynote, Judge, PortfolioReviewer, CareerAdvisor, ProductDemonstrator) and map them to the kebab-case Picker keys? Score 0-5 by coverage (0=only Host/Speaker, 5=all nine present).",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "accepts_legacy_lowercase",
        description:
          "Does the helper also accept legacy lowercase / kebab-case values (e.g., 'host', 'guest-speaker') so existing fixtures continue to map correctly? Boolean.",
        scale: "boolean",
        weight: 1,
      },
      {
        id: "default_and_nullish_handling",
        description:
          "Does the helper safely handle null/undefined/empty/unknown inputs by defaulting to 'speaker'? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "replaces_inline_ternary",
        description:
          "Does `mapSpeakersToProfiles` replace the `speaker.speakerType === 'host' ? 'host' : 'speaker'` ternary with a call to the new helper? Boolean.",
        scale: "boolean",
        weight: 1.5,
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
