import type { Task } from "../../types.js";

export const configCacheBust: Task = {
  id: "config-cache-bust",
  type: "code",
  podId: "pod-emc-configs",
  tags: ["configs"],
  prompt: [
    "Implement a small ConfigCache class for the ConfigService. Export it as a named export `ConfigCache`.",
    "",
    "API:",
    "  class ConfigCache {",
    "    constructor(opts: { ttlMs: number; nowMs: () => number });",
    "    get(key: string): unknown | undefined;",
    "    set(key: string, value: unknown): void;",
    "    invalidateForSession(key: string, sessionId: string): void;",
    "    read(key: string, sessionId: string): unknown | undefined;",
    "  }",
    "",
    "Behavior:",
    "- `set(key, value)` records the value with the current `nowMs()` timestamp.",
    "- `get(key)` returns the value if `nowMs() - storedAt < ttlMs`, else `undefined`.",
    "- `invalidateForSession(key, sessionId)` marks the cache stale for that specific sessionId only — subsequent `read(key, sessionId)` returns undefined for that session, but `read(key, otherSessionId)` still returns the cached value while the TTL holds.",
    "- `read(key, sessionId)` returns undefined if the session has invalidated the key, else behaves like `get(key)`.",
    "",
    "This implements the write-through bust pattern: when an admin writes a config, their own session sees the change immediately while other sessions tolerate the TTL.",
  ].join("\n"),
  expectedSignals: ["session", "TTL", "5-min", "write-through", "invalidate"],
  tests: [
    {
      name: "set then get returns the value within ttl",
      body: [
        "let now = 1000;",
        "const c = new mod.ConfigCache({ ttlMs: 5000, nowMs: () => now });",
        "c.set('rsvp', { fields: 3 });",
        "now = 2000;",
        "assert.deepEqual(c.get('rsvp'), { fields: 3 });",
      ].join("\n"),
    },
    {
      name: "get returns undefined after ttl expires",
      body: [
        "let now = 1000;",
        "const c = new mod.ConfigCache({ ttlMs: 100, nowMs: () => now });",
        "c.set('rsvp', { fields: 3 });",
        "now = 2000;",
        "assert.equal(c.get('rsvp'), undefined);",
      ].join("\n"),
    },
    {
      name: "invalidateForSession busts cache for that session only",
      body: [
        "let now = 1000;",
        "const c = new mod.ConfigCache({ ttlMs: 5000, nowMs: () => now });",
        "c.set('rsvp', { fields: 3 });",
        "c.invalidateForSession('rsvp', 'admin-A');",
        "now = 1100;",
        "assert.equal(c.read('rsvp', 'admin-A'), undefined, \"editing session should see fresh read (no cache hit)\");",
        "assert.deepEqual(c.read('rsvp', 'viewer-B'), { fields: 3 }, 'other sessions still hit the cache during the TTL window');",
      ].join("\n"),
    },
  ],
};
