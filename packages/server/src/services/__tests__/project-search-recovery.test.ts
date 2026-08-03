import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  purge: vi.fn(),
  backfill: vi.fn(),
  indexKg: vi.fn(),
  annotate: vi.fn(),
}));

vi.mock("../../db/connection.js", () => ({
  default: { prepare: mocks.prepare },
  dbPath: "/tmp/pim-project-search-recovery-test.db",
}));

vi.mock("../project-search-index.js", () => ({
  purgeProjectSearch: mocks.purge,
  backfillProjectSearch: mocks.backfill,
  indexProjectKgNodes: mocks.indexKg,
  annotateProjectGraph: mocks.annotate,
}));

import { rebuildProjectSearchAfterCoreRestore } from "../project-search-recovery.js";

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

let tempDir = "";
let markerPath = "";

describe("rebuildProjectSearchAfterCoreRestore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pim-search-recovery-"));
    markerPath = path.join(tempDir, "pim.db.project-search-rebuild-required");
    mocks.backfill.mockReturnValue({ documents: 2, chunks: 3 });
    mocks.indexKg.mockReturnValue({ indexed: 1, deleted: 0, skipped: 0 });
    mocks.annotate.mockReturnValue({ annotated: 4, skipped: false });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("does nothing when no core-restore marker exists", async () => {
    const result = await rebuildProjectSearchAfterCoreRestore(log, markerPath);

    expect(result.requested).toBe(false);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.purge).not.toHaveBeenCalled();
  });

  it("rebuilds every project locally and removes the marker only after success", async () => {
    fs.writeFileSync(markerPath, "");
    mocks.prepare.mockReturnValue({
      all: () => [
        { org_id: "org-1", project_id: "project-a" },
        { org_id: "org-2", project_id: "project-b" },
      ],
    });

    const result = await rebuildProjectSearchAfterCoreRestore(log, markerPath);

    expect(mocks.purge.mock.calls).toEqual([
      ["org-1", "project-a"],
      ["org-2", "project-b"],
    ]);
    expect(mocks.backfill).toHaveBeenCalledTimes(2);
    expect(mocks.indexKg).toHaveBeenCalledTimes(2);
    expect(mocks.annotate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      requested: true,
      projects_total: 2,
      projects_rebuilt: 2,
      failed_projects: [],
      marker_removed: true,
    });
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("keeps the marker when one project fails so the next boot retries", async () => {
    fs.writeFileSync(markerPath, "");
    mocks.prepare.mockReturnValue({
      all: () => [
        { org_id: "org-1", project_id: "project-a" },
        { org_id: "org-2", project_id: "project-b" },
      ],
    });
    mocks.backfill.mockImplementation((orgId: string) => {
      if (orgId === "org-1") throw new Error("bad evidence row");
      return { documents: 2, chunks: 3 };
    });

    const result = await rebuildProjectSearchAfterCoreRestore(log, markerPath);

    expect(result.projects_rebuilt).toBe(1);
    expect(result.failed_projects).toEqual([
      { org_id: "org-1", project_id: "project-a" },
    ]);
    expect(result.marker_removed).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(true);
    expect(mocks.purge).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalled();
  });
});
