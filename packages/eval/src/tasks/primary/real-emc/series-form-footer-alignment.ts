import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #94 — "fix(series): align series form footer with FormWizard action bar"
 *   Parent:  58f01640e65b4f88bd1ddc9add862c59e7285a75
 *   Merge:   c7ee5152a87723da289b82c66ef1222d59090d81
 *
 * Why this PR was chosen:
 *   - Layout-only refactor of the Series form footer to mirror the
 *     multi-step FormWizard action bar: full-width row with
 *     space-between, a non-interactive left spacer sized like the wizard
 *     Back control, right-aligned button cluster, and Publish-then-Save
 *     order. Tests whether the model recognizes the alignment intent and
 *     reorders the buttons without touching unrelated handlers.
 */

const SOURCE_FILE = `// web-src/src/components/shared/SingleStepFormLayout.tsx — renderActionBar at parent 58f0164

  const renderActionBar = () => {
    const getSaveButtonText = () => {
      if (isSaving) return 'Saving...'
      return 'Save'
    }

    const getPublishButtonText = () => {
      if (isSaving) return 'Publishing...'
      return isPublished ? \`Re-\${publishLabel.toLowerCase()}\` : publishLabel
    }

    const isActionDisabled = !isValid || isSaving

    return (
      <div style={FORM_WIZARD_FOOTER_STYLES}>
        <div
          className={style({ display: 'flex', justifyContent: 'end', alignItems: 'center', height: '[100%]', flex: 1 })}
          style={{ marginInlineStart: 'var(--spectrum-global-dimension-size-400)', marginInlineEnd: 'var(--spectrum-global-dimension-size-400)' }}
        >
          <div className={style({ display: 'flex', gap: 8, alignItems: 'center' })}>
            <Button
              variant="secondary"
              fillStyle="outline"
              staticColor="white"
              onPress={handleSave}
              isDisabled={isActionDisabled || !onSave}
            >
              {getSaveButtonText()}
            </Button>
            <Button
              variant="accent"
              fillStyle="fill"
              onPress={handlePublish}
              isDisabled={isActionDisabled}
            >
              <div className={style({ display: 'flex', gap: 4, alignItems: 'center' })} style={{ flexDirection: 'row-reverse' }}>
                <Text>{getPublishButtonText()}</Text>
                <ChevronRight />
              </div>
            </Button>
          </div>
        </div>
      </div>
    )
  }
`;

const ISSUE_TEXT = `fix(series): align series form footer with FormWizard action bar.

The Series form uses SingleStepFormLayout, whose renderActionBar currently
right-aligns its buttons inside a row with only flex: 1. Multi-step events
use FormWizard, whose footer row is full width, justify-content:
space-between, has a non-interactive left spacer sized like the wizard
Back control, and right-clusters the action buttons. We want both flows
to feel identical:

  1. Use the same outer row shell as FormWizard: full-width row,
     justify-content: space-between, the same horizontal margins
     (var(--spectrum-global-dimension-size-400)), boxSizing: border-box,
     and minWidth: 0.
  2. Add a non-interactive left spacer (aria-hidden) the same footprint
     as the wizard Back control
     (size-500 x size-500).
  3. Right cluster: justifyContent: flex-end, gap: size-200, flexWrap:
     wrap, minWidth: 0, flexShrink: 1. Inside it, keep the inner
     8px-gap action group around the buttons.
  4. Button order matches the event wizard: Publish (accent) first,
     Save (secondary) second.

Do not change any handler, prop, or text. Only the markup and style
inside renderActionBar.`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/components/shared/SingleStepFormLayout.tsx
+++ b/web-src/src/components/shared/SingleStepFormLayout.tsx
@@ -233,6 +233,19 @@ export const SingleStepFormLayout: React.FC<SingleStepFormLayoutProps> = ({
     </div>
   )

+  const actionBarRowStyle: React.CSSProperties = {
+    display: 'flex',
+    flexDirection: 'row',
+    alignItems: 'center',
+    justifyContent: 'space-between',
+    width: '100%',
+    minWidth: 0,
+    flex: 1,
+    boxSizing: 'border-box',
+    marginInlineStart: 'var(--spectrum-global-dimension-size-400)',
+    marginInlineEnd: 'var(--spectrum-global-dimension-size-400)',
+  }
+
   const renderActionBar = () => {
     const getSaveButtonText = () => {
       if (isSaving) return 'Saving...'
@@ -248,31 +261,48 @@ export const SingleStepFormLayout: React.FC<SingleStepFormLayoutProps> = ({

     return (
       <div style={FORM_WIZARD_FOOTER_STYLES}>
-        <div
-          className={style({ display: 'flex', justifyContent: 'end', alignItems: 'center', height: '[100%]', flex: 1 })}
-          style={{ marginInlineStart: 'var(--spectrum-global-dimension-size-400)', marginInlineEnd: 'var(--spectrum-global-dimension-size-400)' }}
-        >
-          <div className={style({ display: 'flex', gap: 8, alignItems: 'center' })}>
-            <Button
-              variant="secondary"
-              fillStyle="outline"
-              staticColor="white"
-              onPress={handleSave}
-              isDisabled={isActionDisabled || !onSave}
-            >
-              {getSaveButtonText()}
-            </Button>
-            <Button
-              variant="accent"
-              fillStyle="fill"
-              onPress={handlePublish}
-              isDisabled={isActionDisabled}
-            >
-              <div className={style({ display: 'flex', gap: 4, alignItems: 'center' })} style={{ flexDirection: 'row-reverse' }}>
-                <Text>{getPublishButtonText()}</Text>
-                <ChevronRight />
-              </div>
-            </Button>
+        <div style={actionBarRowStyle}>
+          <div
+            style={{
+              flexShrink: 0,
+              width: 'var(--spectrum-global-dimension-size-500)',
+              height: 'var(--spectrum-global-dimension-size-500)',
+            }}
+            aria-hidden
+          />
+
+          <div
+            className={style({ display: 'flex', alignItems: 'center' })}
+            style={{
+              justifyContent: 'flex-end',
+              flexWrap: 'wrap',
+              gap: 'var(--spectrum-global-dimension-size-200)',
+              minWidth: 0,
+              flexShrink: 1,
+            }}
+          >
+            <div className={style({ display: 'flex', gap: 8, alignItems: 'center' })}>
+              <Button
+                variant="accent"
+                fillStyle="fill"
+                onPress={handlePublish}
+                isDisabled={isActionDisabled}
+              >
+                <div className={style({ display: 'flex', gap: 4, alignItems: 'center' })} style={{ flexDirection: 'row-reverse' }}>
+                  <Text>{getPublishButtonText()}</Text>
+                  <ChevronRight />
+                </div>
+              </Button>
+              <Button
+                variant="secondary"
+                fillStyle="outline"
+                staticColor="white"
+                onPress={handleSave}
+                isDisabled={isActionDisabled || !onSave}
+              >
+                {getSaveButtonText()}
+              </Button>
+            </div>
           </div>
         </div>
       </div>
`;

export const seriesFormFooterAlignment: Task = {
  id: "real-emc-series-form-footer-alignment",
  type: "content",
  podId: "pod-emc-sessions",
  asOf: "2026-03-31T12:37:56-07:00",
  tags: ["real-emc", "ui", "layout", "s2"],
  // Re-tiered to realistic-ticket (#8): exact CSS-token spec + pasted source removed.
  prompt: [
    "# Issue",
    "fix(series): align series form footer with the FormWizard action bar",
    "",
    "The Series form uses SingleStepFormLayout, whose footer just right-aligns its",
    "buttons. Multi-step events use FormWizard, whose footer is a full-width row with a",
    "non-interactive left spacer (same footprint as the wizard's Back control) and a",
    "right-clustered button group, with Publish before Save. The two flows should look",
    "and feel identical.",
    "",
    "Match the Series form footer to the FormWizard action bar's layout and button",
    "order. Only touch the markup/styles in renderActionBar — don't change any handler,",
    "prop, or button text.",
    "",
    "The layout lives in `web-src/src/components/shared/SingleStepFormLayout.tsx`.",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against the SingleStepFormLayout component. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: [
    "space-between",
    "aria-hidden",
    "flex-end",
    "size-500",
    "size-200",
    "variant=\"accent\"",
  ],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #94, merge SHA c7ee515. Parent file at 58f0164.",
  },
  rubric: {
    id: "real-emc-series-form-footer-alignment-v1",
    criteria: [
      {
        id: "outer_row_space_between",
        description:
          "Does the patch replace the existing right-aligned wrapper with a full-width row whose justifyContent is 'space-between' and that keeps the size-400 horizontal margins (matching FormWizard's outer footer row)? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "left_spacer_present",
        description:
          "Does the patch add a non-interactive left spacer (aria-hidden, no onPress, no Button) sized like the wizard Back control (size-500 x size-500 or equivalent fixed size) so the right cluster doesn't shift left? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "right_cluster_flex_end_and_gap",
        description:
          "Does the right cluster use justifyContent: 'flex-end' with the size-200 gap token (matching FormWizard), and keep an inner 8px-gap group around the actual Save/Publish buttons? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "button_order_publish_then_save",
        description:
          "Is the rendered button order Publish (accent) first and Save (secondary) second, matching the event wizard? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "no_handler_or_label_changes",
        description:
          "Does the patch leave handleSave, handlePublish, getSaveButtonText, getPublishButtonText, isActionDisabled, and the button label text unchanged? Boolean.",
        scale: "boolean",
        weight: 1,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference patch, does the agent's diff achieve the same visual layout regardless of formatting (e.g., inline style vs. extracted const)? Score 0-5.",
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
