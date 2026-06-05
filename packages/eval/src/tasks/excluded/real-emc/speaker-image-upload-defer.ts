import type { Task } from "../../types.js";

/**
 * Real EMC PR replayed as an eval task.
 *
 * Provenance:
 *   Repo:    adobecom/EMC (local: /Users/rkhan/emcV2/EMC)
 *   PR:      #109 — "fix(speakers): defer profile image upload outside API payload"
 *   Parent:  367aef166ae0ca97eb8f051632d799565d9598b9
 *   Merge:   558bd50a4ffb7e08a586957e7b5dc9ffe1032957
 *
 * Why this PR was chosen:
 *   - The fix introduces a brand-new helper module
 *     web-src/src/services/speakerImageUpload.ts that uploads the deferred
 *     speaker profile image to ESP *after* the speaker record exists,
 *     keeping File-like fields out of the JSON ESP body. The path mirrors
 *     the existing EventForm sponsor upload pattern and is consumed by
 *     SpeakerFormDialog, SpeakersDashboard, and SpeakerPickerDialog.
 *   - Tests whether the model creates the helper at the correct ESP
 *     endpoint shape (\`/v1/series/{seriesId}/speakers/{speakerId}/images\`)
 *     and returns { imageUrl, imageId } when present.
 */

const SOURCE_FILE = `// File does not yet exist at parent commit 367aef1.
// New file to add at: web-src/src/services/speakerImageUpload.ts
//
// Existing helpers available in the repo (do not redefine):
//   - getCurrentEnvironment, getApiHost from '../config/constants'
//   - apiService.getAuthTokenForExternalUse() from './api'
//   - uploadImage(file, config, token, tracker) from './requestHelpers'
//   - UploadTracker type from './requestHelpers' (shape: { progress: number })
//
// The ESP upload endpoint for a speaker profile image is:
//   POST {host}/v1/series/{seriesId}/speakers/{speakerId}/images
// where host = getApiHost('esp', getCurrentEnvironment()).
//
// uploadImage returns either { image: { imageUrl, imageId } } or
// { imageUrl, imageId } directly depending on the ESP response shape;
// callers normalize via \`result.image || result\`.
`;

const ISSUE_TEXT = `Add a new module web-src/src/services/speakerImageUpload.ts that exports an
async function uploadSpeakerSeriesImage. It uploads a deferred speaker
profile image to ESP *after* the speaker record exists so File objects
never leak into the JSON ESP payload.

Contract:

  export async function uploadSpeakerSeriesImage(
    file: File,
    seriesId: string,
    speakerId: string,
    altText: string,
  ): Promise<{ imageUrl: string; imageId: string } | null>

Behavior:
  - Get the auth token via apiService.getAuthTokenForExternalUse(); if
    missing, throw 'No authentication token available'.
  - Build the upload URL as
    \`\${getApiHost('esp', getCurrentEnvironment())}/v1/series/\${seriesId}/speakers/\${speakerId}/images\`.
  - Construct a config with { targetUrl, altText, type: 'speaker-photo' }
    and a fresh UploadTracker { progress: 0 }.
  - Call uploadImage(file, config, token, tracker). Normalize the response
    with \`result.image || result\`.
  - If both imageUrl and imageId are present on the normalized payload,
    return { imageUrl, imageId }; otherwise return null.
  - Catch any error, console.error it, and return null.

Do not modify any caller in this task — only create the module.`;

const GROUND_TRUTH_PATCH = `--- /dev/null
+++ b/web-src/src/services/speakerImageUpload.ts
@@ -0,0 +1,45 @@
+/*
+* <license header>
+*/
+
+import { getCurrentEnvironment, getApiHost } from '../config/constants'
+import { apiService } from './api'
+import { uploadImage, UploadTracker } from './requestHelpers'
+
+/**
+ * Upload a speaker profile image to ESP after the speaker record exists.
+ * POST .../v1/series/{seriesId}/speakers/{speakerId}/images
+ */
+export async function uploadSpeakerSeriesImage(
+  file: File,
+  seriesId: string,
+  speakerId: string,
+  altText: string
+): Promise<{ imageUrl: string; imageId: string } | null> {
+  try {
+    const token = apiService.getAuthTokenForExternalUse()
+    if (!token) throw new Error('No authentication token available')
+
+    const env = getCurrentEnvironment()
+    const host = getApiHost('esp', env)
+    const uploadUrl = \`\${host}/v1/series/\${seriesId}/speakers/\${speakerId}/images\`
+
+    const tracker: UploadTracker = { progress: 0 }
+    const config = {
+      targetUrl: uploadUrl,
+      altText,
+      type: 'speaker-photo',
+    }
+
+    const result = await uploadImage(file, config, token, tracker)
+    const imageData = result.image || result
+
+    if (imageData.imageUrl && imageData.imageId) {
+      return { imageUrl: imageData.imageUrl, imageId: imageData.imageId }
+    }
+    return null
+  } catch (err) {
+    console.error('Failed to upload speaker image:', err)
+    return null
+  }
+}
`;

export const speakerImageUploadDefer: Task = {
  id: "real-emc-speaker-image-upload-defer",
  type: "content",
  podId: "pod-emc-sessions",
  asOf: "2026-04-02T11:10:44-07:00",
  tags: ["real-emc", "api", "esp", "upload", "new-file"],
  prompt: [
    "# Issue",
    ISSUE_TEXT,
    "",
    "# Current source (web-src/src/services/speakerImageUpload.ts, parent commit 367aef1 — file does not exist yet)",
    "```ts",
    SOURCE_FILE,
    "```",
    "",
    "# Output",
    "Return ONLY a unified diff (--- / +++ / @@) that adds the new file at `web-src/src/services/speakerImageUpload.ts`. No prose, no narrative.",
  ].join("\n"),
  expectedSignals: [
    "uploadSpeakerSeriesImage",
    "getApiHost",
    "uploadImage",
    "speaker-photo",
    "/v1/series/",
    "imageUrl",
    "imageId",
  ],
  groundTruth: {
    output: GROUND_TRUTH_PATCH,
    note: "adobecom/EMC PR #109, merge SHA 558bd50. New file added in this PR.",
  },
  rubric: {
    id: "real-emc-speaker-image-upload-defer-v1",
    criteria: [
      {
        id: "creates_new_file_with_correct_export",
        description:
          "Does the diff create the file at web-src/src/services/speakerImageUpload.ts and export an async function uploadSpeakerSeriesImage with the signature (file, seriesId, speakerId, altText) returning Promise<{ imageUrl, imageId } | null>? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "uses_correct_esp_endpoint",
        description:
          "Does the function build the upload URL as `{host}/v1/series/{seriesId}/speakers/{speakerId}/images` via getApiHost('esp', getCurrentEnvironment()) (not hardcoded, not a different ESP path)? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "reuses_existing_helpers",
        description:
          "Does the function reuse apiService.getAuthTokenForExternalUse(), uploadImage, and UploadTracker from the existing modules ('./api', '../config/constants', './requestHelpers') rather than inventing new helpers or new HTTP plumbing? Score 0-5.",
        scale: "0-5",
        weight: 1.5,
      },
      {
        id: "handles_missing_token_and_errors",
        description:
          "Does the function throw or surface 'No authentication token available' when the token is missing, and catch other errors with console.error + return null (so callers never crash on upload failure)? Boolean.",
        scale: "boolean",
        weight: 1,
      },
      {
        id: "normalizes_response_and_returns_pair",
        description:
          "Does the function normalize the response via `result.image || result` and return { imageUrl, imageId } only when both fields are present (otherwise null)? Boolean.",
        scale: "boolean",
        weight: 1.5,
      },
      {
        id: "matches_ground_truth_intent",
        description:
          "Compared to the reference patch, does the agent's diff achieve the same behavior regardless of cosmetic differences (variable names, comment text)? Score 0-5.",
        scale: "0-5",
        weight: 2,
      },
      {
        id: "valid_unified_diff",
        description:
          "Is the output a parseable unified diff with --- / +++ / @@ headers, proper +/- prefixes, and the `--- /dev/null` form for the new file (not prose)? Boolean.",
        scale: "boolean",
        weight: 1,
      },
    ],
  },
};
