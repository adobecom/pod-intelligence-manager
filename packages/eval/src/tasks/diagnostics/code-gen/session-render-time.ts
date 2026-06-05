import type { Task } from "../../types.js";

export const sessionRenderTime: Task = {
  id: "session-render-time",
  type: "code",
  podId: "pod-emc-sessions",
  tags: ["sessions"],
  prompt: [
    "Implement `renderSessionTime(utcMillis: number, ianaTz: string): string` for the EMC session UI.",
    "",
    "Behavior:",
    "- Given a UTC milliseconds timestamp and an IANA timezone, return a naive datetime string of the form `'YYYY-MM-DD HH:MM'` representing the local clock time at that timezone.",
    "- The returned string must NOT include a UTC offset or a `Z` suffix — it represents what the user sees on the clock at the venue.",
    "- 24-hour clock. Zero-pad month, day, hour, and minute.",
    "",
    "Use `Intl.DateTimeFormat` (or equivalent) — no external packages.",
    "",
    "Export the function as a named export `renderSessionTime`.",
  ].join("\n"),
  expectedSignals: ["IANA", "Intl", "DateTimeFormat"],
  tests: [
    {
      name: "renders a known instant in PDT (America/Los_Angeles)",
      body: [
        "// 2026-06-15 16:00:00Z = 09:00 in PDT",
        "const out = mod.renderSessionTime(Date.UTC(2026, 5, 15, 16, 0, 0), 'America/Los_Angeles');",
        "assert.equal(out, '2026-06-15 09:00', `got ${out}`);",
      ].join("\n"),
    },
    {
      name: "renders the same instant in Tokyo as 9 hours ahead of UTC",
      body: [
        "// 2026-06-15 16:00:00Z = 2026-06-16 01:00 JST",
        "const out = mod.renderSessionTime(Date.UTC(2026, 5, 15, 16, 0, 0), 'Asia/Tokyo');",
        "assert.equal(out, '2026-06-16 01:00', `got ${out}`);",
      ].join("\n"),
    },
    {
      name: "does not include a Z or +offset suffix",
      body: [
        "const out = mod.renderSessionTime(Date.UTC(2026, 0, 1, 12, 0, 0), 'UTC');",
        "assert.ok(!out.includes('Z'), 'output must not end with Z');",
        "assert.ok(!out.match(/[+-]\\d\\d:?\\d\\d$/), 'output must not include a numeric UTC offset');",
      ].join("\n"),
    },
  ],
};
