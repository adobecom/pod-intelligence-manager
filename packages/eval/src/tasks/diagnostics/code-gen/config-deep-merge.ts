import type { Task } from "../../types.js";

export const configDeepMerge: Task = {
  id: "config-deep-merge",
  type: "code",
  podId: "pod-emc-configs",
  tags: ["configs", "smoke"],
  prompt: [
    "Implement `resolveConfig(parent: Record<string, unknown>, child: Record<string, unknown>): Record<string, unknown>`.",
    "",
    "This resolves a team-level config against an org-level config. The inheritance model is **deep-merge**:",
    "- For each key in `parent` and `child`, if both values are plain objects (not arrays), recursively merge them.",
    "- Otherwise, `child`'s value wins (including for arrays — child fully replaces parent's array).",
    "- Keys present only in `parent` are kept. Keys present only in `child` are added.",
    "- Do NOT mutate `parent` or `child`; return a new object.",
    "",
    "Export the function as a named export `resolveConfig`.",
  ].join("\n"),
  expectedSignals: ["deep-merge", "merge"],
  tests: [
    {
      name: "merges nested objects, child overrides leaf values",
      body: [
        "const parent = { ui: { theme: 'light', density: 'compact' }, ttl: 300 };",
        "const child = { ui: { density: 'cozy' } };",
        "const out = mod.resolveConfig(parent, child);",
        "assert.deepEqual(out, { ui: { theme: 'light', density: 'cozy' }, ttl: 300 });",
      ].join("\n"),
    },
    {
      name: "child arrays fully replace parent arrays (no concatenation)",
      body: [
        "const parent = { fields: [{ id: 'name' }, { id: 'email' }] };",
        "const child = { fields: [{ id: 'phone' }] };",
        "const out = mod.resolveConfig(parent, child);",
        "assert.deepEqual(out, { fields: [{ id: 'phone' }] });",
      ].join("\n"),
    },
    {
      name: "keys only in parent are preserved when child is empty",
      body: [
        "const parent = { rsvp: { fields: ['name'], required: true } };",
        "const out = mod.resolveConfig(parent, {});",
        "assert.deepEqual(out, { rsvp: { fields: ['name'], required: true } });",
      ].join("\n"),
    },
    {
      name: "does not mutate the inputs",
      body: [
        "const parent = { a: { b: 1 } };",
        "const child = { a: { b: 2 } };",
        "const out = mod.resolveConfig(parent, child);",
        "assert.equal((parent.a as any).b, 1, 'parent must not be mutated');",
        "assert.equal((child.a as any).b, 2, 'child must not be mutated');",
        "assert.equal((out.a as any).b, 2);",
      ].join("\n"),
    },
  ],
};
