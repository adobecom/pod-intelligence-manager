import { describe, expect, it } from "vitest";
import {
  ALL_TASKS,
  DEFAULT_TASKS,
  DIAGNOSTIC_TASKS,
  EXCLUDED_TASKS,
  PRIMARY_TASKS,
  pickTasks,
} from "../tasks/index.js";
import {
  DIAGNOSTIC_TASK_IDS,
  EXCLUDED_TASK_IDS,
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

    for (const id of [...PRIMARY_15_TASK_IDS, ...DIAGNOSTIC_TASK_IDS, ...EXCLUDED_TASK_IDS]) {
      expect(registeredIds.has(id)).toBe(true);
    }

    expectNoOverlap(PRIMARY_15_TASK_IDS, DIAGNOSTIC_TASK_IDS);
    expectNoOverlap(PRIMARY_15_TASK_IDS, EXCLUDED_TASK_IDS);
    expectNoOverlap(DIAGNOSTIC_TASK_IDS, EXCLUDED_TASK_IDS);
  });

  it("keeps explicit filters archive-wide", () => {
    expect(ids(pickTasks({ ids: ["real-emc-detail-page-path-put"] }))).toEqual([
      "real-emc-detail-page-path-put",
    ]);
    expect(pickTasks({ tags: ["real-emc"] }).length).toBeGreaterThan(PRIMARY_TASKS.length);
  });
});
