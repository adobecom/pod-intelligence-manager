import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStandardsForWizard } from "../shared-standards.js";

describe("fetchStandardsForWizard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not register marketplace plugins whose item listing fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.includes("adobecom/milo")) {
        return Response.json([]);
      }
      if (href.includes(".claude-plugin/marketplace.json")) {
        return Response.json({
          plugins: [
            { name: "good-plugin", source: "./plugins/good-plugin", description: "Good" },
            { name: "bad-plugin", source: "./plugins/bad-plugin", description: "Bad" },
          ],
        });
      }
      if (href.includes("plugins/good-plugin/skills")) {
        return Response.json([{ name: "use-good-plugin", type: "dir" }]);
      }
      if (href.includes("plugins/bad-plugin/skills")) {
        return new Response("not found", { status: 404 });
      }
      return new Response("unexpected", { status: 500 });
    }));

    const { wizardData, virtualSources } = await fetchStandardsForWizard();

    expect(virtualSources.map((source) => source.id)).toEqual(["adobe-skills:good-plugin"]);
    expect(wizardData.map((data) => data.source.id)).toContain("adobe-skills:good-plugin");
    expect(wizardData.map((data) => data.source.id)).not.toContain("adobe-skills:bad-plugin");
  });
});
