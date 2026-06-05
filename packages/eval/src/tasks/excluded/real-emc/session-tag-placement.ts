import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #97 — "Tag placement property"
 *   Parent:  f14f843 (state of SessionForm.tsx BEFORE the merge)
 *   Merge:   9aab4a8
 *
 * Why this PR was chosen:
 *   - The wider PR adds a `placement?: 'top' | 'bottom'` prop to TagSelector.
 *     This task scopes to the call-site change in SessionForm.tsx, which is
 *     a 1-line decision: should the session-form tag picker open upward or
 *     downward given the surrounding layout?
 *   - Tests whether the agent can make a small, scoped layout decision (and
 *     not e.g. modify TagSelector itself, which is out of scope for this file).
 */

const SOURCE_FILE = `  // renderTags is invoked near the bottom of the SessionForm body. The
  // tag picker sits below other tall sections (name, description RTE,
  // date/time, attendee limits, speakers), so there is limited room
  // below the field when the form is scrolled into view.

  const renderTags = () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <TagSelector selectedTags={selectedTags} onChange={setSelectedTags} />
    </div>
  );
`;

const ISSUE_TEXT = `Tag placement property — use top placement in SessionForm

TagSelector now accepts an optional \`placement?: 'top' | 'bottom'\`
prop that controls whether the dropdown opens above or below the
search field. The default is 'bottom' for backward compatibility.

In the SessionForm dialog, the tag picker sits near the bottom of a
long form, so the dropdown is frequently clipped when it opens
downward. Update the SessionForm call site so the TagSelector opens
upward.

Do NOT modify TagSelector itself in this task — assume the new
\`placement\` prop is already supported by the component.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/pages/EventForm/SessionManagement/SessionForm.tsx
+++ b/web-src/src/pages/EventForm/SessionManagement/SessionForm.tsx
@@ -516,7 +516,7 @@ export const SessionForm: React.FC<SessionFormProps> = ({

   const renderTags = () => (
     <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
-      <TagSelector selectedTags={selectedTags} onChange={setSelectedTags} />
+      <TagSelector selectedTags={selectedTags} onChange={setSelectedTags} placement="top"/>
     </div>
   );
`;

export const sessionTagPlacement: Task = {
  id: "real-emc-session-tag-placement",
  type: "content",
  podId: "pod-emc-sessions",
  asOf: "2026-03-31T22:27:59-07:00",
  tags: ["real-emc", "ui", "layout"],
  prompt: [
    "# Issue",
    ISSUE_TEXT,
    "",
    "# Current source (web-src/src/pages/EventForm/SessionManagement/SessionForm.tsx, parent commit f14f843)",
    "```tsx",
    SOURCE_FILE,
    "```",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against `web-src/src/pages/EventForm/SessionManagement/SessionForm.tsx`. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: ["placement", "top", "TagSelector"],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #97, merge SHA 9aab4a8. Parent file at f14f843. Scoped to the SessionForm call-site only.",
  },
  rubric: {
    id: "real-emc-session-tag-placement-v1",
    criteria: [
      {
        id: "adds_placement_prop",
        description:
          "Does the patch add a `placement` prop to the `<TagSelector ... />` element inside `renderTags`? Boolean.",
        scale: "boolean",
        weight: 2,
      },
      {
        id: "placement_value_is_top",
        description:
          "Is the `placement` value set to `\"top\"` (not `\"bottom\"`, not omitted, not a dynamic expression)? Boolean.",
        scale: "boolean",
        weight: 2,
      },
      {
        id: "preserves_existing_props",
        description:
          "Does the patch preserve the existing `selectedTags={selectedTags}` and `onChange={setSelectedTags}` props on the element? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "scoped_to_session_form",
        description:
          "Does the patch limit edits to `SessionForm.tsx` and avoid touching `TagSelector` itself (which is out of scope here)? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference patch, does the agent's diff achieve the same effect regardless of exact formatting (self-closing, space before `/>`, etc.)? Score 0-5.",
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
