import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #100 — "fix(event-form): hide Marketo integration for webinars"
 *   Parent:  af74118 (state of eventTypeConfig.ts BEFORE the merge)
 *   Merge:   a693ca5
 *
 * Why this PR was chosen:
 *   - One-line config-table edit. The challenge is NOT mechanical: the agent
 *     has to flip the right row (webinar, not in-person) and resist the urge
 *     to refactor the whole config or add new feature flags.
 *   - Tests scoped surgical edits in declarative configuration.
 */

const SOURCE_FILE = `export const EVENT_TYPE_CONFIG: Record<EventType, EventTypeFeatures> = {
  'in-person': {
    label: 'In-Person Event',
    description: 'Physical event at a venue location',
    hasVenue: true,
    hasPageMetadata: true,
    hasMarketoIntegration: true,
    hasPhysicalCapacity: true,
    hasVirtualCapacity: false,
    hasOnDemandRecording: false,
    hasWebinarPlatformSettings: false,
  },
  'webinar': {
    label: 'Webinar',
    description: 'Virtual event streamed online',
    hasVenue: false,
    hasPageMetadata: true,
    hasMarketoIntegration: true,
    hasPhysicalCapacity: false,
    hasVirtualCapacity: true,
    hasOnDemandRecording: true,
    hasWebinarPlatformSettings: true,
  },
}
`;

const ISSUE_TEXT = `fix(event-form): hide Marketo integration for webinars

The Marketo integration card (DX regions, Salesforce campaign ID, etc.)
is intended only for Experience Cloud IN-PERSON events. Webinars
incorrectly show the card when the series cloud is Experience Cloud
because EVENT_TYPE_CONFIG enables \`hasMarketoIntegration\` for both
event types.

useEventFeatureFlags already gates the card on Experience Cloud; with
this config-level fix, webinars will no longer show it on either cloud.

The in-person config must continue to enable Marketo integration.

Out of scope: RSVP registration type "Marketo" / form URL in the
registration step (separate product surface).`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/config/eventTypeConfig.ts
+++ b/web-src/src/config/eventTypeConfig.ts
@@ -52,7 +52,7 @@ export const EVENT_TYPE_CONFIG: Record<EventType, EventTypeFeatures> = {
     description: 'Virtual event streamed online',
     hasVenue: false,
     hasPageMetadata: true,
-    hasMarketoIntegration: true,
+    hasMarketoIntegration: false,
     hasPhysicalCapacity: false,
     hasVirtualCapacity: true,
     hasOnDemandRecording: true,
`;

export const eventTypeConfigHideMarketoWebinar: Task = {
  id: "real-emc-event-type-config-hide-marketo-webinar",
  type: "content",
  podId: "pod-emc-configs",
  asOf: "2026-04-01T11:27:21-07:00",
  tags: ["real-emc", "config", "feature-flags"],
  prompt: [
    "# Issue",
    ISSUE_TEXT,
    "",
    "# Current source (web-src/src/config/eventTypeConfig.ts, parent commit af74118)",
    "```ts",
    SOURCE_FILE,
    "```",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against `web-src/src/config/eventTypeConfig.ts`. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: ["webinar", "hasMarketoIntegration", "false"],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #100, merge SHA a693ca5. Parent file at af74118.",
  },
  rubric: {
    id: "real-emc-event-type-config-hide-marketo-webinar-v1",
    criteria: [
      {
        id: "flips_webinar_marketo_to_false",
        description:
          "Does the patch change `hasMarketoIntegration: true` to `hasMarketoIntegration: false` INSIDE the `'webinar'` entry of `EVENT_TYPE_CONFIG`? Boolean.",
        scale: "boolean",
        weight: 2,
      },
      {
        id: "leaves_in_person_marketo_true",
        description:
          "Does the patch leave the `'in-person'` entry's `hasMarketoIntegration` set to `true` (i.e., does NOT also flip in-person to false)? Boolean.",
        scale: "boolean",
        weight: 2,
      },
      {
        id: "no_new_flags_or_refactor",
        description:
          "Does the patch avoid adding new keys (e.g., `hasMarketoIntegrationForWebinars`) or refactoring the structure of `EVENT_TYPE_CONFIG`? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "does_not_change_other_webinar_fields",
        description:
          "Does the patch leave the other webinar fields (`hasVenue`, `hasPageMetadata`, `hasVirtualCapacity`, etc.) untouched? Score 0-5: 0=multiple unrelated fields changed, 5=only `hasMarketoIntegration` modified.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference patch, does the agent's diff achieve the same effect regardless of exact formatting? Score 0-5.",
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
