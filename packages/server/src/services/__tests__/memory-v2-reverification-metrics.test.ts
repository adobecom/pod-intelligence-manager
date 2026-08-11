import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTables } from "../../db/schema.js";
import {
  emitMemoryV2ReverificationDeadLetterAgeMetrics,
  recordMemoryMetric,
  setMemoryMetricSink,
  type MemoryMetric,
} from "../memory-metrics.js";

describe("memory v2 reverification metric vocabulary", () => {
  beforeAll(() => createTables());
  afterEach(() => setMemoryMetricSink(null));

  it("accepts the bounded Slice 6 measures without resource identifiers as dimensions", () => {
    const captured: MemoryMetric[] = [];
    setMemoryMetricSink((metric) => captured.push(metric));

    for (const [name, unit] of [
      ["ReverificationDue", "Count"],
      ["ReverificationAttempt", "Count"],
      ["ReverificationSuccess", "Count"],
      ["ReverificationFailure", "Count"],
      ["ReverificationDeadLetter", "Count"],
      ["ReverificationDeadLetterAgeSeconds", "Seconds"],
      ["SourceWithdrawalLagSeconds", "Seconds"],
    ] as const) {
      recordMemoryMetric({
        name,
        value: 1,
        unit,
        dimensions: {
          plane: "harness",
          outcome: "bounded_fixture",
        },
        fields: {
          resource_row_id: "resource-private-field",
          record_id: "record-private-field",
        },
      });
    }

    expect(captured.map((metric) => metric.name)).toEqual([
      "ReverificationDue",
      "ReverificationAttempt",
      "ReverificationSuccess",
      "ReverificationFailure",
      "ReverificationDeadLetter",
      "ReverificationDeadLetterAgeSeconds",
      "SourceWithdrawalLagSeconds",
    ]);
    expect(captured).toEqual(captured.map((metric) => expect.objectContaining({
      dimensions: {
        plane: "harness",
        outcome: "bounded_fixture",
      },
      fields: {
        resource_row_id: "resource-private-field",
        record_id: "record-private-field",
      },
    })));
  });

  it("publishes recurring zero-age samples for both bounded planes when none are unresolved", () => {
    const captured: MemoryMetric[] = [];
    setMemoryMetricSink((metric) => captured.push(metric));
    const snapshot = emitMemoryV2ReverificationDeadLetterAgeMetrics(
      "2026-08-10T20:00:00.000Z",
    );

    expect(snapshot.byPlane).toEqual({
      codebase: { unresolvedCount: 0, oldestDeadLetterAt: null, oldestAgeSeconds: 0 },
      harness: { unresolvedCount: 0, oldestDeadLetterAt: null, oldestAgeSeconds: 0 },
    });
    expect(captured).toEqual([
      expect.objectContaining({
        name: "ReverificationDeadLetterAgeSeconds",
        value: 0,
        unit: "Seconds",
        dimensions: { plane: "codebase", outcome: "unresolved" },
      }),
      expect.objectContaining({
        name: "ReverificationDeadLetterAgeSeconds",
        value: 0,
        unit: "Seconds",
        dimensions: { plane: "harness", outcome: "unresolved" },
      }),
    ]);
  });
});
