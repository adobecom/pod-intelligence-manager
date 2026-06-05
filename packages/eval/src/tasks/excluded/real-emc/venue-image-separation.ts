import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #89 — "fix(event-form): separate venue step image from Additional Content venue image"
 *   Parent:  faa66aab190030d8dedd4c44b690ba5a1e959838 (state of VenueComponent.tsx BEFORE the merge)
 *   Merge:   7ed19d238e9e810baf054bf111c6ee3018f482c3
 */

const SOURCE_FILE = `// VenueComponent.tsx — relevant excerpts at parent faa66aa

// ----- onAfterSave: deferred image upload -----
onAfterSave: async (savedEventId: string, _eventResponse: EventApiResponse) => {
  const venueData = formData.venue

  // ========================================================================
  // 1. Upload pending venue image (if any)
  // ========================================================================
  const pendingFile = pendingImageFileRef.current
  if (pendingFile) {
    try {
      const token = apiService.getAuthTokenForExternalUse()
      if (token) {
        const currentEnv = getCurrentEnvironment()
        const host = getApiHost('esp', currentEnv)
        const uploadUrl = \`\${host}/v1/events/\${savedEventId}/images\`

        const config = {
          targetUrl: uploadUrl,
          altText: \`Venue image for \${venueData?.venueName || 'event'}\`,
          type: 'venue-image'
        }

        const result = await uploadImage(pendingFile, config, token)

        if (result.imageUrl && result.imageId) {
          pendingImageFileRef.current = null
          updateFormData({
            venue: {
              ...venueData,
              venueName: venueData?.venueName || '',
              venueImageUrl: result.imageUrl,
              venueImageId: result.imageId
            }
          })
        }
      }
    } catch (error) {
      console.error('Failed to upload venue image:', error)
    }
  }
  // ... continues with venue create-or-update ...
}

// ----- in-component handlers for the venue-step ImageUploader -----

const handleImageChange = (imageUrl: string | undefined, imageId: string | undefined) => {
  // Clear pending file since we now have an uploaded image
  setPendingImageFile(null)
  updateVenueStable({
    venueImageUrl: imageUrl,
    venueImageId: imageId
  })
}

const handleImageRemove = () => {
  // Clear both pending file and uploaded image
  setPendingImageFile(null)
  updateVenueStable({
    venueImageUrl: undefined,
    venueImageId: undefined
  })
}

// ----- ImageUploader JSX inside the venue step -----

<ImageUploader
  label=""
  imageUrl={venue.venueImageUrl}
  imageId={venue.venueImageId}
  imageKind="venue-image"
  altText={\`Venue image for \${venue.venueName}\`}
  eventId={eventId ?? undefined}
  maxSizeMB={25}
  onChange={handleImageChange}
  onRemove={handleImageRemove}
  dropzoneTitle="Add image"
  dropzoneDimensions="File dimensions 1920px wide."
  // Use deferred upload when creating new event (no eventId yet)
  // The image will be uploaded in onAfterSave after event creation
  deferUpload={!eventId}
  onFileSelected={handleImageFileSelected}
  pendingFile={pendingImageFile ?? undefined}
/>
`;

const ISSUE_TEXT = `Separate the venue step image from the Additional Content venue image.

The venue wizard's "Venue image or map" uploader and the Additional Content
"Venue Image" uploader both write to ESP's \`venue-image\` slot, so they
compete for a single event image — saving one overwrites the other.

The venue step must use a distinct ESP image type (\`venue-additional-image\`,
per OpenAPI \`EventImageType\`) and a distinct pair of fields on the form's
\`VenueData\`:

- Rename \`venueImageUrl\` / \`venueImageId\` to \`venueAdditionalImageUrl\` /
  \`venueAdditionalImageId\` on the venue step (handlers, JSX, and the
  deferred-upload \`onAfterSave\` writeback).
- Use \`type: 'venue-additional-image'\` for the deferred upload config and
  \`imageKind="venue-additional-image"\` on the \`<ImageUploader>\`.
- Update the alt text accordingly ("Venue additional image for ...").
- Additional Content continues to use \`venue-image\` (not edited here).`;

const GROUND_TRUTH_PATCH = `--- a/web-src/src/pages/EventForm/VenueComponent.tsx
+++ b/web-src/src/pages/EventForm/VenueComponent.tsx
@@ -78,7 +78,7 @@ export const VenueComponent: React.FC = () => {
       const venueData = formData.venue

       // ========================================================================
-      // 1. Upload pending venue image (if any)
+      // 1. Upload pending venue additional image (ESP venue-additional-image)
       // ========================================================================
       const pendingFile = pendingImageFileRef.current
       if (pendingFile) {
@@ -91,8 +91,8 @@ export const VenueComponent: React.FC = () => {

             const config = {
               targetUrl: uploadUrl,
-              altText: \`Venue image for \${venueData?.venueName || 'event'}\`,
-              type: 'venue-image'
+              altText: \`Venue additional image for \${venueData?.venueName || 'event'}\`,
+              type: 'venue-additional-image'
             }

             const result = await uploadImage(pendingFile, config, token)
@@ -103,8 +103,8 @@ export const VenueComponent: React.FC = () => {
                 venue: {
                   ...venueData,
                   venueName: venueData?.venueName || '',
-                  venueImageUrl: result.imageUrl,
-                  venueImageId: result.imageId
+                  venueAdditionalImageUrl: result.imageUrl,
+                  venueAdditionalImageId: result.imageId
                 }
               })
             }
@@ -515,8 +515,8 @@ export const VenueComponent: React.FC = () => {
     // Clear pending file since we now have an uploaded image
     setPendingImageFile(null)
     updateVenueStable({
-      venueImageUrl: imageUrl,
-      venueImageId: imageId
+      venueAdditionalImageUrl: imageUrl,
+      venueAdditionalImageId: imageId
     })
   }

@@ -524,8 +524,8 @@ export const VenueComponent: React.FC = () => {
     // Clear both pending file and uploaded image
     setPendingImageFile(null)
     updateVenueStable({
-      venueImageUrl: undefined,
-      venueImageId: undefined
+      venueAdditionalImageUrl: undefined,
+      venueAdditionalImageId: undefined
     })
   }

@@ -680,10 +680,10 @@ export const VenueComponent: React.FC = () => {

         <ImageUploader
           label=""
-          imageUrl={venue.venueImageUrl}
-          imageId={venue.venueImageId}
-          imageKind="venue-image"
-          altText={\`Venue image for \${venue.venueName}\`}
+          imageUrl={venue.venueAdditionalImageUrl}
+          imageId={venue.venueAdditionalImageId}
+          imageKind="venue-additional-image"
+          altText={\`Venue additional image for \${venue.venueName}\`}
           eventId={eventId ?? undefined}
           maxSizeMB={25}
           onChange={handleImageChange}
`;

export const venueImageSeparation: Task = {
  id: "real-emc-venue-image-separation",
  type: "content",
  podId: "pod-emc-sessions",
  asOf: "2026-03-30T16:30:06-07:00",
  tags: ["real-emc", "venue", "image-upload", "esp-contract"],
  prompt: [
    "# Issue",
    ISSUE_TEXT,
    "",
    "# Current source (web-src/src/pages/EventForm/VenueComponent.tsx, parent commit faa66aa)",
    "```tsx",
    SOURCE_FILE,
    "```",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) against `web-src/src/pages/EventForm/VenueComponent.tsx`. No prose, no full-file rewrite.",
  ].join("\n"),
  expectedSignals: [
    "venue-additional-image",
    "venueAdditionalImageUrl",
    "venueAdditionalImageId",
    "imageKind",
    "uploadImage",
  ],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #89, merge SHA 7ed19d2. Parent file at faa66aa.",
  },
  rubric: {
    id: "real-emc-venue-image-separation-v1",
    criteria: [
      {
        id: "renames_form_fields",
        description:
          "Does the patch rename `venueImageUrl` / `venueImageId` to `venueAdditionalImageUrl` / `venueAdditionalImageId` everywhere on the venue step (deferred-upload writeback, `handleImageChange`, `handleImageRemove`, and the `<ImageUploader>` props)? Score 0-5 by coverage.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "uses_new_esp_image_type",
        description:
          "Does the patch use `type: 'venue-additional-image'` in the deferred upload `config` and `imageKind=\"venue-additional-image\"` on the `<ImageUploader>` (replacing the previous `'venue-image'`)? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "updates_alt_text",
        description:
          "Does the patch update the alt text strings (deferred upload `altText` and the `<ImageUploader>` `altText`) to reflect the new \"venue additional image\" naming? Boolean.",
        scale: "boolean",
        weight: 1,
      },
      {
        id: "edits_all_three_call_sites",
        description:
          "Does the patch touch ALL the relevant call sites: the `onAfterSave` deferred-upload block, the two handler functions (`handleImageChange` + `handleImageRemove`), and the `<ImageUploader>` JSX? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "no_additional_content_change",
        description:
          "Does the patch leave the Additional Content section's `venue-image` usage alone (the issue says Additional Content continues to use `venue-image`)? Boolean.",
        scale: "boolean",
        weight: 1,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference patch, does the agent's diff achieve the same effect regardless of exact formatting? Score 0-5.",
        scale: "0-5",
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
