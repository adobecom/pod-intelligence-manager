import type { Stratum, Task } from "./types.js";

/**
 * Stratum and exclusion assignments for the PIM-vs-lic haiku eval.
 *
 * Two-person reviewable: every existing task is listed here with its stratum
 * (S1-S6, S7 is excluded from this eval) and optional `excluded: true` flag
 * for saturated / no-signal tasks.
 *
 * New tasks authored for this eval (S5 library, S6 archaeology) declare
 * stratum inline in their own files and do not appear here.
 *
 * Disagreements about stratum assignment are logged in
 * holdouts/stratum-assignment-notes.md.
 */

interface Assignment {
  stratum?: Stratum;
  excluded?: boolean;
  licSeed?: Task["licSeed"];
  /** S2 worktree-per-asOf needs parentSha. Most existing tasks have it only in
   * a JSDoc comment; this field lifts it onto structured data for the freezer. */
  parentSha?: string;
  /** Merge commit SHA of the source PR. */
  mergeSha?: string;
  /** Source PR / issue URL, if known. */
  sourceUrl?: string;
  reason?: string;
}

function prUrl(pr: number): string {
  return `https://github.com/adobecom/EMC/pull/${pr}`;
}

const ASSIGNMENTS: Record<string, Assignment> = {
  // ─── content-gen (S7 — excluded from headline protocol) ────────────────────
  "rbac-decision-rationale": { stratum: "S7", excluded: true, reason: "S7 content-gen, lic cannot compete" },
  "session-blocker-summary": { stratum: "S7", excluded: true, reason: "S7 content-gen, lic cannot compete" },
  "config-decision-writeup": { stratum: "S7", excluded: true, reason: "S7 content-gen, lic cannot compete" },
  "progress-update-permissions": { stratum: "S7", excluded: true, reason: "S7 content-gen, lic cannot compete" },

  // ─── code-gen synthetic tasks (S1 — single-file, mostly saturated) ────────
  "rbac-permission-resolution": { stratum: "S1", excluded: true, reason: "synthetic code-gen, fully specified in prompt" },
  "rbac-403-fallback": { stratum: "S1", excluded: true, reason: "synthetic code-gen, fully specified in prompt" },
  "session-create-timezone": { stratum: "S1", excluded: true, reason: "synthetic code-gen, fully specified in prompt" },
  "session-render-time": { stratum: "S1", excluded: true, reason: "synthetic code-gen, fully specified in prompt" },
  "config-deep-merge": { stratum: "S1", excluded: true, reason: "synthetic code-gen, fully specified in prompt" },
  "config-cache-bust": { stratum: "S1", excluded: true, reason: "synthetic code-gen, fully specified in prompt" },
  "event-create-rest": { stratum: "S1", excluded: true, reason: "synthetic code-gen, fully specified in prompt" },
  "form-localization": { stratum: "S1", excluded: true, reason: "synthetic code-gen, fully specified in prompt" },

  // ─── real-emc S1 (single-file, low context need) ──────────────────────────
  "real-emc-event-title-max-length": {
    excluded: true,
    reason: "saturated: issue text fully specifies fix (raise from 80 to 150)",
  },
  "real-emc-event-form-route-with-event-id": {
    stratum: "S1",
    parentSha: "d262850fb9ef0bf6503fe0a1c5c24c667803a65e",
    mergeSha: "ccc9e49b399c7592cdf5ec78125ccfcf3397e974",
    sourceUrl: prUrl(152),
    licSeed: { symbol: "eventFormRoute" },
  },
  "real-emc-series-form-footer-alignment": {
    stratum: "S1",
    parentSha: "58f01640e65b4f88bd1ddc9add862c59e7285a75",
    mergeSha: "c7ee5152a87723da289b82c66ef1222d59090d81",
    sourceUrl: prUrl(94),
    licSeed: { symbol: "SeriesFormFooter" },
  },
  "real-emc-datatable-horizontal-edge-scroll": {
    stratum: "S1",
    parentSha: "b2356bd3768cf787026f822578b3c3a6f9110034",
    mergeSha: "72bfb3dec60c4e75ec730ed5f46c6d3ed2efff83",
    sourceUrl: prUrl(112),
    licSeed: { symbol: "DataTable" },
  },
  "real-emc-session-time-no-refresh": {
    stratum: "S1",
    parentSha: "704fb110ac867350e26a3207148b590ad5c6b2a7",
    mergeSha: "19f50a267540edd1ea49e218e3c332e10914347a",
    sourceUrl: prUrl(124),
    licSeed: { symbol: "useSessionTime" },
  },
  "real-emc-detail-page-path-put": {
    stratum: "S1",
    parentSha: "aed893da260263a630f554eeb9c31560f84f46b2",
    mergeSha: "80e5e351c9d4ef7cf6a858dc3efe8e78948af87d",
    sourceUrl: prUrl(119),
    licSeed: { symbol: "detailPagePath" },
  },
  "real-emc-prod-publish-confirmation": {
    stratum: "S1",
    parentSha: "808252410a4c7ee48ebbee109e7db75bf8391eea",
    mergeSha: "04eccca90b7f18df03afe27c17a6d94c5fc7d8b7",
    sourceUrl: prUrl(136),
    licSeed: { symbol: "AlertDialog" },
  },
  "real-emc-session-unsaved-changes-dialog": {
    excluded: true,
    reason: "saturated: standard unsaved-changes dialog pattern",
  },
  "real-emc-attendee-registered-date-column": {
    excluded: true,
    reason: "saturated: add a date column, fully specified",
  },
  "real-emc-attendee-export-csv-enhancements": {
    excluded: true,
    reason: "saturated: utility functions, self-contained",
  },
  "real-emc-campaign-csv-export-helper": {
    excluded: true,
    reason: "saturated: CSV helper, self-contained",
  },

  // ─── real-emc S2 (multi-file refactor, lic-favorable) ───────────────────
  "real-emc-event-mod-time-sync-after-session": {
    stratum: "S2",
    parentSha: "bba1f6a56f4c35725870afa93dd686a732fcfb9b",
    mergeSha: "58f01640e65b4f88bd1ddc9add862c59e7285a75",
    sourceUrl: prUrl(93),
    licSeed: { symbol: "modificationTime", investigateQuery: "event modification time sync after session" },
  },
  "real-emc-series-mod-time-resilience": {
    stratum: "S2",
    excluded: true,
    reason: "too easy/redundant in latest runs: control passed all seeds; keep as diagnostic only",
    parentSha: "925a96cc360d8228917ec85b0ec068c2200c338b",
    mergeSha: "d6078f228013c6cb05cf288356c8a155229d8f72",
    sourceUrl: prUrl(101),
    licSeed: { symbol: "seriesModTime", investigateQuery: "series modification time concurrency" },
  },
  "real-emc-ppn-ack-hydration": {
    stratum: "S2",
    parentSha: "ccc9e49b399c7592cdf5ec78125ccfcf3397e974",
    mergeSha: "84f21c9d968beaaac01eebca2dc1b2cb853a1b68",
    sourceUrl: prUrl(156),
    licSeed: { symbol: "ppnAck", investigateQuery: "PPN acknowledgement hydration" },
  },
  "real-emc-speaker-image-cache-invalidate": {
    stratum: "S2",
    parentSha: "84f21c9d968beaaac01eebca2dc1b2cb853a1b68",
    mergeSha: "0d38019eddcb4e0f63af0a1af69c3891f8460d99",
    sourceUrl: prUrl(158),
    licSeed: { symbol: "speakerImageCache", investigateQuery: "speaker image cache invalidation" },
  },
  "real-emc-session-api-batch-optimisation": {
    stratum: "S2",
    parentSha: "d6078f228013c6cb05cf288356c8a155229d8f72",
    mergeSha: "925a96cc360d8228917ec85b0ec068c2200c338b",
    sourceUrl: prUrl(101),
    licSeed: { symbol: "sessionBatch", investigateQuery: "session API batch optimisation" },
  },
  "real-emc-scope-group-my-filter": {
    stratum: "S2",
    parentSha: "c4c8d9bfc2916fa70d9d39ef56dd44b198c2a2bf",
    mergeSha: "985daa838839219e2b5a94ec839ac5e0ac4edfb8",
    sourceUrl: prUrl(80),
    licSeed: { symbol: "useGroup", investigateQuery: "scope group My filter and refreshGroups" },
  },

  // ─── real-emc S3 (housestyle / convention, PIM-favorable) ─────────────────
  "real-emc-event-speaker-put-contract": {
    stratum: "S3",
    excluded: true,
    reason: "saturated explicit prompt plus known lic HEAD leakage; replaced by synth-event-speaker-put-contract-context",
    parentSha: "5350792c384c2ac8802f78f59c170abdc4975194",
    licSeed: { symbol: "updateSpeakerInEvent", investigateQuery: "ESP PUT contract event speaker" },
  },
  "real-emc-event-put-omit-detail-page-path": {
    stratum: "S3",
    parentSha: "fa650788f2e6dc01794fe98157dec3f98aa30563",
    mergeSha: "367aef166ae0ca97eb8f051632d799565d9598b9",
    sourceUrl: prUrl(107),
    licSeed: { symbol: "updateEvent", investigateQuery: "event PUT omit read-only fields" },
  },
  "real-emc-declined-rsvp-status": {
    stratum: "S3",
    excluded: true,
    reason: "saturated: prompt/source make the answer explicit; control passed all seeds",
    parentSha: "18666bc0f9ec6c51b2185e317d33483bafd42e0c",
    licSeed: { symbol: "rsvpStatus", investigateQuery: "declined RSVP status field" },
  },
  "real-emc-partner-put-sponsor-id-payload": {
    stratum: "S3",
    parentSha: "f5db523f36ba8c1bf9807b7bc8dce132073a9e6a",
    mergeSha: "bba1f6a56f4c35725870afa93dd686a732fcfb9b",
    sourceUrl: prUrl(92),
    licSeed: { symbol: "updatePartner", investigateQuery: "partner PUT sponsor id payload" },
  },
  "real-emc-event-speaker-put-contract-vague": {
    stratum: "S3",
    excluded: true,
    reason: "known lic fixture leakage in same speaker PUT contract family; replaced by synthetic context-stress task",
    parentSha: "5350792c384c2ac8802f78f59c170abdc4975194",
    licSeed: { symbol: "updateSpeakerInEvent", investigateQuery: "ESP PUT contract event speaker vague" },
  },
  "real-emc-session-tag-placement": {
    stratum: "S3",
    excluded: true,
    reason: "too easy/redundant one-line UI placement task; control passed all seeds",
    parentSha: "f14f8430e4134457530734aac36c79d3a281559a",
    licSeed: { symbol: "SessionTag", investigateQuery: "session tag placement house style" },
  },
  "real-emc-series-put-readonly-targetcms": {
    stratum: "S3",
    parentSha: "82f6dacb717f8612a499c412eac0d10e108d7f2c",
    mergeSha: "cd1892d42c98c523d7c322f7e3a4f86226d2edb6",
    sourceUrl: prUrl(137),
    licSeed: { symbol: "updateSeries", investigateQuery: "series PUT readonly targetCms" },
  },
  "real-emc-session-location-time-overlap": {
    stratum: "S3",
    parentSha: "7c86403cefd0261010f631c2dd4096efc99b9d2a",
    mergeSha: "808252410a4c7ee48ebbee109e7db75bf8391eea",
    sourceUrl: prUrl(143),
    licSeed: { symbol: "sessionLocationTime", investigateQuery: "session location time overlap validation" },
  },
  "real-emc-speaker-type-mapping-hotfix": {
    stratum: "S3",
    excluded: true,
    reason: "lic HEAD leakage: fixture shows apiSpeakerTypeToFormSpeakerType (the exact function the task asks to create) because HEAD already contains the merged PR. Same class as event-speaker-put-contract.",
    licSeed: { symbol: "speakerTypeMapping", investigateQuery: "speaker type mapping ESP contract" },
  },
  "real-emc-venue-image-separation": {
    excluded: true,
    reason: "saturated housestyle: replace property with helper, fully specified",
  },

  // ─── real-emc S4 (vague issue, PIM-favorable) ─────────────────────────────
  "real-emc-ppn-explicit-select": {
    stratum: "S4",
    parentSha: "13fb4ce98673197a05b04eae8bd93e7aeb075df1",
    mergeSha: "82f6dacb717f8612a499c412eac0d10e108d7f2c",
    sourceUrl: prUrl(138),
    licSeed: { investigateQuery: "PPN explicit select dropdown user confusion" },
  },
  "real-emc-event-type-config-hide-marketo-webinar": {
    stratum: "S4",
    excluded: true,
    reason: "too easy/redundant single-value config flip; control passed all seeds",
    parentSha: "af74118af61602747a4d6a8da1eba200bd2d29b8",
    licSeed: { investigateQuery: "hide Marketo webinar event type configuration" },
  },
  "real-emc-session-api-error-toast": {
    stratum: "S4",
    parentSha: "e477b7473075e74b40ce13e1bb573843b39b73f9",
    mergeSha: "7c86403cefd0261010f631c2dd4096efc99b9d2a",
    sourceUrl: prUrl(135),
    licSeed: { investigateQuery: "session API error toast user-facing message" },
  },
  "real-emc-include-partners-toggle": {
    stratum: "S4",
    parentSha: "f7c19fc230c4e5aecfe06b46d12cf96304253ce8",
    mergeSha: "aed893da260263a630f554eeb9c31560f84f46b2",
    sourceUrl: prUrl(118),
    licSeed: { investigateQuery: "include partners toggle event form" },
  },

  // ─── real-emc S5 (library integration, lic-favorable) — existing 3 ──────
  "real-emc-rte-quill-semantic-html": {
    stratum: "S5",
    parentSha: "f787c7535b5e1dc133f69137baa1cd1da2a38b17",
    mergeSha: "704fb110ac867350e26a3207148b590ad5c6b2a7",
    sourceUrl: prUrl(122),
    licSeed: { symbol: "QuillEditor", investigateQuery: "Quill rich-text editor semantic HTML" },
  },
  "real-emc-s2-tabs-crash-segmented-control": {
    stratum: "S5",
    parentSha: "04eccca90b7f18df03afe27c17a6d94c5fc7d8b7",
    mergeSha: "eff22c27e0d3b3389d5f1b2de56edee2c0a26bb2",
    sourceUrl: prUrl(146),
    licSeed: { symbol: "SegmentedControl", investigateQuery: "Spectrum 2 Tabs SegmentedControl crash" },
  },
  "real-emc-sxsw-ticket-field-config-service": {
    stratum: "S5",
    parentSha: "cd1892d42c98c523d7c322f7e3a4f86226d2edb6",
    mergeSha: "dd81c423ce1e4d2326d36bdc4900f57613f3a8e2",
    sourceUrl: prUrl(150),
    licSeed: { symbol: "TicketFieldConfigService", investigateQuery: "SXSW ticket field configuration service" },
  },

  // ─── real-emc remaining (rbac / utility tasks) ────────────────────────────
  "real-emc-scope-group-name-match-show-members": {
    stratum: "S2",
    excluded: true,
    reason: "too easy/redundant search-condition tweak; control passed all seeds",
    parentSha: "0d38019eddcb4e0f63af0a1af69c3891f8460d99",
    licSeed: { symbol: "ScopeGroupMembers", investigateQuery: "scope group name match show members" },
  },
  "real-emc-rbac-events-dashboard-gating": {
    stratum: "S3",
    parentSha: "c44fe3dc7eaa32eb1c7e0bdb87aee5208e7a328c",
    mergeSha: "b25effb1a4a0b28f3be13789cf03506884dea513",
    sourceUrl: prUrl(79),
    licSeed: { symbol: "useHasPermission", investigateQuery: "RBAC events dashboard permission gating" },
  },
  "real-emc-dashboard-publish-omit-invite-only": {
    excluded: true,
    reason: "saturated: omit a field on publish, fully specified",
  },
  "real-emc-speaker-image-upload-defer": {
    excluded: true,
    reason: "saturated: defer upload, single-file optimisation",
  },
};

/** Apply stratum + licSeed + provenance + excluded metadata to a task. Idempotent. */
export function applyAssignment(task: Task): Task {
  const assignment = ASSIGNMENTS[task.id];
  if (!assignment) return task;
  const mergedProvenance =
    assignment.parentSha || assignment.mergeSha || assignment.sourceUrl
      ? {
          ...(task.provenance ?? {}),
          ...(assignment.parentSha ? { parentSha: task.provenance?.parentSha ?? assignment.parentSha } : {}),
          ...(assignment.mergeSha ? { mergeSha: task.provenance?.mergeSha ?? assignment.mergeSha } : {}),
          ...(assignment.sourceUrl ? { sourceUrl: task.provenance?.sourceUrl ?? assignment.sourceUrl } : {}),
        }
      : task.provenance;
  return {
    ...task,
    stratum: task.stratum ?? assignment.stratum,
    licSeed: task.licSeed ?? assignment.licSeed,
    excluded: task.excluded ?? assignment.excluded,
    provenance: mergedProvenance,
  };
}

export function applyAssignmentsToAll(tasks: Task[]): Task[] {
  return tasks.map(applyAssignment);
}

/**
 * Return tasks eligible for the haiku headline run.
 *
 * Excludes:
 * - `excluded: true` tasks (saturated, synthetic code-gen)
 * - S7 (content-gen — PIM-only domain, lic cannot compete)
 * - S6 (archaeology — lic has the answer by construction; structurally
 *   rigged for lic. Reported as secondary exploratory only, not in
 *   the headline pairwise comparisons.)
 */
export function headlineTasks(tasks: Task[]): Task[] {
  return applyAssignmentsToAll(tasks).filter(
    (t) => !t.excluded && t.stratum && t.stratum !== "S7" && t.stratum !== "S6",
  );
}

/**
 * Secondary tasks: structurally tilted strata that we report separately for
 * exploratory purposes only. Currently just S6 archaeology (lic-favorable
 * by construction). Not part of the headline mean.
 */
export function secondaryTasks(tasks: Task[]): Task[] {
  return applyAssignmentsToAll(tasks).filter((t) => !t.excluded && t.stratum === "S6");
}

/**
 * All runnable tasks for the haiku protocol: headline + secondary.
 * Run-time uses this so the same `run-eval` invocation produces both numbers;
 * the report separates them.
 */
export function runnableTasks(tasks: Task[]): Task[] {
  return [...headlineTasks(tasks), ...secondaryTasks(tasks)];
}

/** Diagnostic: count tasks per stratum after applying assignments. */
export function strataCounts(tasks: Task[]): Record<string, number> {
  const counts: Record<string, number> = { S1: 0, S2: 0, S3: 0, S4: 0, S5: 0, S6: 0, S7: 0, unassigned: 0, excluded: 0 };
  for (const t of applyAssignmentsToAll(tasks)) {
    if (t.excluded) counts.excluded++;
    if (!t.stratum) counts.unassigned++;
    else counts[t.stratum]++;
  }
  return counts;
}
