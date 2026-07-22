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

import { scheduleProjectSearchRefresh } from "../project-search-refresh.js";

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
    mocks.backfillProjectSearch.mockReturnValue({ documents: 0, chunks: 0 });
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
});
