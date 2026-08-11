import { afterEach, describe, expect, it } from "vitest";
import db from "../../db/connection.js";
import { createTables } from "../../db/schema.js";
import { backfillLegacyMemoryTokenBindings } from "../service-tokens.js";
import {
  getMemoryV2Availability,
  initializeMemoryV2Availability,
  markMemoryV2Ready,
  type MemoryV2StartupOperations,
  type MemoryV2UnavailableReason,
} from "../memory-v2-availability.js";

afterEach(() => {
  markMemoryV2Ready();
});

function operationsFailingAt(
  failedStep: keyof MemoryV2StartupOperations,
  calls: string[],
): MemoryV2StartupOperations {
  const operation = (step: keyof MemoryV2StartupOperations) => () => {
    calls.push(step);
    if (step === failedStep) throw new Error(`${step} broke`);
  };
  return {
    migrate: operation("migrate"),
    reconcile: operation("reconcile"),
    admit: operation("admit"),
    validate: operation("validate"),
  };
}

describe("memory v2 process availability", () => {
  it("contains a broken v2 migration before the 012-coupled token backfill", () => {
    createTables({ memoryMigrationThroughVersion: 11 });
    const applied = db.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number };
    expect(applied.version).toBe(11);
    expect(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_v2_resources'",
    ).get()).toBeUndefined();

    let backfillAttempted = false;
    const result = initializeMemoryV2Availability({
      migrate: () => {
        throw new Error("deliberately broken v2 migration");
      },
      reconcile: () => {
        backfillAttempted = true;
        backfillLegacyMemoryTokenBindings();
      },
      admit: () => undefined,
      validate: () => undefined,
    });

    expect(backfillAttempted).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.availability).toMatchObject({
      status: "unavailable",
      reason: "migration_failed",
    });
    expect(() => db.prepare("SELECT COUNT(*) FROM pods").get()).not.toThrow();
  });

  it.each<[
    keyof MemoryV2StartupOperations,
    MemoryV2UnavailableReason,
    string[],
  ]>([
    ["reconcile", "reconciliation_failed", ["migrate", "reconcile"]],
    ["admit", "admission_failed", ["migrate", "reconcile", "admit"]],
    ["validate", "startup_validation_failed", ["migrate", "reconcile", "admit", "validate"]],
  ])("contains a broken %s phase without throwing", (failedStep, reason, expectedCalls) => {
    const calls: string[] = [];
    const result = initializeMemoryV2Availability(
      operationsFailingAt(failedStep, calls),
    );

    expect(calls).toEqual(expectedCalls);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.availability).toMatchObject({ status: "unavailable", reason });
    expect(result.availability.changed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(reason.length).toBeLessThanOrEqual(32);
    expect(getMemoryV2Availability()).toEqual(result.availability);
  });

  it("marks v2 ready only after every startup phase succeeds", () => {
    const calls: string[] = [];
    const result = initializeMemoryV2Availability({
      migrate: () => calls.push("migrate"),
      reconcile: () => calls.push("reconcile"),
      admit: () => calls.push("admit"),
      validate: () => calls.push("validate"),
    });

    expect(calls).toEqual(["migrate", "reconcile", "admit", "validate"]);
    expect(result).toMatchObject({
      availability: { status: "ready", reason: null },
      error: null,
    });
  });
});
