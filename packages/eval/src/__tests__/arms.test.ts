import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { controlArm, kgOnlyArm, pimFullArm } from "../arms/index.js";
import type { SessionContextFixture } from "../arms/types.js";
import { rbacPermissionResolution } from "../tasks/diagnostics/code-gen/rbac-permission-resolution.js";
import { rbacDecisionRationale } from "../tasks/diagnostics/content-gen/rbac-decision-rationale.js";

const __filename = fileURLToPath(import.meta.url);
const FIXTURE_PATH = join(dirname(__filename), "..", "..", "fixtures", "session-contexts", "pod-emc-rbac.json");

async function loadRbac(): Promise<SessionContextFixture> {
  const raw = await readFile(FIXTURE_PATH, "utf8");
  return JSON.parse(raw) as SessionContextFixture;
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

  it("control system prompt for code tasks asks for a fenced TS block", () => {
    const segments = controlArm.build(rbacPermissionResolution, null);
    expect(segments.system).toContain("```typescript");
  });

  it("control system prompt for content tasks does not mention TypeScript", () => {
    const segments = controlArm.build(rbacDecisionRationale, null);
    expect(segments.system.toLowerCase()).not.toContain("typescript");
  });
});
