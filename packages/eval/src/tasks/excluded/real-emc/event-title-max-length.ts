import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #141 — "MWPW-194235: Raise Event Title and EN Title max length to 150"
 *   Parent:  e7a6de425c7b3628c2d6febcff2d36de353633e1 (state of EventInfoComponent.tsx BEFORE the merge)
 *   Merge:   f6c57a868e5709c61202a8a02611758220225971
 *
 * Why this PR was chosen as a "saturated" sanity check:
 *   - The PR body literally tells you the answer: raise localized Event Title from
 *     80 to 150 chars and apply the same cap to the EN title (previously uncapped).
 *   - Both arms (control and PIM) should pass; this proves PIM doesn't break
 *     trivial cases where the issue text is fully self-specifying.
 */

const SOURCE_FILE = `// EventInfoComponent.tsx — relevant excerpts at parent e7a6de4

const TIMEZONE_OPTIONS = getTimeZones().map((tz) => ({
  id: tz.name,
  name: \`\${tz.name} (\${tz.currentTimeFormat})\`
}))

/**
 * EventInfoComponent - Manages core event information
 */
export const EventInfoComponent: React.FC = () => {
  // ...context, formData destructure, locale-switch dialog omitted for brevity...

  return (
    <>
      {/* ...locale-switch DialogTrigger / AlertDialog omitted... */}
      <TextField
        data-testid="event-title-input"
        label="Event Title"
        isRequired
        maxLength={80}
        value={name}
        onChange={handleNameChange}
        description="80 characters max"
        styles={style({ width: '[100%]' })}
      />
      <div style={{ width: '100%' }}>
        <div className={style({display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8})}>
          <Text>English title for page URL</Text>
          <TooltipTrigger delay={0}>
            <ActionButton isQuiet><InfoCircle /></ActionButton>
            <Tooltip>SEO friendly title</Tooltip>
          </TooltipTrigger>
        </div>
        <TextField
          data-testid="event-en-title-input"
          aria-label="English title for page URL"
          value={enTitle || ''}
          onChange={(value) => updateFormData({ enTitle: value })}
          styles={style({ width: '[100%]' })}
        />
      </div>
      {/* ...rest of form (description, dates, timezone, etc.) omitted... */}
    </>
  )
}
`;

const ISSUE_TEXT = `MWPW-194235: Raise Event Title and EN Title max length to 150

Increase localized Event Title max length from 80 to 150 characters.
Apply the same 150-character limit to the English title for page URL
field (previously uncapped in the UI). Resolves MWPW-194235.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/pages/EventForm/EventInfoComponent.tsx
+++ b/web-src/src/pages/EventForm/EventInfoComponent.tsx
@@ -122,6 +122,8 @@ const TIMEZONE_OPTIONS = getTimeZones().map((tz) => ({
   name: \`\${tz.name} (\${tz.currentTimeFormat})\`
 }))

+const EVENT_TITLE_MAX_LENGTH = 150
+
 /**
  * EventInfoComponent - Manages core event information
  *
@@ -336,10 +338,10 @@ export const EventInfoComponent: React.FC = () => {
         data-testid="event-title-input"
         label="Event Title"
         isRequired
-        maxLength={80}
+        maxLength={EVENT_TITLE_MAX_LENGTH}
         value={name}
         onChange={handleNameChange}
-        description="80 characters max"
+        description={\`\${EVENT_TITLE_MAX_LENGTH} characters max\`}
         styles={style({ width: '[100%]' })}
       />
       <div style={{ width: '100%' }}>
@@ -357,8 +359,10 @@ export const EventInfoComponent: React.FC = () => {
         <TextField
           data-testid="event-en-title-input"
           aria-label="English title for page URL"
+          maxLength={EVENT_TITLE_MAX_LENGTH}
           value={enTitle || ''}
           onChange={(value) => updateFormData({ enTitle: value })}
+          description={\`\${EVENT_TITLE_MAX_LENGTH} characters max\`}
           styles={style({ width: '[100%]' })}
         />
       </div>
`;

export const eventTitleMaxLength: Task = {
  id: "real-emc-event-title-max-length",
  type: "content",
  // pod-emc-sessions owns Event/Session form work in the EMC eval fixtures.
  podId: "pod-emc-sessions",
  tags: ["real-emc", "saturated", "form", "validation"],
  prompt: [
    "# Issue",
    ISSUE_TEXT,
    "",
    "# Current source (web-src/src/pages/EventForm/EventInfoComponent.tsx, parent commit e7a6de4)",
    "```tsx",
    SOURCE_FILE,
    "```",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against `web-src/src/pages/EventForm/EventInfoComponent.tsx` that raises the Event Title cap to 150 and applies the same cap to the English-title field. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: ["150", "maxLength", "enTitle", "EVENT_TITLE_MAX_LENGTH"],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #141, merge SHA f6c57a8. Parent file at e7a6de4.",
  },
  rubric: {
    id: "real-emc-event-title-max-length-v1",
    criteria: [
      {
        id: "raises_event_title_max_length",
        description:
          "Does the diff change the existing maxLength on the Event Title TextField from 80 to 150 (or a named constant equal to 150)? Score 0-5: 0=unchanged, 5=clearly raised to 150.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "adds_maxlength_to_en_title",
        description:
          "Does the diff add maxLength=150 (or a named constant) to the second TextField (data-testid=\"event-en-title-input\", the English title for page URL) which was previously uncapped? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "updates_description_text",
        description:
          "Does the diff also update the visible description string for the Event Title (\"80 characters max\" -> \"150 characters max\") so end users see the new limit? Boolean.",
        scale: "boolean",
        weight: 1,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference patch, does the agent's diff achieve the same behavior (both fields capped at 150, description text aligned) regardless of formatting/constant naming? Score 0-5.",
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
