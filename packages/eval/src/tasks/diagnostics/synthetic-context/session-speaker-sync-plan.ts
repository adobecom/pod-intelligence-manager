import type { Task } from "../../types.js";

export const synthSessionSpeakerSyncPlan: Task = {
  id: "synth-session-speaker-sync-plan",
  type: "code",
  podId: "pod-emc-sessions",
  stratum: "S2",
  tags: ["synthetic", "context-stress", "lic-needed", "sessions", "speakers"],
  prompt: [
    "Implement `planSessionSpeakerSync(currentSpeakerIds: string[], originalSpeakerIds: string[]): { add: string[]; remove: string[] }`.",
    "",
    "This mirrors the existing session speaker sync helper. It should avoid redundant API calls and preserve the ordering behavior callers already rely on.",
    "",
    "Export the function as a named export `planSessionSpeakerSync`.",
  ].join("\n"),
  expectedSignals: ["currentSpeakerIds", "originalSpeakerIds", "add", "remove"],
  tests: [
    {
      name: "adds current-only speakers in current order and removes original-only speakers in original order",
      body: [
        "const out = mod.planSessionSpeakerSync(['b', 'c', 'a', 'c'], ['a', 'd', 'b', 'e']);",
        "assert.deepEqual(out, { add: ['c'], remove: ['d', 'e'] });",
      ].join("\n"),
    },
    {
      name: "deduplicates repeated current ids before planning",
      body: [
        "const out = mod.planSessionSpeakerSync(['a', 'a', 'b', 'b'], []);",
        "assert.deepEqual(out.add, ['a', 'b']);",
        "assert.deepEqual(out.remove, []);",
      ].join("\n"),
    },
    {
      name: "does not mutate inputs",
      body: [
        "const current = ['a', 'b'];",
        "const original = ['b', 'c'];",
        "mod.planSessionSpeakerSync(current, original);",
        "assert.deepEqual(current, ['a', 'b']);",
        "assert.deepEqual(original, ['b', 'c']);",
      ].join("\n"),
    },
  ],
};
