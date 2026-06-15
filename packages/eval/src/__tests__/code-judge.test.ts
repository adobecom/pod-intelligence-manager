import { describe, it, expect } from "vitest";
import { judgeCode } from "../judges/code.js";
import { configDeepMerge } from "../tasks/diagnostics/code-gen/config-deep-merge.js";
import { sessionCreateTimezone } from "../tasks/diagnostics/code-gen/session-create-timezone.js";
import type { Task } from "../tasks/types.js";

const goodConfigDeepMerge = `
\`\`\`typescript
export function resolveConfig(parent: Record<string, unknown>, child: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(parent)) out[k] = clone(parent[k]);
  for (const k of Object.keys(child)) {
    const pv = out[k];
    const cv = child[k];
    if (isPlainObject(pv) && isPlainObject(cv)) {
      out[k] = resolveConfig(pv as Record<string, unknown>, cv as Record<string, unknown>);
    } else {
      out[k] = clone(cv);
    }
  }
  return out;
}
function isPlainObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}
function clone(x: unknown): unknown {
  return typeof x === "object" && x !== null ? JSON.parse(JSON.stringify(x)) : x;
}
\`\`\`
`;

const badConfigFullReplace = `
\`\`\`typescript
// Implements full-replace, which is the *wrong* answer per C-301's PIM analysis.
export function resolveConfig(parent: Record<string, unknown>, child: Record<string, unknown>): Record<string, unknown> {
  return Object.keys(child).length > 0 ? { ...child } : { ...parent };
}
\`\`\`
`;

const noCodeBlock = `Here's how I would implement it: just spread parent and child together, with child winning on conflicts.`;

describe("judgeCode", () => {
  it("passes a correct deep-merge implementation", async () => {
    const result = await judgeCode(configDeepMerge, goodConfigDeepMerge);
    expect(result.passed, `expected pass, detail=${result.detail}, failures=${JSON.stringify(result.failures)}`).toBe(true);
    expect(result.score).toBe(1);
  }, 60_000);

  it("fails a full-replace implementation (the wrong answer for C-301)", async () => {
    const result = await judgeCode(configDeepMerge, badConfigFullReplace);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.failures && result.failures.length > 0).toBe(true);
  }, 60_000);

  it("fails when there's no fenced code block", async () => {
    const result = await judgeCode(configDeepMerge, noCodeBlock);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("no fenced code block");
  });

  it("passes a timezone implementation that uses Intl.DateTimeFormat", async () => {
    const correctTimezone = `
\`\`\`typescript
export function createSessionPayload(input: { title: string; startNaive: string; endNaive: string; ianaTz: string }): { title: string; startUtcMillis: number; endUtcMillis: number; ianaTz: string } {
  return {
    title: input.title,
    startUtcMillis: naiveToUtc(input.startNaive, input.ianaTz),
    endUtcMillis: naiveToUtc(input.endNaive, input.ianaTz),
    ianaTz: input.ianaTz,
  };
}
function naiveToUtc(naive: string, tz: string): number {
  const [datePart, timePart] = naive.split("T");
  const [yyyy, mm, dd] = datePart.split("-").map(Number);
  const [HH, MM, SS = "0"] = timePart.split(":");
  const guessUtc = Date.UTC(yyyy, mm - 1, dd, Number(HH), Number(MM), Number(SS));
  const tzOffset = offsetMs(guessUtc, tz);
  return guessUtc - tzOffset;
}
function offsetMs(utcMillis: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(utcMillis));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  let h = get("hour");
  if (h === 24) h = 0;
  const local = Date.UTC(get("year"), get("month") - 1, get("day"), h, get("minute"), get("second"));
  return local - utcMillis;
}
\`\`\`
`;
    const result = await judgeCode(sessionCreateTimezone, correctTimezone);
    expect(result.passed, `detail=${result.detail}, failures=${JSON.stringify(result.failures)}`).toBe(true);
  }, 60_000);

  it("stubs relative repo imports instead of crashing the pure-module harness", async () => {
    const task: Task = {
      id: "import-stub",
      type: "code",
      podId: "pod-x",
      prompt: "return a plan",
      tests: [{
        name: "runs candidate despite relative import",
        body: [
          "const out = mod.buildPlan({ title: 'New' }, { id: 'track-1', modificationTime: 3 });",
          "assert.deepEqual(out, { helper: 'prepareEspSessionTrackPutPayload', payload: { id: 'track-1', modificationTime: 3, title: 'New' } });",
        ].join("\n"),
      }],
    };
    const output = `
\`\`\`typescript
import { prepareEspSessionTrackPutPayload } from "./utils/dataFilters";

export function buildPlan(draft: Record<string, any>, current: Record<string, any>) {
  return {
    helper: prepareEspSessionTrackPutPayload.name,
    payload: { id: current.id, modificationTime: current.modificationTime, title: draft.title },
  };
}
\`\`\`
`;

    const result = await judgeCode(task, output);
    expect(result.passed, `detail=${result.detail}, failures=${JSON.stringify(result.failures)}`).toBe(true);
  }, 60_000);
});
