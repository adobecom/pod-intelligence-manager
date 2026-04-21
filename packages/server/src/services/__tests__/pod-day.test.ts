import { describe, it, expect } from "vitest";
import { computeCurrentDay } from "../pod-day.js";

describe("computeCurrentDay", () => {
  it("returns day 1 on the sprint start date", () => {
    const now = new Date("2026-04-10T12:00:00.000Z");
    expect(computeCurrentDay("2026-04-10T00:00:00.000Z", 5, now)).toBe(1);
  });

  it("advances one day per elapsed 24h window", () => {
    const now = new Date("2026-04-13T00:00:00.000Z");
    expect(computeCurrentDay("2026-04-10T00:00:00.000Z", 5, now)).toBe(4);
  });

  it("clamps to totalDays when sprint is over", () => {
    const now = new Date("2026-05-01T00:00:00.000Z");
    expect(computeCurrentDay("2026-04-10T00:00:00.000Z", 5, now)).toBe(5);
  });

  it("clamps to 1 when now predates sprint start", () => {
    const now = new Date("2026-04-01T00:00:00.000Z");
    expect(computeCurrentDay("2026-04-10T00:00:00.000Z", 5, now)).toBe(1);
  });

  it("returns 1 on malformed input", () => {
    expect(computeCurrentDay("", 5)).toBe(1);
    expect(computeCurrentDay("not-a-date", 5)).toBe(1);
    expect(computeCurrentDay("2026-04-10T00:00:00.000Z", 0)).toBe(1);
  });
});
