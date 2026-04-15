import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("../../db/connection.js", () => ({
  default: {
    prepare: vi.fn(),
  },
}));

import { recalculatePressure } from "../pressure.js";
import db from "../../db/connection.js";

const NOW = Date.now();
const HOUR_MS = 1000 * 60 * 60;

function hoursAgo(h: number): string {
  return new Date(NOW - h * HOUR_MS).toISOString();
}

describe("recalculatePressure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: NOW });
  });

  it("returns 0 when no open conflicts exist", () => {
    const runMock = vi.fn();
    (db.prepare as Mock).mockImplementation((sql: string) => {
      if (sql.includes("SELECT")) {
        return { all: vi.fn().mockReturnValue([]) };
      }
      return { run: runMock };
    });

    expect(recalculatePressure("pod-1")).toBe(0);
  });

  it("returns ~0.15 for a single new blocking conflict", () => {
    const runMock = vi.fn();
    (db.prepare as Mock).mockImplementation((sql: string) => {
      if (sql.includes("SELECT")) {
        return {
          all: vi.fn().mockReturnValue([
            { id: "c1", severity: "blocking", created_at: new Date(NOW).toISOString() },
          ]),
        };
      }
      return { run: runMock };
    });

    const pressure = recalculatePressure("pod-1");
    expect(pressure).toBeGreaterThanOrEqual(0.15);
    expect(pressure).toBeLessThan(0.16);
  });

  it("returns ~0.08 for a single new non-blocking conflict", () => {
    const runMock = vi.fn();
    (db.prepare as Mock).mockImplementation((sql: string) => {
      if (sql.includes("SELECT")) {
        return {
          all: vi.fn().mockReturnValue([
            { id: "c1", severity: "non_blocking", created_at: new Date(NOW).toISOString() },
          ]),
        };
      }
      return { run: runMock };
    });

    const pressure = recalculatePressure("pod-1");
    expect(pressure).toBeGreaterThanOrEqual(0.08);
    expect(pressure).toBeLessThan(0.09);
  });

  it("accumulates pressure across multiple conflicts", () => {
    const runMock = vi.fn();
    (db.prepare as Mock).mockImplementation((sql: string) => {
      if (sql.includes("SELECT")) {
        return {
          all: vi.fn().mockReturnValue([
            { id: "c1", severity: "blocking", created_at: new Date(NOW).toISOString() },
            { id: "c2", severity: "non_blocking", created_at: new Date(NOW).toISOString() },
          ]),
        };
      }
      return { run: runMock };
    });

    const pressure = recalculatePressure("pod-1");
    expect(pressure).toBeCloseTo(0.23, 1); // 0.15 + 0.08
  });

  it("adds age bonus for old conflicts (capped at 0.1)", () => {
    const runMock = vi.fn();
    (db.prepare as Mock).mockImplementation((sql: string) => {
      if (sql.includes("SELECT")) {
        return {
          all: vi.fn().mockReturnValue([
            { id: "c1", severity: "blocking", created_at: hoursAgo(48) },
          ]),
        };
      }
      return { run: runMock };
    });

    const pressure = recalculatePressure("pod-1");
    // 0.15 base + 0.1 max age bonus = 0.25
    expect(pressure).toBeCloseTo(0.25, 1);
  });

  it("clamps pressure to 1.0 maximum", () => {
    const runMock = vi.fn();
    const manyConflicts = Array.from({ length: 20 }, (_, i) => ({
      id: `c${i}`,
      severity: "blocking",
      created_at: hoursAgo(96),
    }));

    (db.prepare as Mock).mockImplementation((sql: string) => {
      if (sql.includes("SELECT")) {
        return { all: vi.fn().mockReturnValue(manyConflicts) };
      }
      return { run: runMock };
    });

    const pressure = recalculatePressure("pod-1");
    expect(pressure).toBe(1);
  });

  it("updates both pods and org_pod_summaries tables", () => {
    const runMock = vi.fn();
    (db.prepare as Mock).mockImplementation((sql: string) => {
      if (sql.includes("SELECT")) {
        return {
          all: vi.fn().mockReturnValue([
            { id: "c1", severity: "blocking", created_at: new Date(NOW).toISOString() },
          ]),
        };
      }
      return { run: runMock };
    });

    recalculatePressure("pod-1");

    // Should call run() twice: once for pods, once for org_pod_summaries
    expect(runMock).toHaveBeenCalledTimes(2);
  });
});
