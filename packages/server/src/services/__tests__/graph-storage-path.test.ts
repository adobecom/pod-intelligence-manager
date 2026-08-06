import path from "node:path";
import { describe, expect, it } from "vitest";
import { graphDataRoot } from "../graph-storage.js";

describe("canonical graph storage path", () => {
  it("uses the repository data directory rather than process.cwd()", () => {
    expect(graphDataRoot).toBe(path.resolve(import.meta.dirname, "../../../../../.data/knowledge-graph"));
  });
});

