import type { Task } from "../../types.js";

const AS_OF = "2026-06-06T00:00:00.000Z";

type FutureTaskSpec = Omit<Task, "type" | "asOf" | "promptTier"> & {
  tests: NonNullable<Task["tests"]>;
};

function futureTask(spec: FutureTaskSpec): Task {
  return {
    ...spec,
    type: "code",
    asOf: AS_OF,
    promptTier: "realistic-ticket",
    tags: ["future-emc", "kg-derived", "realistic-ticket", ...(spec.tags ?? [])],
  };
}

function test(name: string, lines: string[]): NonNullable<Task["tests"]>[number] {
  return { name, body: lines.join("\n") };
}

export const futureEventModeratorPutContract = futureTask({
  id: "future-emc-event-moderator-put-contract",
  podId: "pod-emc-sessions",
  stratum: "S3",
  tags: ["api-contract", "esp", "put-payload", "anti-pattern", "kg-decisive"],
  prompt: [
    "Implement `buildEventModeratorPutPayload(body: Record<string, any>, dependentData: Record<string, any>): Record<string, any>`.",
    "",
    "A new moderator editor updates the person attached to an event. QA found PUT requests failing OpenAPI validation after the helper echoed the loaded record back to ESP.",
    "Follow the existing EMC convention for event association PUT bodies. Do not use a broad merge of the GET response.",
    "",
    "Export the function as a named export `buildEventModeratorPutPayload`.",
  ].join("\n"),
  expectedSignals: ["moderatorId", "moderatorType", "ordinal", "creationTime", "modificationTime"],
  kgExpectations: {
    requiredFacts: [
      "ESP event-speaker PUT body contract",
      "Do not spread GET response into PUT body",
      "modificationTime for optimistic concurrency",
    ],
    requiredSymbols: ["speakerId", "speakerType", "ordinal", "creationTime", "modificationTime"],
  },
  tests: [
    test("builds a narrow moderator association payload with field-level fallback", [
      "const body = { moderatorId: 'm-2', ordinal: 4, photoUrl: 'drop', creationTime: 999, modificationTime: 999 };",
      "const dependentData = { moderatorId: 'm-1', moderatorType: 'Host', ordinal: 1, creationTime: 111, modificationTime: 222, createdBy: 'ada' };",
      "const out = mod.buildEventModeratorPutPayload(body, dependentData);",
      "assert.deepEqual(out, { moderatorId: 'm-2', moderatorType: 'Host', ordinal: 4, creationTime: 111, modificationTime: 222 });",
    ]),
    test("keeps server-issued timestamps from the dependent record", [
      "const out = mod.buildEventModeratorPutPayload({ moderatorType: 'Panelist', creationTime: 9, modificationTime: 10 }, { moderatorId: 'm-1', moderatorType: 'Host', ordinal: 2, creationTime: 101, modificationTime: 202 });",
      "assert.equal(out.creationTime, 101);",
      "assert.equal(out.modificationTime, 202);",
      "assert.equal(out.moderatorType, 'Panelist');",
    ]),
    test("does not spread read-only or unrelated GET fields", [
      "const out = mod.buildEventModeratorPutPayload({}, { moderatorId: 'm-1', moderatorType: 'Host', ordinal: 2, creationTime: 101, modificationTime: 202, localizations: {}, targetCms: 'readonly' });",
      "assert.deepEqual(Object.keys(out).sort(), ['creationTime', 'moderatorId', 'moderatorType', 'modificationTime', 'ordinal'].sort());",
    ]),
  ],
  licSeed: { symbol: "updateSpeakerInEvent", investigateQuery: "event association PUT payload contract" },
});

export const futureSessionTrackPutSanitizer = futureTask({
  id: "future-emc-session-track-put-sanitizer",
  podId: "pod-emc-sessions",
  stratum: "S3",
  tags: ["api-contract", "esp", "put-payload", "stale-trap", "kg-decisive"],
  prompt: [
    "Implement `buildSessionTrackUpdatePlan(draft: Record<string, any>, current: Record<string, any>): { helper: string; payload: Record<string, any> }`.",
    "",
    "The session-track edit screen needs a PUT plan. The draft can contain UI-only fields and stale IDs because it is assembled from form state.",
    "Return the EMC helper name to use and the payload that should be passed to that helper.",
    "Do not import repo modules; this eval runs as a pure module. Return the helper name as the exact string `prepareEspSessionTrackPutPayload`.",
    "",
    "Export the function as a named export `buildSessionTrackUpdatePlan`.",
  ].join("\n"),
  expectedSignals: ["prepareEspSessionTrackPutPayload", "trackId", "modificationTime", "targetCms"],
  kgExpectations: {
    requiredFacts: [
      "Per-resource PUT payload sanitizers live in utils/dataFilters.ts",
      "prepareEsp{Resource}PutPayload",
      "targetCms",
      "modificationTime for optimistic concurrency",
    ],
    requiredSymbols: ["prepareEspSeriesPutPayload", "targetCms", "modificationTime"],
  },
  tests: [
    test("selects the resource sanitizer and preserves server-owned identity fields", [
      "const draft = { title: 'Analytics', trackId: 'bad-draft-id', color: 'blue', targetCms: 'drop', createdBy: 'drop' };",
      "const current = { trackId: 'track-1', modificationTime: 321, title: 'Old', targetCms: 'readonly' };",
      "const out = mod.buildSessionTrackUpdatePlan(draft, current);",
      "assert.equal(out.helper, 'prepareEspSessionTrackPutPayload');",
      "assert.equal(out.payload.trackId, 'track-1');",
      "assert.equal(out.payload.modificationTime, 321);",
      "assert.equal(out.payload.title, 'Analytics');",
      "assert.equal(out.payload.color, 'blue');",
      "assert.equal(Object.prototype.hasOwnProperty.call(out.payload, 'targetCms'), false);",
      "assert.equal(Object.prototype.hasOwnProperty.call(out.payload, 'createdBy'), false);",
    ]),
    test("emits only required server fields when draft has no submit fields", [
      "const out = mod.buildSessionTrackUpdatePlan({ targetCms: 'drop' }, { trackId: 'track-2', modificationTime: 7 });",
      "assert.deepEqual(out.payload, { trackId: 'track-2', modificationTime: 7 });",
    ]),
    test("does not mutate input records", [
      "const draft = { title: 'A', targetCms: 'drop' };",
      "const current = { trackId: 'track-3', modificationTime: 8, targetCms: 'readonly' };",
      "mod.buildSessionTrackUpdatePlan(draft, current);",
      "assert.deepEqual(draft, { title: 'A', targetCms: 'drop' });",
      "assert.deepEqual(current, { trackId: 'track-3', modificationTime: 8, targetCms: 'readonly' });",
    ]),
  ],
  licSeed: { symbol: "prepareEspSeriesPutPayload", investigateQuery: "ESP PUT sanitizer targetCms modificationTime" },
});

export const futureBreakoutTimeResponseState = futureTask({
  id: "future-emc-breakout-time-response-state",
  podId: "pod-emc-sessions",
  stratum: "S4",
  tags: ["sessions", "state", "api-response", "kg-decisive"],
  prompt: [
    "Implement `mergeBreakoutTimeSave(session: Record<string, any>, apiResult: Record<string, any>): Record<string, any>`.",
    "",
    "A breakout-session time editor now receives the server response from the save call. Users still see stale times until a refresh.",
    "Follow the EMC state-update convention for saved session-time records.",
    "",
    "Return a new session object and do not mutate the input session.",
    "Export the function as a named export `mergeBreakoutTimeSave`.",
  ].join("\n"),
  expectedSignals: ["sessionTimeId", "creationTime", "modificationTime", "startTimeMillis", "endTimeMillis"],
  licSignals: ["SessionTimeInfo"],
  kgExpectations: {
    requiredFacts: [
      "Session-time helpers must return SessionTimeInfo",
      "React state can update without a page refresh",
      "modificationTime for optimistic concurrency",
    ],
    requiredSymbols: ["SessionTimeInfo", "modificationTime"],
  },
  tests: [
    test("propagates server-issued session-time identifiers and timestamps into state", [
      "const session = { id: 'sess-1', sessionTimeId: 'old', sessionTimeCreationTime: 10, sessionTimeModificationTime: 20, startTimeMillis: 100, endTimeMillis: 200, timezone: 'America/Los_Angeles' };",
      "const apiResult = { sessionTimeId: 'time-9', creationTime: 111, modificationTime: 222, startTimeMillis: 300, endTimeMillis: 450, timezone: 'Europe/Paris' };",
      "const out = mod.mergeBreakoutTimeSave(session, apiResult);",
      "assert.equal(out.sessionTimeId, 'time-9');",
      "assert.equal(out.sessionTimeCreationTime, 111);",
      "assert.equal(out.sessionTimeModificationTime, 222);",
      "assert.equal(out.startTimeMillis, 300);",
      "assert.equal(out.endTimeMillis, 450);",
      "assert.equal(out.timezone, 'Europe/Paris');",
    ]),
    test("falls back to stable alternate response field names", [
      "const out = mod.mergeBreakoutTimeSave({ id: 'sess-1' }, { id: 'time-2', createdAt: 11, updatedAt: 22, startTimeMillis: 500, endTimeMillis: 600 });",
      "assert.equal(out.sessionTimeId, 'time-2');",
      "assert.equal(out.sessionTimeCreationTime, 11);",
      "assert.equal(out.sessionTimeModificationTime, 22);",
    ]),
    test("keeps unrelated fields and does not mutate input", [
      "const session = { id: 'sess-1', name: 'Opening', speakerIds: ['a'], startTimeMillis: 100 };",
      "const out = mod.mergeBreakoutTimeSave(session, { sessionTimeId: 'time-1', creationTime: 1, modificationTime: 2 });",
      "assert.deepEqual(session, { id: 'sess-1', name: 'Opening', speakerIds: ['a'], startTimeMillis: 100 });",
      "assert.deepEqual(out.speakerIds, ['a']);",
      "assert.equal(out.name, 'Opening');",
    ]),
  ],
  licSeed: { symbol: "SessionTimeInfo", investigateQuery: "SessionManagement Sessions sessionTimeId modificationTime setSessions sessionTime" },
});

export const futureRsvpContactMethodsPut = futureTask({
  id: "future-emc-rsvp-contact-methods-put",
  podId: "pod-emc-sessions",
  stratum: "S3",
  tags: ["registration", "api-contract", "helper-required", "kg-decisive"],
  prompt: [
    "Implement `buildRsvpContactMethodsPut(input: Record<string, any>, current: Record<string, any>): { helper: string; payload: Record<string, any> }`.",
    "",
    "The profile editor lets attendees update preferred RSVP contact methods. The previous implementation copied the loaded attendee object and failed PUT validation.",
    "Return the helper that should prepare the contact methods plus the narrow payload to send.",
    "",
    "Export the function as a named export `buildRsvpContactMethodsPut`.",
  ].join("\n"),
  expectedSignals: ["prepareContactMethodsForPut", "contactMethods", "modificationTime"],
  kgExpectations: {
    requiredFacts: [
      "contactMethods field must not be spread directly from GET response",
      "prepareContactMethodsForPut helper",
      "modificationTime for optimistic concurrency",
    ],
    requiredSymbols: ["contactMethods", "prepareContactMethodsForPut", "modificationTime"],
  },
  tests: [
    test("returns the approved helper and a normalized narrow payload", [
      "const input = { contactMethods: [{ type: 'email', value: 'a@example.com', selected: true, label: 'Email' }, { type: 'sms', value: '', selected: true }, { type: 'phone', value: '+1', selected: false }], name: 'drop' };",
      "const current = { attendeeId: 'att-1', modificationTime: 77, contactMethods: [{ type: 'email', value: 'old' }], createdBy: 'drop' };",
      "const out = mod.buildRsvpContactMethodsPut(input, current);",
      "assert.equal(out.helper, 'prepareContactMethodsForPut');",
      "assert.deepEqual(out.payload, { attendeeId: 'att-1', modificationTime: 77, contactMethods: [{ type: 'email', value: 'a@example.com' }] });",
    ]),
    test("preserves explicit falsey selected values by excluding them instead of echoing GET shape", [
      "const out = mod.buildRsvpContactMethodsPut({ contactMethods: [{ type: 'email', value: 'a', selected: false }] }, { attendeeId: 'att-2', modificationTime: 1 });",
      "assert.deepEqual(out.payload.contactMethods, []);",
      "assert.deepEqual(Object.keys(out.payload).sort(), ['attendeeId', 'contactMethods', 'modificationTime'].sort());",
    ]),
    test("does not mutate input arrays", [
      "const methods = [{ type: 'email', value: 'a@example.com', selected: true, label: 'Email' }];",
      "mod.buildRsvpContactMethodsPut({ contactMethods: methods }, { attendeeId: 'att-3', modificationTime: 5 });",
      "assert.deepEqual(methods, [{ type: 'email', value: 'a@example.com', selected: true, label: 'Email' }]);",
    ]),
  ],
  licSeed: { symbol: "contactMethods", investigateQuery: "RSVP contact methods PUT helper" },
});

export const futureDetailPagePathFilterToggle = futureTask({
  id: "future-emc-detail-page-path-filter-toggle",
  podId: "pod-emc-sessions",
  stratum: "S3",
  tags: ["event-form", "data-filters", "stale-trap", "kg-decisive"],
  prompt: [
    "Implement `planEventTitlePutFilter(change: Record<string, any>, dataFilters: Record<string, any>): Record<string, any>`.",
    "",
    "Title edits are no longer updating the generated event page path. Add a pure helper for the event PUT filter layer.",
    "The fix should adjust the field filter plan for title-driven saves without deleting existing filter metadata.",
    "",
    "Return a new filters object and export the function as a named export `planEventTitlePutFilter`.",
  ].join("\n"),
  expectedSignals: ["detailPagePath", "dataFilters", "submittable"],
  kgExpectations: {
    requiredFacts: [
      "Do not omit detailPagePath from event PUT payloads",
      "dataFilters",
      "submittable: true",
    ],
    requiredSymbols: ["detailPagePath", "dataFilters", "submittable"],
  },
  tests: [
    test("marks detailPagePath submittable when the title changed", [
      "const filters = { title: { submittable: true }, detailPagePath: { submittable: false, readonly: true }, venue: { submittable: true } };",
      "const out = mod.planEventTitlePutFilter({ titleChanged: true }, filters);",
      "assert.equal(out.detailPagePath.submittable, true);",
      "assert.equal(out.detailPagePath.readonly, true);",
      "assert.equal(out.venue.submittable, true);",
    ]),
    test("does not invent detailPagePath changes when title did not change", [
      "const filters = { detailPagePath: { submittable: false } };",
      "const out = mod.planEventTitlePutFilter({ titleChanged: false }, filters);",
      "assert.equal(out.detailPagePath.submittable, false);",
    ]),
    test("does not mutate the existing filters object", [
      "const filters = { detailPagePath: { submittable: false } };",
      "mod.planEventTitlePutFilter({ titleChanged: true }, filters);",
      "assert.deepEqual(filters, { detailPagePath: { submittable: false } });",
    ]),
  ],
  licSeed: { symbol: "detailPagePath", investigateQuery: "event PUT detailPagePath dataFilters submittable" },
});

export const futureEventWizardStepGrouping = futureTask({
  id: "future-emc-event-wizard-step-grouping",
  podId: "pod-emc-configs",
  stratum: "S4",
  tags: ["ui-convention", "event-form", "control-solvable", "kg-decisive"],
  prompt: [
    "Implement `buildFutureEventWizardSteps(enabledSections: string[]): string[][]`.",
    "",
    "A future event template added optional sections and accidentally split the first page of the form into too many wizard steps.",
    "Return the section groups using the EMC event-form wizard convention, dropping disabled sections but preserving the known step order.",
    "Preserve the four wizard step slots; if a whole step has no enabled sections, return an empty array for that step.",
    "",
    "Export the function as a named export `buildFutureEventWizardSteps`.",
  ].join("\n"),
  expectedSignals: ["format", "tags", "info", "dates", "venue", "4-step"],
  licSignals: ["EventForm"],
  kgExpectations: {
    requiredFacts: [
      "Event Form uses 4-step wizard structure",
      "Step 1 groups 5 logical components",
      "format, tags, info, dates, venue",
    ],
    requiredSymbols: ["EventForm", "format", "tags", "venue"],
  },
  tests: [
    test("groups the first five logical sections into the first wizard step", [
      "const out = mod.buildFutureEventWizardSteps(['format', 'tags', 'info', 'dates', 'venue', 'speakers', 'agenda', 'registration', 'review']);",
      "assert.deepEqual(out[0], ['format', 'tags', 'info', 'dates', 'venue']);",
      "assert.equal(out.length, 4);",
    ]),
    test("drops disabled sections without creating extra steps", [
      "const out = mod.buildFutureEventWizardSteps(['format', 'info', 'venue', 'agenda', 'review']);",
      "assert.deepEqual(out, [['format', 'info', 'venue'], [], ['agenda'], ['review']]);",
    ]),
    test("ignores unknown sections", [
      "const out = mod.buildFutureEventWizardSteps(['format', 'custom-lab', 'review']);",
      "assert.deepEqual(out, [['format'], [], [], ['review']]);",
    ]),
  ],
  licSeed: { symbol: "EventForm", investigateQuery: "event form wizard step grouping" },
});

export const futureAgendaSwitcherSegmentedControl = futureTask({
  id: "future-emc-agenda-switcher-segmented-control",
  podId: "pod-emc-configs",
  stratum: "S5",
  tags: ["ui-convention", "spectrum-2", "stale-trap", "kg-decisive"],
  prompt: [
    "Implement `chooseAgendaSwitcher(tabs: string[], activeTab: string): { component: string; activeTab: string; renderMode: string; options: string[] }`.",
    "",
    "The agenda editor crashes after resize when the tab row overflows. Product still wants the same two-state switcher behavior.",
    "Return the component plan EMC should use for this switcher.",
    "If `activeTab` is not present in `tabs`, fall back to the first option.",
    "",
    "Export the function as a named export `chooseAgendaSwitcher`.",
  ].join("\n"),
  expectedSignals: ["SegmentedControl", "conditional", "Tabs"],
  kgExpectations: {
    requiredFacts: [
      "React Spectrum 2 Tabs component can crash",
      "SegmentedControl + conditional rendering",
      "TabListStateContext",
    ],
    requiredSymbols: ["Tabs", "SegmentedControl", "TabListStateContext"],
  },
  tests: [
    test("uses SegmentedControl and conditional rendering instead of Tabs", [
      "const out = mod.chooseAgendaSwitcher(['sessions', 'speakers'], 'speakers');",
      "assert.equal(out.component, 'SegmentedControl');",
      "assert.equal(out.renderMode, 'conditional');",
      "assert.equal(out.activeTab, 'speakers');",
      "assert.deepEqual(out.options, ['sessions', 'speakers']);",
    ]),
    test("falls back to the first option when the active tab is stale", [
      "const out = mod.chooseAgendaSwitcher(['sessions', 'speakers'], 'venues');",
      "assert.equal(out.activeTab, 'sessions');",
    ]),
    test("does not return the known-crashing Tabs component", [
      "const out = mod.chooseAgendaSwitcher(['a'], 'a');",
      "assert.notEqual(out.component, 'Tabs');",
    ]),
  ],
  licSeed: { symbol: "LocationDialog", investigateQuery: "Spectrum 2 Tabs crash SegmentedControl conditional rendering" },
});

export const futureRichTextSemanticExport = futureTask({
  id: "future-emc-rich-text-semantic-export",
  podId: "pod-emc-configs",
  stratum: "S5",
  tags: ["ui-convention", "rich-text", "api-contract", "kg-decisive"],
  prompt: [
    "Implement `serializeRteForApi(editor: Record<string, any>): string`.",
    "",
    "Speaker bios exported from a new rich-text field render list bullets differently outside the editor and sometimes keep non-breaking-space variants.",
    "Use the EMC rich-text export convention for API payloads.",
    "Prefer `getSemanticHTML()` when present, normalize NBSP variants to spaces, and keep the helper compatible with the provided editor object.",
    "",
    "Export the function as a named export `serializeRteForApi`.",
  ].join("\n"),
  expectedSignals: ["getSemanticHTML", "NBSP", "innerHTML"],
  kgExpectations: {
    requiredFacts: [
      "RichTextEditor export must use getSemanticHTML()",
      "portable <ul>/<ol>",
      "normalize NBSP variants",
    ],
    requiredSymbols: ["getSemanticHTML", "NBSP", "RichTextEditor"],
  },
  tests: [
    test("prefers semantic HTML over editor internal markup", [
      "let semanticCalled = false;",
      "const editor = { getText: () => 'A B', getSemanticHTML: () => { semanticCalled = true; return '<ul><li>A&nbsp;B</li></ul>'; }, root: { innerHTML: '<p data-list=\"bullet\">A</p>' } };",
      "const out = mod.serializeRteForApi(editor);",
      "assert.equal(semanticCalled, true);",
      "assert.equal(out, '<ul><li>A B</li></ul>');",
    ]),
    test("normalizes unicode NBSP variants", [
      "const editor = { getText: () => 'A B C', getSemanticHTML: () => '<p>A\\u00a0B\\u202fC</p>' };",
      "assert.equal(mod.serializeRteForApi(editor), '<p>A B C</p>');",
    ]),
    test("does not fall back to innerHTML when getSemanticHTML exists", [
      "const editor = { getText: () => 'Good', getSemanticHTML: () => '<ol><li>Good</li></ol>', root: { innerHTML: '<p>Bad</p>' } };",
      "assert.equal(mod.serializeRteForApi(editor), '<ol><li>Good</li></ol>');",
    ]),
  ],
  licSeed: { symbol: "getSemanticHTML", investigateQuery: "Quill rich text semantic HTML NBSP" },
  serenaSeed: {
    symbols: ["RichTextEditor"],
    files: ["web-src/src/components/shared/RichTextEditor.tsx"],
    note: "Existing rich-text component the future serializeRteForApi feature extends; 'getSemanticHTML' is not yet a real symbol.",
  },
});

export const futureProdPublishConfirmation = futureTask({
  id: "future-emc-prod-publish-confirmation",
  podId: "pod-emc-sessions",
  stratum: "S4",
  tags: ["publish", "ui-convention", "environment", "kg-decisive"],
  prompt: [
    "Implement `resolvePublishAction(env: string, publishRequested: boolean, confirmed: boolean): { action: string; component?: string }`.",
    "",
    "A future publish button path calls the publish API immediately in production. Dev and stage should stay fast for test runs.",
    "Return the next UI/API action for this click.",
    "Use only these exact action values: `confirm`, `publish`, and `none`. For production confirmation, return component `AlertDialog`.",
    "",
    "Export the function as a named export `resolvePublishAction`.",
  ].join("\n"),
  expectedSignals: ["AlertDialog", "publishEvent", "prod", "dev", "stage"],
  kgExpectations: {
    requiredFacts: [
      "Production event publishing requires explicit user confirmation",
      "AlertDialog",
      "dev/stage builds skip this gate",
    ],
    requiredSymbols: ["AlertDialog", "publishEvent"],
  },
  tests: [
    test("requires confirmation before production publish", [
      "assert.deepEqual(mod.resolvePublishAction('prod', true, false), { action: 'confirm', component: 'AlertDialog' });",
      "assert.deepEqual(mod.resolvePublishAction('production', true, false), { action: 'confirm', component: 'AlertDialog' });",
    ]),
    test("publishes immediately outside production or after confirmation", [
      "assert.deepEqual(mod.resolvePublishAction('stage', true, false), { action: 'publish' });",
      "assert.deepEqual(mod.resolvePublishAction('dev', true, false), { action: 'publish' });",
      "assert.deepEqual(mod.resolvePublishAction('prod', true, true), { action: 'publish' });",
    ]),
    test("does nothing when publish was not requested", [
      "assert.deepEqual(mod.resolvePublishAction('prod', false, false), { action: 'none' });",
    ]),
  ],
  licSeed: { symbol: "AlertDialog", investigateQuery: "production publish confirmation AlertDialog" },
});

export const futurePpnExplicitNoChoice = futureTask({
  id: "future-emc-ppn-explicit-no-choice",
  podId: "pod-emc-configs",
  stratum: "S4",
  tags: ["ppn", "form-state", "context-required", "kg-decisive"],
  prompt: [
    "Implement `normalizePpnChoice(fieldKey: string, selected: Record<string, any> | null | undefined): { acknowledged: boolean; valueId?: string; value?: boolean }`.",
    "",
    "The PPN metadata picker still treats an explicit negative answer as if the organizer never made a choice.",
    "Normalize the selected option using the existing EMC acknowledgement convention.",
    "",
    "Export the function as a named export `normalizePpnChoice`.",
  ].join("\n"),
  expectedSignals: ["noOptionKey", "metadataFieldAcknowledged", "no-${fieldKey}", "acknowledged", "PPN"],
  kgExpectations: {
    requiredFacts: [
      "Page metadata (PPN) fields require explicit user acknowledgment",
      "sentinel id 'no-${fieldKey}'",
      "explicit *No* selection",
    ],
    requiredSymbols: ["PPN", "no-${fieldKey}"],
  },
  tests: [
    test("treats the sentinel option as an acknowledged negative answer", [
      "const out = mod.normalizePpnChoice('sharePage', { id: 'no-sharePage', label: 'No' });",
      "assert.deepEqual(out, { acknowledged: true, valueId: 'no-sharePage', value: false });",
    ]),
    test("treats a normal option as an acknowledged positive answer", [
      "const out = mod.normalizePpnChoice('sharePage', { id: 'yes-sharePage', label: 'Yes' });",
      "assert.deepEqual(out, { acknowledged: true, valueId: 'yes-sharePage', value: true });",
    ]),
    test("keeps empty state distinct from explicit no", [
      "assert.deepEqual(mod.normalizePpnChoice('sharePage', null), { acknowledged: false });",
      "assert.deepEqual(mod.normalizePpnChoice('sharePage', undefined), { acknowledged: false });",
    ]),
  ],
  licSeed: { symbol: "noOptionKey", investigateQuery: "PageMetadataComponent metadataFieldAcknowledged noOptionKey no field choice" },
});

export const futureSpeakerPhotoHydrationJoin = futureTask({
  id: "future-emc-speaker-photo-hydration-join",
  podId: "pod-emc-configs",
  stratum: "S2",
  tags: ["hydration", "images", "lic-favorable", "kg-decisive"],
  prompt: [
    "Implement `hydrateSpeakerPhotoRecords(speakers: Record<string, any>[], images: Record<string, any>[]): Record<string, any>[]`.",
    "",
    "The new speaker summary view already receives speakers and a separately loaded image list, but headshots are empty.",
    "Join the records using the EMC speaker-photo hydration convention.",
    "",
    "Return new speaker objects and export the function as a named export `hydrateSpeakerPhotoRecords`.",
  ].join("\n"),
  expectedSignals: ["imagesMgr.list", "imagekind#speaker-photo", "photo"],
  kgExpectations: {
    requiredFacts: [
      "Speaker photo hydration requires explicit imagesMgr.list() join",
      "photos are stored as separate DynamoDB records",
      "imagekind#speaker-photo",
    ],
    requiredSymbols: ["imagesMgr.list", "imagekind#speaker-photo"],
  },
  tests: [
    test("attaches matching speaker-photo image records", [
      "const speakers = [{ speakerId: 's-1', name: 'Ada' }, { speakerId: 's-2', name: 'Grace' }];",
      "const images = [{ resourceId: 's-2', sk: 'imagekind#speaker-photo', url: '/grace.png' }, { resourceId: 's-1', imageKind: 'speaker-photo', url: '/ada.png' }, { resourceId: 's-1', imageKind: 'banner', url: '/banner.png' }];",
      "const out = mod.hydrateSpeakerPhotoRecords(speakers, images);",
      "assert.equal(out[0].photo.url, '/ada.png');",
      "assert.equal(out[1].photo.url, '/grace.png');",
    ]),
    test("keeps speakers without a matching photo", [
      "const out = mod.hydrateSpeakerPhotoRecords([{ speakerId: 's-3', name: 'No Photo' }], []);",
      "assert.equal(Object.prototype.hasOwnProperty.call(out[0], 'photo'), false);",
    ]),
    test("does not mutate source records", [
      "const speakers = [{ speakerId: 's-1', name: 'Ada' }];",
      "mod.hydrateSpeakerPhotoRecords(speakers, [{ resourceId: 's-1', imageKind: 'speaker-photo', url: '/ada.png' }]);",
      "assert.deepEqual(speakers, [{ speakerId: 's-1', name: 'Ada' }]);",
    ]),
  ],
  licSeed: { symbol: "getEventFull", investigateQuery: "speaker photo hydration images list join" },
});

export const futureShowSponsorsDefault = futureTask({
  id: "future-emc-show-sponsors-default",
  podId: "pod-emc-configs",
  stratum: "S3",
  tags: ["event-form", "boolean-toggle", "control-solvable", "kg-decisive"],
  prompt: [
    "Implement `resolveEventToggleValue(fieldKey: string, apiValue: unknown, isCreate: boolean): boolean`.",
    "",
    "A future partner section toggle starts hidden for newly created events and for older events whose API response omits the field.",
    "Use the EMC event-form boolean toggle convention.",
    "",
    "Export the function as a named export `resolveEventToggleValue`.",
  ].join("\n"),
  expectedSignals: ["showSponsors", "?? true", "default"],
  kgExpectations: {
    requiredFacts: [
      "showSponsors",
      "default to true on creation",
      "?? true fallback on load",
    ],
    requiredSymbols: ["showSponsors"],
  },
  tests: [
    test("defaults showSponsors to true for create and omitted loaded values", [
      "assert.equal(mod.resolveEventToggleValue('showSponsors', undefined, true), true);",
      "assert.equal(mod.resolveEventToggleValue('showSponsors', undefined, false), true);",
      "assert.equal(mod.resolveEventToggleValue('showSponsors', null, false), true);",
    ]),
    test("preserves explicit false for showSponsors", [
      "assert.equal(mod.resolveEventToggleValue('showSponsors', false, false), false);",
      "assert.equal(mod.resolveEventToggleValue('showSponsors', true, false), true);",
    ]),
    test("does not apply the sponsor default to unrelated toggles", [
      "assert.equal(mod.resolveEventToggleValue('showAgenda', undefined, true), false);",
      "assert.equal(mod.resolveEventToggleValue('showAgenda', true, false), true);",
    ]),
  ],
  licSeed: { symbol: "showSponsors", investigateQuery: "event form showSponsors default true fallback" },
});

export const futureEventsDashboardPermissionFilter = futureTask({
  id: "future-emc-events-dashboard-permission-filter",
  podId: "pod-emc-rbac",
  stratum: "S3",
  tags: ["rbac", "permissions", "helper-required", "kg-decisive"],
  prompt: [
    "Implement `filterDashboardEvents(events: Record<string, any>[], permissions: string[], roleFetchStatus?: number): Record<string, any>[]`.",
    "",
    "Some orgs see an empty Events dashboard after role fetch returns 403 even though their domain-level permissions should still allow reads.",
    "Apply EMC's dashboard gating convention in a pure helper.",
    "",
    "Return new event objects and export the function as a named export `filterDashboardEvents`.",
  ].join("\n"),
  expectedSignals: ["useHasPermission", "filterEvents", "event:read", "event:*"],
  kgExpectations: {
    requiredFacts: [
      "RBAC permission gating uses wildcard-matching permission strings",
      "fallback to domain-only permissions when role fetch returns 403",
      "useHasPermission hooks and filterEvents",
    ],
    requiredSymbols: ["useHasPermission", "filterEvents"],
  },
  tests: [
    test("allows events with exact or wildcard event permissions", [
      "const events = [{ eventId: 'e-1' }, { eventId: 'e-2' }];",
      "assert.deepEqual(mod.filterDashboardEvents(events, ['event:read']).map((e) => e.eventId), ['e-1', 'e-2']);",
      "assert.deepEqual(mod.filterDashboardEvents(events, ['event:*']).map((e) => e.eventId), ['e-1', 'e-2']);",
    ]),
    test("uses domain-only fallback when role fetch returned 403", [
      "const events = [{ eventId: 'e-1' }];",
      "assert.deepEqual(mod.filterDashboardEvents(events, ['event'], 403).map((e) => e.eventId), ['e-1']);",
      "assert.deepEqual(mod.filterDashboardEvents(events, ['series'], 403), []);",
    ]),
    test("does not mutate event objects", [
      "const events = [{ eventId: 'e-1', title: 'A' }];",
      "const out = mod.filterDashboardEvents(events, ['event:read']);",
      "assert.notEqual(out[0], events[0]);",
      "assert.deepEqual(events, [{ eventId: 'e-1', title: 'A' }]);",
    ]),
  ],
  licSeed: { symbol: "useHasPermission", investigateQuery: "RBAC events dashboard permission gating filterEvents" },
});

export const futureInviteOnlyRsvpState = futureTask({
  id: "future-emc-invite-only-rsvp-state",
  podId: "pod-emc-rbac",
  stratum: "S3",
  tags: ["registration", "invite-only", "ui-convention", "kg-decisive"],
  prompt: [
    "Implement `resolveInviteOnlyRsvpState(event: Record<string, any>, urlParams: Record<string, string | undefined>): { state: string; message?: string }`.",
    "",
    "Invite-only events are still rendering a disabled RSVP button for visitors who arrive without a campaign link.",
    "Return the RSVP UI state using the EMC invite-only convention.",
    "Use exact state `message` when the RSVP button should be replaced by text, and exact state `button` when the RSVP button should render.",
    "",
    "Export the function as a named export `resolveInviteOnlyRsvpState`.",
  ].join("\n"),
  expectedSignals: ["inviteOnly", "campaign", "message"],
  kgExpectations: {
    requiredFacts: [
      "Invite-only events gate RSVP behind `inviteOnly` flag and campaign URL param",
      "replace button with text message rather than disable",
    ],
    requiredSymbols: ["inviteOnly", "campaign"],
  },
  tests: [
    test("shows a message instead of a disabled button when campaign param is missing", [
      "const out = mod.resolveInviteOnlyRsvpState({ inviteOnly: true }, {});",
      "const state = out.state === 'message' || (out.message && ['blocked', 'invite-only', 'invite_only_locked'].includes(out.state)) ? 'message' : out.state;",
      "assert.equal(state, 'message');",
      "assert.match(out.message, /invite|invitation/i);",
    ]),
    test("allows RSVP when invite-only event has campaign context", [
      "const state1 = mod.resolveInviteOnlyRsvpState({ inviteOnly: true }, { campaign: 'cmp-1' }).state;",
      "const state2 = mod.resolveInviteOnlyRsvpState({ inviteOnly: true }, { campaignId: 'cmp-1' }).state;",
      "assert.equal(['button', 'open', 'enabled', 'invite_only_unlocked'].includes(state1), true);",
      "assert.equal(['button', 'open', 'enabled', 'invite_only_unlocked'].includes(state2), true);",
    ]),
    test("normal public events render the button", [
      "const state = mod.resolveInviteOnlyRsvpState({ inviteOnly: false }, {}).state;",
      "assert.equal(['button', 'open', 'enabled'].includes(state), true);",
    ]),
  ],
  licSeed: { symbol: "inviteOnly", investigateQuery: "invite-only RSVP campaign message gate" },
});

export const futureCampaignCapacityDecision = futureTask({
  id: "future-emc-campaign-capacity-decision",
  podId: "pod-emc-sessions",
  stratum: "S4",
  tags: ["registration", "campaign", "capacity", "kg-decisive"],
  prompt: [
    "Implement `resolveCampaignRegistrationState(event: Record<string, any>, campaign: Record<string, any> | null, counts: Record<string, number>): { capacitySource: string; state: string; message?: string }`.",
    "",
    "Registration from campaign links can overbook because the generic event capacity is checked first.",
    "Return the state the RSVP button should use before attendee creation.",
    "Use exact `capacitySource` values `campaign` or `event`, and exact state values `open`, `waitlist`, and `blocked`.",
    "",
    "Export the function as a named export `resolveCampaignRegistrationState`.",
  ].join("\n"),
  expectedSignals: ["campaignId", "campaign capacity", "waitlist"],
  kgExpectations: {
    requiredFacts: [
      "campaignId URL param is present",
      "fetch campaign capacity and apply waitlist rules before attendee creation",
      "campaign-specific error messages",
    ],
    requiredSymbols: ["campaignId", "waitlist"],
  },
  tests: [
    test("uses campaign capacity before event capacity when campaign context is present", [
      "const out = mod.resolveCampaignRegistrationState({ capacity: 100, waitlistEnabled: true }, { campaignId: 'cmp-1', capacity: 2, waitlistEnabled: true }, { registered: 2, waitlisted: 0 });",
      "assert.equal(out.capacitySource, 'campaign');",
      "assert.equal(out.state, 'waitlist');",
      "assert.match(out.message, /campaign/i);",
    ]),
    test("blocks with campaign-specific message when campaign and waitlist are full", [
      "const out = mod.resolveCampaignRegistrationState({ capacity: 100, waitlistEnabled: true }, { campaignId: 'cmp-1', capacity: 2, waitlistCapacity: 1, waitlistEnabled: true }, { registered: 2, waitlisted: 1 });",
      "assert.equal(out.state, 'blocked');",
      "assert.match(out.message, /campaign/i);",
    ]),
    test("falls back to event capacity when campaign is absent", [
      "const out = mod.resolveCampaignRegistrationState({ capacity: 2, waitlistEnabled: false }, null, { registered: 1, waitlisted: 0 });",
      "assert.deepEqual(out, { capacitySource: 'event', state: 'open' });",
    ]),
  ],
  licSeed: { symbol: "campaignId", investigateQuery: "campaign capacity RSVP waitlist registration" },
});

export const futureRsvpBooleanFieldDisplay = futureTask({
  id: "future-emc-rsvp-boolean-field-display",
  podId: "pod-emc-configs",
  stratum: "S2",
  tags: ["registration", "config", "control-solvable", "kg-decisive"],
  prompt: [
    "Implement `formatRsvpFieldValue(field: Record<string, any>, value: unknown): string`.",
    "",
    "The attendee table and CSV preview are showing raw boolean values for custom RSVP fields loaded from config.",
    "Format values using the EMC RSVP field metadata convention.",
    "",
    "Export the function as a named export `formatRsvpFieldValue`.",
  ].join("\n"),
  expectedSignals: ["Yes", "No", "configService.getRsvpConfig"],
  kgExpectations: {
    requiredFacts: [
      "RSVP field metadata is loaded from external event-libs config",
      "boolean attendee fields render as 'Yes'/'No'",
      "UI and CSV exports",
    ],
    requiredSymbols: ["configService.getRsvpConfig", "Yes", "No"],
  },
  tests: [
    test("renders boolean field values as Yes and No", [
      "assert.equal(mod.formatRsvpFieldValue({ id: 'requiresTicket', type: 'boolean' }, true), 'Yes');",
      "assert.equal(mod.formatRsvpFieldValue({ id: 'requiresTicket', type: 'boolean' }, false), 'No');",
    ]),
    test("uses empty string for missing values", [
      "assert.equal(mod.formatRsvpFieldValue({ id: 'optIn', type: 'boolean' }, undefined), '');",
      "assert.equal(mod.formatRsvpFieldValue({ id: 'company', type: 'text' }, null), '');",
    ]),
    test("leaves non-boolean values readable", [
      "assert.equal(mod.formatRsvpFieldValue({ id: 'company', type: 'text' }, 'Adobe'), 'Adobe');",
      "assert.equal(mod.formatRsvpFieldValue({ id: 'count', type: 'number' }, 3), '3');",
    ]),
  ],
  licSeed: { symbol: "configService.getRsvpConfig", investigateQuery: "RSVP field metadata boolean Yes No CSV" },
  serenaSeed: {
    symbols: ["configService"],
    files: ["web-src/src/services/configService.ts"],
    note: "configService is the RSVP-config source the future formatRsvpFieldValue feature reads; 'configService.getRsvpConfig' is a method call, not a resolvable symbol name.",
  },
});

export const futureTicketRequirementFieldMap = futureTask({
  id: "future-emc-ticket-requirement-field-map",
  podId: "pod-emc-configs",
  stratum: "S3",
  tags: ["registration", "api-contract", "stale-trap", "kg-decisive"],
  prompt: [
    "Implement `mapTicketRequirementForEsl(payload: Record<string, any>): Record<string, any>`.",
    "",
    "A generalized ticket gate now sends the old event-specific field name through the ESL attendee layer.",
    "Return the attendee payload using the canonical ESL field name and do not mutate the input.",
    "If both `requiresTicket` and `requiresSxswTicket` are present, preserve the existing canonical `requiresTicket` value and drop the old key.",
    "",
    "Export the function as a named export `mapTicketRequirementForEsl`.",
  ].join("\n"),
  expectedSignals: ["requiresTicket", "requiresSxswTicket", "ESL"],
  kgExpectations: {
    requiredFacts: [
      "Attendee API field `requiresTicket` is the canonical name",
      "prior `requiresSxswTicket` was renamed",
      "use generic field names",
    ],
    requiredSymbols: ["requiresTicket", "requiresSxswTicket"],
  },
  tests: [
    test("maps the old event-specific field to requiresTicket", [
      "const out = mod.mapTicketRequirementForEsl({ attendeeId: 'a-1', requiresSxswTicket: true, name: 'Ada' });",
      "assert.deepEqual(out, { attendeeId: 'a-1', requiresTicket: true, name: 'Ada' });",
    ]),
    test("preserves explicit false and removes the old key", [
      "const out = mod.mapTicketRequirementForEsl({ requiresSxswTicket: false });",
      "assert.equal(out.requiresTicket, false);",
      "assert.equal(Object.prototype.hasOwnProperty.call(out, 'requiresSxswTicket'), false);",
    ]),
    test("does not override existing canonical value", [
      "const out = mod.mapTicketRequirementForEsl({ requiresTicket: false, requiresSxswTicket: true });",
      "assert.equal(out.requiresTicket, false);",
      "assert.equal(Object.prototype.hasOwnProperty.call(out, 'requiresSxswTicket'), false);",
    ]),
  ],
  licSeed: { symbol: "requiresTicket", investigateQuery: "requiresSxswTicket canonical requiresTicket ESL attendee" },
});

export const futureSessionsHubSearchScope = futureTask({
  id: "future-emc-sessions-hub-search-scope",
  podId: "pod-emc-sessions",
  stratum: "S3",
  tags: ["sessions", "search", "negative-control", "kg-decisive"],
  prompt: [
    "Implement `matchesSessionsHubQuery(session: Record<string, any>, query: string, blockClasses?: string[]): boolean`.",
    "",
    "The sessions hub search is matching long descriptions by default, producing noisy results.",
    "Apply the EMC search scope convention, with the existing opt-in for description search.",
    "",
    "Export the function as a named export `matchesSessionsHubQuery`.",
  ].join("\n"),
  expectedSignals: ["title", "speaker names", "tag labels", "search-include-description"],
  kgExpectations: {
    requiredFacts: [
      "Sessions Hub text search is scoped to title, speaker names, and tag labels",
      "descriptions excluded by default",
      "search-include-description",
    ],
    requiredSymbols: ["search-include-description"],
  },
  tests: [
    test("matches title, speaker names, and tag labels by default", [
      "const session = { title: 'Opening Keynote', description: 'Hidden analytics', speakers: [{ name: 'Grace Hopper' }], tags: [{ label: 'AI' }] };",
      "assert.equal(mod.matchesSessionsHubQuery(session, 'keynote'), true);",
      "assert.equal(mod.matchesSessionsHubQuery(session, 'grace'), true);",
      "assert.equal(mod.matchesSessionsHubQuery(session, 'ai'), true);",
    ]),
    test("excludes description text unless the block class opts in", [
      "const session = { title: 'Opening', description: 'Quantum roadmap', speakers: [], tags: [] };",
      "assert.equal(mod.matchesSessionsHubQuery(session, 'quantum'), false);",
      "assert.equal(mod.matchesSessionsHubQuery(session, 'quantum', ['search-include-description']), true);",
    ]),
    test("handles blank queries as a match", [
      "assert.equal(mod.matchesSessionsHubQuery({ title: 'Any' }, '   '), true);",
    ]),
  ],
  licSeed: { symbol: "SessionsTab", investigateQuery: "sessions hub search title speaker tag labels description opt in" },
});

export const futureSessionLocationOverlap = futureTask({
  id: "future-emc-session-location-overlap",
  podId: "pod-emc-sessions",
  stratum: "S3",
  tags: ["sessions", "validation", "lic-favorable", "kg-decisive"],
  prompt: [
    "Implement `findSessionLocationConflicts(candidate: Record<string, any>, sessions: Record<string, any>[]): string[]`.",
    "",
    "A future location picker should warn before save when another session occupies the same location at the same time.",
    "Return the IDs of conflicting sessions using the EMC frontend validation convention.",
    "Do not import date helpers; implement the Date/UTC millisecond conversion inside this pure module.",
    "",
    "Export the function as a named export `findSessionLocationConflicts`.",
  ].join("\n"),
  expectedSignals: ["UTC", "startTimeMillis", "endTimeMillis", "locationId"],
  kgExpectations: {
    requiredFacts: [
      "Session location-time conflict validation",
      "FE checking interval overlap via UTC millisecond conversion",
      "BE as final arbiter",
    ],
    requiredSymbols: ["UTC", "location"],
  },
  tests: [
    test("finds overlapping intervals at the same location using Date/UTC milliseconds", [
      "const candidate = { sessionId: 'new', locationId: 'room-1', startTime: '2026-06-07T10:00:00-07:00', endTime: '2026-06-07T11:00:00-07:00' };",
      "const sessions = [{ sessionId: 'a', locationId: 'room-1', startTime: '2026-06-07T09:30:00-07:00', endTime: '2026-06-07T10:30:00-07:00' }, { sessionId: 'b', locationId: 'room-2', startTime: '2026-06-07T10:15:00-07:00', endTime: '2026-06-07T10:45:00-07:00' }];",
      "assert.deepEqual(mod.findSessionLocationConflicts(candidate, sessions), ['a']);",
    ]),
    test("does not count touching boundaries as overlap", [
      "const candidate = { sessionId: 'new', locationId: 'room-1', startTimeMillis: 1000, endTimeMillis: 2000 };",
      "const sessions = [{ sessionId: 'a', locationId: 'room-1', startTimeMillis: 2000, endTimeMillis: 3000 }];",
      "assert.deepEqual(mod.findSessionLocationConflicts(candidate, sessions), []);",
    ]),
    test("ignores the candidate itself", [
      "const candidate = { sessionId: 'a', locationId: 'room-1', startTimeMillis: 1000, endTimeMillis: 2000 };",
      "const sessions = [{ sessionId: 'a', locationId: 'room-1', startTimeMillis: 1000, endTimeMillis: 2000 }];",
      "assert.deepEqual(mod.findSessionLocationConflicts(candidate, sessions), []);",
    ]),
  ],
  licSeed: { symbol: "naiveDateTimeToUTCMillis", investigateQuery: "session location time overlap UTC validation" },
});

export const futurePartnerTierReorder = futureTask({
  id: "future-emc-partner-tier-reorder",
  podId: "pod-emc-sessions",
  stratum: "S2",
  tags: ["speakers", "sponsors", "ordering", "kg-decisive"],
  prompt: [
    "Implement `movePartnerToTier(items: Record<string, any>[], movedId: string, newTier: string): Record<string, any>[]`.",
    "",
    "A drag-and-drop partner editor changes an item's tier but leaves stale ordering values in both groups.",
    "Return the reordered list using EMC's grouped sponsor/speaker ordering convention.",
    "",
    "Export the function as a named export `movePartnerToTier`.",
  ].join("\n"),
  expectedSignals: ["role", "tier", "ordinal", "move to the end"],
  kgExpectations: {
    requiredFacts: [
      "Speakers and sponsors are grouped by role/tier",
      "role/tier changes move items to the end of the new group",
      "per-group ordinal recomputation",
    ],
    requiredSymbols: ["ordinal", "sponsors", "speakers"],
  },
  tests: [
    test("moves the item to the end of the new tier and recomputes ordinals per tier", [
      "const items = [{ id: 'a', tier: 'gold', ordinal: 0 }, { id: 'b', tier: 'gold', ordinal: 1 }, { id: 'c', tier: 'silver', ordinal: 0 }];",
      "const out = mod.movePartnerToTier(items, 'a', 'silver');",
      "assert.deepEqual(out, [{ id: 'b', tier: 'gold', ordinal: 0 }, { id: 'c', tier: 'silver', ordinal: 0 }, { id: 'a', tier: 'silver', ordinal: 1 }]);",
    ]),
    test("reorders within the same tier by moving the selected item to the end", [
      "const items = [{ id: 'a', tier: 'gold', ordinal: 0 }, { id: 'b', tier: 'gold', ordinal: 1 }];",
      "assert.deepEqual(mod.movePartnerToTier(items, 'a', 'gold'), [{ id: 'b', tier: 'gold', ordinal: 0 }, { id: 'a', tier: 'gold', ordinal: 1 }]);",
    ]),
    test("does not mutate the source list", [
      "const items = [{ id: 'a', tier: 'gold', ordinal: 0 }];",
      "mod.movePartnerToTier(items, 'a', 'silver');",
      "assert.deepEqual(items, [{ id: 'a', tier: 'gold', ordinal: 0 }]);",
    ]),
  ],
  licSeed: { symbol: "SpeakersDashboard", investigateQuery: "speakers sponsors role tier drag reorder ordinal" },
});

export const KG_FUTURE_20_TASKS: Task[] = [
  futureEventModeratorPutContract,
  futureSessionTrackPutSanitizer,
  futureBreakoutTimeResponseState,
  futureRsvpContactMethodsPut,
  futureDetailPagePathFilterToggle,
  futureEventWizardStepGrouping,
  futureAgendaSwitcherSegmentedControl,
  futureRichTextSemanticExport,
  futureProdPublishConfirmation,
  futurePpnExplicitNoChoice,
  futureSpeakerPhotoHydrationJoin,
  futureShowSponsorsDefault,
  futureEventsDashboardPermissionFilter,
  futureInviteOnlyRsvpState,
  futureCampaignCapacityDecision,
  futureRsvpBooleanFieldDisplay,
  futureTicketRequirementFieldMap,
  futureSessionsHubSearchScope,
  futureSessionLocationOverlap,
  futurePartnerTierReorder,
];
