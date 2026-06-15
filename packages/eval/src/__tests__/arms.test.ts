import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { controlArm, kgCompactArm, kgOnlyArm, pimFullArm } from "../arms/index.js";
import type { SessionContextFixture } from "../arms/types.js";
import { rbacPermissionResolution } from "../tasks/diagnostics/code-gen/rbac-permission-resolution.js";
import { rbacDecisionRationale } from "../tasks/diagnostics/content-gen/rbac-decision-rationale.js";
import {
  futureEventModeratorPutContract,
  futureSessionLocationOverlap,
  futureSpeakerPhotoHydrationJoin,
} from "../tasks/primary/kg-future/index.js";
import type { Task } from "../tasks/types.js";

const __filename = fileURLToPath(import.meta.url);
const FIXTURE_DIR = join(dirname(__filename), "..", "..", "fixtures", "session-contexts");
const FIXTURE_PATH = join(FIXTURE_DIR, "pod-emc-rbac.json");

async function loadRbac(): Promise<SessionContextFixture> {
  const raw = await readFile(FIXTURE_PATH, "utf8");
  return JSON.parse(raw) as SessionContextFixture;
}

async function loadFixture(podId: string): Promise<SessionContextFixture> {
  const raw = await readFile(join(FIXTURE_DIR, `${podId}.json`), "utf8");
  return JSON.parse(raw) as SessionContextFixture;
}

async function renderContractCard(task: Task): Promise<string> {
  const previous = process.env.PIM_EVAL_KG_CONTEXT_MODE;
  process.env.PIM_EVAL_KG_CONTEXT_MODE = "contract-card";
  try {
    const fixture = await loadFixture(task.podId);
    return kgOnlyArm.build(task, fixture).pimContext ?? "";
  } finally {
    if (previous === undefined) delete process.env.PIM_EVAL_KG_CONTEXT_MODE;
    else process.env.PIM_EVAL_KG_CONTEXT_MODE = previous;
  }
}

async function renderCompactKg(task: Task, fixtureOverride?: SessionContextFixture): Promise<string | undefined> {
  const fixture = fixtureOverride ?? (await loadFixture(task.podId));
  return kgCompactArm.build(task, fixture).pimContext;
}

describe("arms", () => {
  it("control arm produces no PIM context", async () => {
    const fixture = await loadRbac();
    const segments = controlArm.build(rbacPermissionResolution, fixture);
    expect(segments.pimContext).toBeUndefined();
    expect(segments.userTask).toContain("pod-emc-rbac");
    expect(segments.userTask).toContain("RBAC Permission System");
    // The user task must NOT contain the conflict ID — otherwise control isn't really a control.
    expect(segments.userTask).not.toContain("C-101");
  });

  it("pim-full arm injects the living doc, conflicts, learnings, and updates", async () => {
    const fixture = await loadRbac();
    const segments = pimFullArm.build(rbacPermissionResolution, fixture);
    const ctx = segments.pimContext ?? "";
    expect(ctx.length).toBeGreaterThan(2000); // ~3-4k tokens, ~12-15k chars
    expect(ctx).toContain("C-101");
    expect(ctx).toContain("GroupContext");
    expect(ctx).toContain("ESP API");
    expect(ctx).toContain("8% of first-time logins");
    expect(ctx).toContain("Open Conflicts (full detail)");
    expect(ctx).toContain("Relevant Org Learnings");
    expect(ctx).toContain("Recent Context Updates");
  });

  it("pim-full system prompt instructs to use PIM context", async () => {
    const fixture = await loadRbac();
    const segments = pimFullArm.build(rbacDecisionRationale, fixture);
    expect(segments.system).toContain("PIM living doc");
  });

  it("pim-full arm throws when called with null fixture", () => {
    expect(() => pimFullArm.build(rbacPermissionResolution, null)).toThrow(/requires a fixture/);
  });

  it("kg-only prefers task-scoped learnings when the fixture has them", async () => {
    const fixture = await loadRbac();
    const taskScopedSummary = "Task-specific KG fact for this exact eval task";
    const podFallbackSummary = "Pod-level fallback KG fact";
    const scopedFixture: SessionContextFixture = {
      ...fixture,
      payload: {
        ...fixture.payload,
        relevantLearnings: {
          nodes: [
            {
              type: "pattern",
              summary: podFallbackSummary,
              details: "",
              domains: ["frontend"],
              confidence_score: 0.9,
            },
          ],
          total_matching: 1,
          truncated: false,
        },
        taskRelevantLearnings: {
          [rbacPermissionResolution.id]: {
            nodes: [
              {
                type: "pattern",
                summary: taskScopedSummary,
                details: "",
                domains: ["frontend"],
                confidence_score: 0.9,
              },
            ],
            total_matching: 1,
            truncated: false,
          },
        },
      },
    };

    const segments = kgOnlyArm.build(rbacPermissionResolution, scopedFixture);
    expect(segments.pimContext).toContain(taskScopedSummary);
    expect(segments.pimContext).not.toContain(podFallbackSummary);
    expect(segments.pimContext).toContain("KG retrieval scope: task");
  });

  it("contract-card mode extracts the moderator PUT fallback contract", async () => {
    const ctx = await renderContractCard(futureEventModeratorPutContract);

    expect(ctx).toContain("task prompt API/input/output shape is authoritative");
    expect(ctx).toContain("{ speakerId, speakerType, ordinal, creationTime, modificationTime }");
    expect(ctx).toContain("body.X ?? dependentData.X");
    expect(ctx).toContain("Anti-pattern:");
    expect(ctx).toContain("Do not spread GET response into PUT body");
    expect(ctx.length).toBeLessThanOrEqual(1800);
  });

  it("contract-card mode preserves speaker photo hydration constraints", async () => {
    const ctx = await renderContractCard(futureSpeakerPhotoHydrationJoin);

    expect(ctx).toContain("imagekind#speaker-photo");
    expect(ctx).toContain("imagesMgr.list()");
    expect(ctx).toContain("without photo field");
    expect(ctx.length).toBeLessThanOrEqual(1800);
  });

  it("contract-card mode preserves location overlap contract details", async () => {
    const ctx = await renderContractCard(futureSessionLocationOverlap);

    expect(ctx).toContain("locationId");
    expect(ctx).toContain("UTC millis");
    expect(ctx).toContain("currentStart < sEnd && currentEnd > sStart");
    expect(ctx.length).toBeLessThanOrEqual(1800);
  });

  it("kg-compact extracts a gated top-3 contract context", async () => {
    const ctx = (await renderCompactKg(futureEventModeratorPutContract)) ?? "";

    expect(ctx).toContain("PIM KG Compact Context");
    expect(ctx).toContain("task prompt API/input/output shape is authoritative");
    expect(ctx).toContain("{ speakerId, speakerType, ordinal, creationTime, modificationTime }");
    expect(ctx).toContain("Do not spread GET response into PUT body");
    expect(ctx).toContain("modificationTime");
    expect(ctx).not.toContain("prepareEsp{Resource}PutPayload");
    expect(ctx.length).toBeLessThanOrEqual(1000);
  });

  it("kg-compact omits context when retrieved learnings do not match task signals", async () => {
    const fixture = await loadRbac();
    const scopedFixture: SessionContextFixture = {
      ...fixture,
      payload: {
        ...fixture.payload,
        taskRelevantLearnings: {
          [rbacPermissionResolution.id]: {
            nodes: [
              {
                type: "pattern",
                summary: "EMC dark mode follows React Spectrum color tokens",
                details: "Use semantic CSS tokens for dark mode and avoid local color literals.",
                domains: ["frontend"],
                confidence_score: 0.9,
              },
            ],
            total_matching: 1,
            truncated: false,
          },
        },
      },
    };

    expect(await renderCompactKg(rbacPermissionResolution, scopedFixture)).toBeUndefined();
  });

  it("control system prompt for code tasks asks for a fenced TS block", () => {
    const segments = controlArm.build(rbacPermissionResolution, null);
    expect(segments.system).toContain("```typescript");
  });

  it("control system prompt for content tasks does not mention TypeScript", () => {
    const segments = controlArm.build(rbacDecisionRationale, null);
    expect(segments.system.toLowerCase()).not.toContain("typescript");
  });
});
