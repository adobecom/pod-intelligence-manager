import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const catalogMocks = vi.hoisted(() => ({
  listEnabledSkillCatalogSourceRefs: vi.fn(),
  syncSkillCatalogSource: vi.fn(),
}));

vi.mock("../skill-catalog.js", () => catalogMocks);

import {
  resetSkillCatalogFreshnessForTests,
  runSkillCatalogRefPollTick,
  scheduleSkillCatalogSourceSync,
} from "../skill-catalog-freshness.js";
import { setSkillCatalogMetricSink } from "../skill-catalog-metrics.js";

const READY_RESULT = {
  state: "entries_ready" as const,
  snapshot: {
    snapshotId: "snapshot-a",
    orgId: "org-a",
    sourceId: "source-a",
    commitSha: "a".repeat(40),
    state: "entries_ready" as const,
    isDefaultRef: true,
    createdAt: "2026-07-25T00:00:00.000Z",
  },
};

const log = {
  info: vi.fn(),
  warn: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  resetSkillCatalogFreshnessForTests();
  setSkillCatalogMetricSink(null);
  catalogMocks.listEnabledSkillCatalogSourceRefs.mockReturnValue([]);
  catalogMocks.syncSkillCatalogSource.mockResolvedValue(READY_RESULT);
});

afterEach(() => {
  resetSkillCatalogFreshnessForTests();
  setSkillCatalogMetricSink(null);
});

describe("skill catalog freshness queue", () => {
  it("runs one follow-up sync when a webhook arrives during an active sync", async () => {
    let releaseFirst!: (value: typeof READY_RESULT) => void;
    const firstRun = new Promise<typeof READY_RESULT>((resolve) => {
      releaseFirst = resolve;
    });
    catalogMocks.syncSkillCatalogSource
      .mockImplementationOnce(async () => firstRun)
      .mockResolvedValueOnce(READY_RESULT);
    const metrics = vi.fn();
    setSkillCatalogMetricSink(metrics);

    const first = scheduleSkillCatalogSourceSync({
      orgId: "org-a",
      sourceId: "source-a",
      trigger: "webhook",
      webhookReceivedAtMs: Date.now() - 20,
      log,
    });
    await vi.waitFor(() => {
      expect(catalogMocks.syncSkillCatalogSource).toHaveBeenCalledTimes(1);
    });
    const joined = scheduleSkillCatalogSourceSync({
      orgId: "org-a",
      sourceId: "source-a",
      trigger: "webhook",
      webhookReceivedAtMs: Date.now() - 10,
      log,
    });
    expect(joined).toBe(first);

    releaseFirst(READY_RESULT);
    await expect(first).resolves.toMatchObject({
      failures: 0,
      runs: 2,
    });
    expect(catalogMocks.syncSkillCatalogSource).toHaveBeenCalledTimes(2);
    expect(
      metrics.mock.calls.filter(
        ([metric]) => metric.name === "WebhookToEntriesReadyLag",
      ),
    ).toHaveLength(2);
  });

  it("continues polling other enabled sources after one source fails", async () => {
    catalogMocks.listEnabledSkillCatalogSourceRefs.mockReturnValue([
      { orgId: "org-a", sourceId: "source-a" },
      { orgId: "org-b", sourceId: "source-b" },
    ]);
    catalogMocks.syncSkillCatalogSource
      .mockRejectedValueOnce(new Error("Git unavailable"))
      .mockResolvedValueOnce({
        ...READY_RESULT,
        snapshot: {
          ...READY_RESULT.snapshot,
          orgId: "org-b",
          sourceId: "source-b",
        },
      });

    await expect(runSkillCatalogRefPollTick(log)).resolves.toEqual({
      failures: 1,
      sourceCount: 2,
    });
    expect(catalogMocks.syncSkillCatalogSource.mock.calls).toEqual([
      ["org-a", "source-a"],
      ["org-b", "source-b"],
    ]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: "org-a",
        source_id: "source-a",
      }),
      "Skill catalog source sync failed",
    );
  });

  it("single-flights overlapping global poll ticks without dirtying sources", async () => {
    catalogMocks.listEnabledSkillCatalogSourceRefs.mockReturnValue([
      { orgId: "org-a", sourceId: "source-a" },
    ]);
    let release!: (value: typeof READY_RESULT) => void;
    catalogMocks.syncSkillCatalogSource.mockImplementationOnce(
      () =>
        new Promise<typeof READY_RESULT>((resolve) => {
          release = resolve;
        }),
    );

    const first = runSkillCatalogRefPollTick(log);
    await vi.waitFor(() => {
      expect(catalogMocks.syncSkillCatalogSource).toHaveBeenCalledTimes(1);
    });
    const joined = runSkillCatalogRefPollTick(log);
    expect(joined).toBe(first);
    expect(catalogMocks.listEnabledSkillCatalogSourceRefs).toHaveBeenCalledTimes(
      1,
    );

    release(READY_RESULT);
    await expect(first).resolves.toEqual({
      failures: 0,
      sourceCount: 1,
    });
    expect(catalogMocks.syncSkillCatalogSource).toHaveBeenCalledTimes(1);
  });
});
