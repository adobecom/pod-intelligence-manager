import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pollProjectSources: vi.fn(),
  backfillProjectSearch: vi.fn(),
  indexProjectKgNodes: vi.fn(),
  embedProjectSearchChunks: vi.fn(),
  annotateProjectGraph: vi.fn(),
  recordWatermark: vi.fn(),
}));

vi.mock("../../db/connection.js", () => ({
  default: {
    prepare: vi.fn(() => ({ run: mocks.recordWatermark })),
  },
}));

vi.mock("../project-memory.js", () => ({
  pollProjectSources: mocks.pollProjectSources,
}));

vi.mock("../project-search-index.js", () => ({
  backfillProjectSearch: mocks.backfillProjectSearch,
  indexProjectKgNodes: mocks.indexProjectKgNodes,
  embedProjectSearchChunks: mocks.embedProjectSearchChunks,
  annotateProjectGraph: mocks.annotateProjectGraph,
}));

import { refreshProjectSearch, scheduleProjectSearchRefresh } from "../project-search-refresh.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("scheduleProjectSearchRefresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pollProjectSources.mockResolvedValue({ results: [], health: [] });
    mocks.backfillProjectSearch.mockReturnValue({
      documents: 0,
      chunks: 0,
      skipped_ineligible: 0,
      failed_rows: 0,
      complete: true,
      failures: [],
    });
    mocks.embedProjectSearchChunks.mockResolvedValue(0);
  });

  it("coalesces overlapping refreshes into one trailing run and permits a later refresh", async () => {
    const firstPoll = deferred<{ results: []; health: [] }>();
    mocks.pollProjectSources.mockReturnValueOnce(firstPoll.promise);

    scheduleProjectSearchRefresh("org-1", "project-1");
    scheduleProjectSearchRefresh("org-1", "project-1");

    await vi.waitFor(() => expect(mocks.pollProjectSources).toHaveBeenCalledTimes(1));
    expect(mocks.backfillProjectSearch).not.toHaveBeenCalled();

    firstPoll.resolve({ results: [], health: [] });
    await vi.waitFor(() => {
      expect(mocks.pollProjectSources).toHaveBeenCalledTimes(2);
      expect(mocks.annotateProjectGraph).toHaveBeenCalledTimes(2);
      expect(mocks.recordWatermark).toHaveBeenCalledTimes(2);
    });

    // Once both coalesced runs settle, a later resource mutation starts a new
    // refresh rather than leaving the project permanently marked in flight.
    scheduleProjectSearchRefresh("org-1", "project-1");

    await vi.waitFor(() => {
      expect(mocks.pollProjectSources).toHaveBeenCalledTimes(3);
      expect(mocks.annotateProjectGraph).toHaveBeenCalledTimes(3);
      expect(mocks.recordWatermark).toHaveBeenCalledTimes(3);
    });
  });

  it("reports a partial backfill, withholds the watermark, and still attempts later stages", async () => {
    mocks.backfillProjectSearch.mockReturnValueOnce({
      documents: 2,
      chunks: 4,
      skipped_ineligible: 1,
      failed_rows: 1,
      complete: false,
      failures: [{ row_id: "evidence-1", source: "jira", code: "metadata_json" }],
    });

    const result = await refreshProjectSearch("org-1", "project-1");

    expect(result).toMatchObject({
      ok: false,
      error: "project_backfill_partial",
      index_documents: 2,
      backfill_skipped_ineligible: 1,
      backfill_failed_rows: 1,
    });
    expect(mocks.indexProjectKgNodes).toHaveBeenCalledWith("org-1", "project-1");
    expect(mocks.embedProjectSearchChunks).toHaveBeenCalledWith("org-1", "project-1");
    expect(mocks.annotateProjectGraph).toHaveBeenCalledWith("org-1", "project-1");
    expect(mocks.recordWatermark).not.toHaveBeenCalled();
  });

  it("continues local indexing stages after a connector reports a partial refresh", async () => {
    mocks.pollProjectSources.mockResolvedValueOnce({
      results: [{ source: "confluence", ingested: 0, missing: "fetch_failed" }],
      health: [],
    });

    const result = await refreshProjectSearch("org-1", "project-1");

    expect(result).toMatchObject({
      ok: false,
      error: "project_source_refresh_partial",
      source_errors: [{ source: "confluence", error: "source_refresh_failed" }],
    });
    expect(mocks.backfillProjectSearch).toHaveBeenCalled();
    expect(mocks.indexProjectKgNodes).toHaveBeenCalled();
    expect(mocks.embedProjectSearchChunks).toHaveBeenCalled();
    expect(mocks.annotateProjectGraph).toHaveBeenCalled();
    expect(mocks.recordWatermark).not.toHaveBeenCalled();
  });
});
