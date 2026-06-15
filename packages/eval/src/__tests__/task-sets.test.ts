import { describe, expect, it } from "vitest";
import {
  ALL_TASKS,
  DEFAULT_TASKS,
  DIAGNOSTIC_TASKS,
  EXCLUDED_TASKS,
  KG_CONTROL_SOLVABLE_TASKS,
  KG_DECISIVE_TASKS,
  KG_FUTURE_20_TASKS_REGISTERED,
  KG_LIC_FAVORABLE_TASKS,
  KG_NEGATIVE_CONTROL_TASKS,
  PRIMARY_TASKS,
  parseTaskSetName,
  pickTasks,
  taskSetTasks,
} from "../tasks/index.js";
import {
  DIAGNOSTIC_TASK_IDS,
  EXCLUDED_TASK_IDS,
  KG_CONTROL_SOLVABLE_TASK_IDS,
  KG_DECISIVE_TASK_IDS,
  KG_DECISIVE_TASK_REASONS,
  KG_FUTURE_20_TASK_IDS,
  KG_FUTURE_20_TASK_REASONS,
  KG_LIC_FAVORABLE_TASK_IDS,
  KG_NEGATIVE_CONTROL_TASK_IDS,
  PRIMARY_15_TASK_IDS,
} from "../tasks/task-sets.js";
import type { Task } from "../tasks/types.js";

function ids(tasks: Task[]): string[] {
  return tasks.map((task) => task.id);
}

function expectNoOverlap(left: readonly string[], right: readonly string[]): void {
  const rightSet = new Set(right);
  expect(left.filter((id) => rightSet.has(id))).toEqual([]);
}

describe("task sets", () => {
  it("uses the 15 primary tasks as the unfiltered default", () => {
    expect(PRIMARY_TASKS).toHaveLength(15);
    expect(ids(PRIMARY_TASKS)).toEqual([...PRIMARY_15_TASK_IDS]);
    expect(DEFAULT_TASKS).toBe(PRIMARY_TASKS);
    expect(ids(pickTasks())).toEqual(ids(PRIMARY_TASKS));
    expect(ids(pickTasks({}))).toEqual(ids(PRIMARY_TASKS));
  });

  it("keeps registered task sets complete and disjoint", () => {
    const allIds = ids(ALL_TASKS);
    const registeredIds = new Set(allIds);
    expect(registeredIds.size).toBe(ALL_TASKS.length);

    expect(ids(DIAGNOSTIC_TASKS)).toEqual([...DIAGNOSTIC_TASK_IDS]);
    expect(ids(EXCLUDED_TASKS)).toEqual([...EXCLUDED_TASK_IDS]);
    expect(ids(KG_FUTURE_20_TASKS_REGISTERED)).toEqual([...KG_FUTURE_20_TASK_IDS]);
    expect(ids(KG_DECISIVE_TASKS)).toEqual([...KG_DECISIVE_TASK_IDS]);
    expect(ids(KG_NEGATIVE_CONTROL_TASKS)).toEqual([...KG_NEGATIVE_CONTROL_TASK_IDS]);
    expect(ids(KG_LIC_FAVORABLE_TASKS)).toEqual([...KG_LIC_FAVORABLE_TASK_IDS]);
    expect(ids(KG_CONTROL_SOLVABLE_TASKS)).toEqual([...KG_CONTROL_SOLVABLE_TASK_IDS]);

    for (const id of [
      ...PRIMARY_15_TASK_IDS,
      ...KG_FUTURE_20_TASK_IDS,
      ...DIAGNOSTIC_TASK_IDS,
      ...EXCLUDED_TASK_IDS,
      ...KG_DECISIVE_TASK_IDS,
      ...KG_NEGATIVE_CONTROL_TASK_IDS,
      ...KG_LIC_FAVORABLE_TASK_IDS,
      ...KG_CONTROL_SOLVABLE_TASK_IDS,
    ]) {
      expect(registeredIds.has(id)).toBe(true);
    }

    expectNoOverlap(PRIMARY_15_TASK_IDS, DIAGNOSTIC_TASK_IDS);
    expectNoOverlap(PRIMARY_15_TASK_IDS, EXCLUDED_TASK_IDS);
    expectNoOverlap(PRIMARY_15_TASK_IDS, KG_FUTURE_20_TASK_IDS);
    expectNoOverlap(KG_FUTURE_20_TASK_IDS, DIAGNOSTIC_TASK_IDS);
    expectNoOverlap(KG_FUTURE_20_TASK_IDS, EXCLUDED_TASK_IDS);
    expectNoOverlap(DIAGNOSTIC_TASK_IDS, EXCLUDED_TASK_IDS);
  });

  it("keeps explicit filters archive-wide", () => {
    expect(ids(pickTasks({ ids: ["real-emc-detail-page-path-put"] }))).toEqual([
      "real-emc-detail-page-path-put",
    ]);
    expect(pickTasks({ tags: ["real-emc"] }).length).toBeGreaterThan(PRIMARY_TASKS.length);
  });

  it("fails fast for unknown explicit task ids", () => {
    expect(() => pickTasks({ ids: ["real-emc-speaker-image-cache-invalidate~"] })).toThrow(
      /Unknown task id\(s\): real-emc-speaker-image-cache-invalidate~/,
    );
  });

  it("registers temporal diagnostics and KG-decisive review reasons", () => {
    expect(ids(DIAGNOSTIC_TASKS)).toContain("memory-current-vs-stale");
    expect(ids(DIAGNOSTIC_TASKS)).toContain("memory-why-changed");
    expect(KG_DECISIVE_TASK_IDS.length).toBeGreaterThan(0);
    expect(ids(taskSetTasks(parseTaskSetName("kg-decisive")))).toEqual([...KG_DECISIVE_TASK_IDS]);
    expect(ids(taskSetTasks(parseTaskSetName("kg-decisive-eligible")))).toEqual([...KG_DECISIVE_TASK_IDS]);
    expect(ids(taskSetTasks(parseTaskSetName("kg-future-20")))).toEqual([...KG_FUTURE_20_TASK_IDS]);
    expect(ids(taskSetTasks(parseTaskSetName("kg-future-20-eligible")))).toEqual([...KG_FUTURE_20_TASK_IDS]);
    expect(ids(taskSetTasks(parseTaskSetName("kg-negative-control")))).toEqual([...KG_NEGATIVE_CONTROL_TASK_IDS]);
    expect(ids(taskSetTasks(parseTaskSetName("kg-lic-favorable")))).toEqual([...KG_LIC_FAVORABLE_TASK_IDS]);
    expect(ids(taskSetTasks(parseTaskSetName("kg-control-solvable")))).toEqual([...KG_CONTROL_SOLVABLE_TASK_IDS]);
    for (const id of KG_DECISIVE_TASK_IDS) {
      expect(KG_DECISIVE_TASK_REASONS[id].length).toBeGreaterThan(20);
    }
    expect(KG_FUTURE_20_TASK_IDS).toHaveLength(20);
    for (const id of KG_FUTURE_20_TASK_IDS) {
      expect(KG_FUTURE_20_TASK_REASONS[id].length).toBeGreaterThan(20);
    }
  });
});
