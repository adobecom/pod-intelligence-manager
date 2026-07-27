import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGitHubSkillCatalogClient,
  SkillCatalogGitError,
} from "../skill-catalog-github.js";

const SOURCE = {
  apiBaseUrl: "https://github.enterprise.example/api/v3",
  owner: "example-owner",
  repo: "skills",
  credentialAlias: "SKILL_GITHUB_TEST_TOKEN",
};

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("skill catalog GitHub client", () => {
  it("resolves commits, fetches one recursive tree, and decodes blobs", async () => {
    vi.stubEnv(SOURCE.credentialAlias, "secret-token");
    const requests: Array<{ url: string; authorization: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        if (url.includes("/commits/")) {
          return json({
            sha: "a".repeat(40),
            commit: { tree: { sha: "1".repeat(40) } },
          });
        }
        if (url.includes("/git/trees/")) {
          return json({
            truncated: false,
            tree: [
              {
                path: "shared/skills/a.md",
                type: "blob",
                sha: "b".repeat(40),
              },
            ],
          });
        }
        if (url.includes("/git/blobs/")) {
          return json({
            encoding: "base64",
            content: Buffer.from("# A").toString("base64"),
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      }),
    );
    const client = createGitHubSkillCatalogClient(SOURCE);

    await expect(client.resolveCommit("main")).resolves.toEqual({
      commitSha: "a".repeat(40),
      treeSha: "1".repeat(40),
    });
    await expect(client.getRecursiveTree("1".repeat(40))).resolves.toHaveLength(1);
    await expect(client.getBlob("b".repeat(40))).resolves.toBe("# A");
    expect(requests.every((request) => request.authorization === "Bearer secret-token")).toBe(
      true,
    );
    expect(requests.filter((request) => request.url.includes("?recursive=1"))).toHaveLength(
      1,
    );
  });

  it("rejects truncated recursive trees", async () => {
    vi.stubEnv(SOURCE.credentialAlias, "secret-token");
    vi.stubGlobal("fetch", vi.fn(async () => json({ truncated: true, tree: [] })));
    const client = createGitHubSkillCatalogClient(SOURCE);

    await expect(client.getRecursiveTree("1".repeat(40))).rejects.toThrow(
      "truncated",
    );
  });

  it("fails before a request when the credential alias is not configured", () => {
    vi.stubEnv(SOURCE.credentialAlias, "");
    expect(() => createGitHubSkillCatalogClient(SOURCE)).toThrow(
      SkillCatalogGitError,
    );
  });
});
