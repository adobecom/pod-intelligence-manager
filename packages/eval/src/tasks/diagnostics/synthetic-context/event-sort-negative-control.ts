import type { Task } from "../../types.js";

export const synthEventSortNegativeControl: Task = {
  id: "synth-event-sort-negative-control",
  type: "code",
  podId: "pod-emc-configs",
  stratum: "S1",
  tags: ["synthetic", "negative-control", "fully-specified"],
  prompt: [
    "Implement `sortEventsByStart(events: Array<{ id: string; startTimeMillis?: number; title?: string }>): string[]`.",
    "",
    "Return event IDs sorted by ascending `startTimeMillis`. Missing `startTimeMillis` sorts last. Ties sort by `title` ascending, then by `id` ascending. Do not mutate the input array.",
    "",
    "Export the function as a named export `sortEventsByStart`.",
  ].join("\n"),
  expectedSignals: ["startTimeMillis", "sort", "id"],
  tests: [
    {
      name: "sorts by start time, then title, then id",
      body: [
        "const events = [",
        "  { id: 'c', title: 'Beta', startTimeMillis: 20 },",
        "  { id: 'b', title: 'Alpha', startTimeMillis: 10 },",
        "  { id: 'a', title: 'Beta', startTimeMillis: 10 },",
        "  { id: 'd', title: 'Later' },",
        "];",
        "assert.deepEqual(mod.sortEventsByStart(events), ['b', 'a', 'c', 'd']);",
      ].join("\n"),
    },
    {
      name: "missing start times sort last and input is not mutated",
      body: [
        "const events = [{ id: 'z' }, { id: 'a', startTimeMillis: 1 }];",
        "const copy = JSON.stringify(events);",
        "assert.deepEqual(mod.sortEventsByStart(events), ['a', 'z']);",
        "assert.equal(JSON.stringify(events), copy);",
      ].join("\n"),
    },
  ],
};
