import type { Task } from "../../types.js";

export const synthSeriesPutUpdatePlan: Task = {
  id: "synth-series-put-update-plan",
  type: "code",
  podId: "pod-emc-sessions",
  stratum: "S2",
  tags: ["synthetic", "context-stress", "combined-needed", "api", "esp", "series"],
  prompt: [
    "Implement `buildSeriesPutUpdatePlan(draft: Record<string, any>, current: Record<string, any>): { helper: string; payload: Record<string, any> }`.",
    "",
    "A new series update path needs to follow the EMC PUT payload policy and the existing series-service call-site pattern. Return the helper name to use and the payload that should be passed to it.",
    "",
    "Export the function as a named export `buildSeriesPutUpdatePlan`.",
  ].join("\n"),
  expectedSignals: ["prepareEspSeriesPutPayload", "seriesId", "seriesStatus", "modificationTime"],
  tests: [
    {
      name: "selects the established series PUT helper and preserves server-owned identity fields",
      body: [
        "const draft = { title: 'Updated', seriesId: 'bad-draft-id', seriesStatus: 'draft', targetCms: 'should-not-survive' };",
        "const current = { seriesId: 'series-1', seriesStatus: 'published', modificationTime: 123, title: 'Old', targetCms: 'readonly' };",
        "const out = mod.buildSeriesPutUpdatePlan(draft, current);",
        "assert.equal(out.helper, 'prepareEspSeriesPutPayload');",
        "assert.equal(out.payload.seriesId, 'series-1');",
        "assert.equal(out.payload.seriesStatus, 'published');",
        "assert.equal(out.payload.modificationTime, 123);",
        "assert.equal(out.payload.title, 'Updated');",
        "assert.equal(Object.prototype.hasOwnProperty.call(out.payload, 'targetCms'), false);",
      ].join("\n"),
    },
    {
      name: "does not mutate draft or current records",
      body: [
        "const draft = { title: 'Updated', targetCms: 'drop' };",
        "const current = { seriesId: 'series-1', seriesStatus: 'published', modificationTime: 123 };",
        "mod.buildSeriesPutUpdatePlan(draft, current);",
        "assert.deepEqual(draft, { title: 'Updated', targetCms: 'drop' });",
        "assert.deepEqual(current, { seriesId: 'series-1', seriesStatus: 'published', modificationTime: 123 });",
      ].join("\n"),
    },
    {
      name: "does not invent helper names for other resources",
      body: [
        "const out = mod.buildSeriesPutUpdatePlan({}, { seriesId: 'series-1', seriesStatus: 'archived', modificationTime: 5 });",
        "assert.equal(out.helper, 'prepareEspSeriesPutPayload');",
        "assert.deepEqual(Object.keys(out.payload).sort(), ['modificationTime', 'seriesId', 'seriesStatus'].sort());",
      ].join("\n"),
    },
  ],
};
