import type { Task } from "../../types.js";

export const synthSessionTimeResponseState: Task = {
  id: "synth-session-time-response-state",
  type: "code",
  podId: "pod-emc-sessions",
  stratum: "S4",
  tags: ["synthetic", "context-stress", "pim-needed", "sessions", "state"],
  prompt: [
    "Implement `mergeSessionTimeSave(session: Record<string, any>, apiResult: Record<string, any>): Record<string, any>`.",
    "",
    "The save call for a session time now returns the server's session-time record. Users reported that after editing a session time, the form still looked stale until a full refresh.",
    "Follow the EMC convention for API helpers that return server-issued IDs and optimistic-concurrency timestamps.",
    "",
    "Return a new session object and do not mutate the input session.",
    "Export the function as a named export `mergeSessionTimeSave`.",
  ].join("\n"),
  expectedSignals: ["sessionTimeId", "creationTime", "modificationTime", "startTimeMillis", "endTimeMillis"],
  tests: [
    {
      name: "propagates server-issued session-time identifiers and timestamps into state",
      body: [
        "const session = { id: 'sess-1', name: 'Opening', sessionTimeId: 'old', sessionTimeCreationTime: 10, sessionTimeModificationTime: 20, startTimeMillis: 100, endTimeMillis: 200, timezone: 'America/Los_Angeles' };",
        "const apiResult = { sessionTimeId: 'time-9', creationTime: 111, modificationTime: 222, startTimeMillis: 300, endTimeMillis: 450, timezone: 'Europe/Paris' };",
        "const out = mod.mergeSessionTimeSave(session, apiResult);",
        "assert.equal(out.sessionTimeId, 'time-9');",
        "assert.equal(out.sessionTimeCreationTime, 111);",
        "assert.equal(out.sessionTimeModificationTime, 222);",
        "assert.equal(out.startTimeMillis, 300);",
        "assert.equal(out.endTimeMillis, 450);",
        "assert.equal(out.timezone, 'Europe/Paris');",
      ].join("\n"),
    },
    {
      name: "keeps existing unrelated session fields and does not mutate input",
      body: [
        "const session = { id: 'sess-1', name: 'Opening', speakerIds: ['a'], startTimeMillis: 100, endTimeMillis: 200 };",
        "const out = mod.mergeSessionTimeSave(session, { sessionTimeId: 'time-1', creationTime: 1, modificationTime: 2, startTimeMillis: 120, endTimeMillis: 240 });",
        "assert.deepEqual(session, { id: 'sess-1', name: 'Opening', speakerIds: ['a'], startTimeMillis: 100, endTimeMillis: 200 });",
        "assert.deepEqual(out.speakerIds, ['a']);",
        "assert.equal(out.name, 'Opening');",
      ].join("\n"),
    },
    {
      name: "falls back to stable alternate response field names used by ESP clients",
      body: [
        "const out = mod.mergeSessionTimeSave({ id: 'sess-1' }, { id: 'time-2', createdAt: 11, updatedAt: 22, startTimeMillis: 500, endTimeMillis: 600 });",
        "assert.equal(out.sessionTimeId, 'time-2');",
        "assert.equal(out.sessionTimeCreationTime, 11);",
        "assert.equal(out.sessionTimeModificationTime, 22);",
      ].join("\n"),
    },
  ],
};
