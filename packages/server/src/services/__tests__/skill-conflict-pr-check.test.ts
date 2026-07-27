import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  decideSkillConflictCheck,
  runAdvisorySkillConflictCheck,
  runSkillConflictCheck,
  SKILL_CONFLICT_COMMENT_MARKER,
  type PullRequestCheckEvent,
} from "../skill-conflict-pr-check.js";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const EVENT: PullRequestCheckEvent = {
  pull_request: {
    number: 42,
    base: { sha: BASE_SHA },
    head: { sha: HEAD_SHA },
  },
  repository: { full_name: "Adobe-acom/mimir" },
};

const CONFIG = {
  pimBaseUrl: "https://pim.example",
  pimServiceToken: "pim-token",
  pimOrg: "adobe",
  sourceId: "mimir-main",
  githubToken: "github-token",
  githubRepository: "Adobe-acom/mimir",
  githubApiUrl: "https://api.github.example",
  maxBuildAttempts: 3,
};

const SOURCE = {
  layoutRules: [
    { glob: "projects/*/skills/**/*.md", namespace: "project:{1}" },
    { glob: "shared/skills/**/*.md", namespace: "shared" },
  ],
  excludeGlobs: [],
};

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function decodedContentPath(url: string): string {
  const encoded = url.split("/contents/")[1]?.split("?")[0] ?? "";
  return encoded.split("/").map(decodeURIComponent).join("/");
}

describe("skill-conflict check decision", () => {
  it.each([
    {
      mode: "advisory" as const,
      conflictCount: 0,
      unavailable: false,
      outcome: "clear",
      blocked: false,
      exitCode: 0,
    },
    {
      mode: "advisory" as const,
      conflictCount: 2,
      unavailable: false,
      outcome: "conflict_found",
      blocked: false,
      exitCode: 0,
    },
    {
      mode: "advisory" as const,
      conflictCount: 0,
      unavailable: true,
      outcome: "unavailable",
      blocked: false,
      exitCode: 0,
    },
    {
      mode: "required" as const,
      conflictCount: 0,
      unavailable: false,
      outcome: "clear",
      blocked: false,
      exitCode: 0,
    },
    {
      mode: "required" as const,
      conflictCount: 2,
      unavailable: false,
      outcome: "conflict_found",
      blocked: true,
      exitCode: 1,
    },
    {
      mode: "required" as const,
      conflictCount: 0,
      unavailable: true,
      outcome: "unavailable",
      blocked: true,
      exitCode: 1,
    },
  ])(
    "maps $mode/$outcome to exit code $exitCode",
    ({ mode, conflictCount, unavailable, outcome, blocked, exitCode }) => {
      expect(
        decideSkillConflictCheck({ mode, conflictCount, unavailable }),
      ).toEqual({ mode, outcome, blocked, exitCode });
    },
  );
});

describe("skill-conflict PR check", () => {
  it("regression: covers modified and renamed files instead of checking additions only", async () => {
    const validationPayloads: Array<{
      baseCommitSha: string;
      candidates: Array<{
        candidateId: string;
        proposedPath: string;
        replacesPath?: string;
        body: string;
      }>;
    }> = [];
    const contentRefs: string[] = [];
    const comments: string[] = [];
    let validationAttempt = 0;
    const bodies: Record<string, string> = {
      "projects/new/skills/added.md": "# Added\n\nAdded behavior.",
      "projects/alpha/skills/modified.md": "# Modified\n\nFinal modified bytes.",
      "projects/alpha/skills/new-name.md": "# Renamed\n\nFinal renamed bytes.",
    };
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/skill-catalog/sources/mimir-main")) {
        return json(SOURCE);
      }
      if (url.includes("/pulls/42/files")) {
        return json([
          { filename: "projects/new/skills/added.md", status: "added" },
          { filename: "projects/alpha/skills/modified.md", status: "modified" },
          {
            filename: "projects/alpha/skills/new-name.md",
            previous_filename: "projects/alpha/skills/old-name.md",
            status: "renamed",
          },
          { filename: "projects/alpha/skills/removed.md", status: "removed" },
          { filename: "README.md", status: "modified" },
        ]);
      }
      if (url.includes("/contents/")) {
        const path = decodedContentPath(url);
        contentRefs.push(new URL(url).searchParams.get("ref") ?? "");
        return json({
          type: "file",
          encoding: "base64",
          content: Buffer.from(bodies[path]).toString("base64"),
        });
      }
      if (url.endsWith("/api/skill-conflicts")) {
        validationAttempt += 1;
        validationPayloads.push(JSON.parse(String(init?.body)));
        if (validationAttempt === 1) {
          return json(
            { error: "catalog_building" },
            { status: 202, headers: { "retry-after": "1" } },
          );
        }
        const payload = validationPayloads.at(-1)!;
        return json({
          catalog: { commitSha: BASE_SHA, snapshotState: "entries_ready" },
          matcherVersion: "v1",
          results: payload.candidates.map((candidate, index) => ({
            candidateId: candidate.candidateId,
            status: index === 0 ? "conflict_found" : "clear",
            conflicts:
              index === 0
                ? [
                    {
                      kind: "exact_content",
                      existing: {
                        path: "shared/skills/existing.md",
                      },
                    },
                  ]
                : [],
            related:
              index === 0
                ? [
                    {
                      name: "Existing review",
                      namespace: "shared",
                      path: "shared/skills/related-review.md",
                      blobSha: "c".repeat(40),
                      similarity: 0.41,
                      excerpt: "A redacted review helper.",
                    },
                    {
                      name: "Low signal",
                      namespace: "shared",
                      path: "shared/skills/low-signal.md",
                      blobSha: "d".repeat(40),
                      similarity: 0.34,
                      excerpt: "This suggestion should stay hidden.",
                    },
                  ]
                : [],
          })),
        });
      }
      if (url.includes("/issues/42/comments?")) return json([]);
      if (url.endsWith("/issues/42/comments") && init?.method === "POST") {
        comments.push((JSON.parse(String(init.body)) as { body: string }).body);
        return json({ id: 1 }, { status: 201 });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch;
    const sleep = vi.fn(async () => undefined);

    const result = await runAdvisorySkillConflictCheck(
      CONFIG,
      {
        ...EVENT,
        action: "closed",
        pull_request: {
          ...EVENT.pull_request,
          state: "closed",
          merged: true,
        },
      },
      {
        fetchImpl,
        sleep,
      },
    );

    expect(result).toMatchObject({
      candidateCount: 3,
      conflictCount: 1,
      relatedCount: 1,
      unavailable: false,
    });
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(contentRefs).toEqual([HEAD_SHA, HEAD_SHA, HEAD_SHA]);

    const finalPayload = validationPayloads.at(-1)!;
    expect(finalPayload.baseCommitSha).toBe(BASE_SHA);
    expect(finalPayload.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          proposedPath: "projects/new/skills/added.md",
          body: bodies["projects/new/skills/added.md"],
        }),
        expect.objectContaining({
          proposedPath: "projects/alpha/skills/modified.md",
          replacesPath: "projects/alpha/skills/modified.md",
          body: bodies["projects/alpha/skills/modified.md"],
        }),
        expect.objectContaining({
          proposedPath: "projects/alpha/skills/new-name.md",
          replacesPath: "projects/alpha/skills/old-name.md",
          body: bodies["projects/alpha/skills/new-name.md"],
        }),
      ]),
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(SKILL_CONFLICT_COMMENT_MARKER);
    expect(comments[0]).toContain("exact_content");
    expect(comments[0]).toContain("does not fail the pull request");
    expect(comments[0]).toContain("Related skills (advisory)");
    expect(comments[0]).toContain("shared/skills/related-review.md");
    expect(comments[0]).not.toContain("shared/skills/low-signal.md");
    expect(result.labelRecord).toMatchObject({
      schemaVersion: "pim.skill-conflict-label.v1",
      repository: "Adobe-acom/mimir",
      pullRequest: {
        number: 42,
        action: "closed",
        state: "closed",
        merged: true,
      },
      catalog: { commitSha: BASE_SHA, matcherVersion: "v1" },
      changes: {
        removedPaths: ["projects/alpha/skills/removed.md"],
        renames: [
          {
            from: "projects/alpha/skills/old-name.md",
            to: "projects/alpha/skills/new-name.md",
          },
        ],
      },
      candidates: expect.arrayContaining([
        expect.objectContaining({
          candidateId: "projects/new/skills/added.md",
          status: "conflict_found",
          shownRelated: [
            {
              path: "shared/skills/related-review.md",
              blobSha: "c".repeat(40),
              similarity: 0.41,
            },
          ],
        }),
      ]),
    });
    expect(result.labelRecord.candidates[0]?.contentHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(JSON.stringify(result.labelRecord)).not.toContain(
      "Final modified bytes",
    );
  });

  it("reports PIM failure as unavailable without turning it into a verdict", async () => {
    const comments: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/skill-catalog/sources/mimir-main")) {
        return json(SOURCE);
      }
      if (url.includes("/pulls/42/files")) {
        return json([
          { filename: "shared/skills/new.md", status: "added" },
        ]);
      }
      if (url.includes("/contents/")) {
        return json({
          type: "file",
          encoding: "base64",
          content: Buffer.from("# New\n\nUnique.").toString("base64"),
        });
      }
      if (url.endsWith("/api/skill-conflicts")) {
        return json(
          { error: "catalog_not_ready" },
          { status: 503 },
        );
      }
      if (url.includes("/issues/42/comments?")) return json([]);
      if (url.endsWith("/issues/42/comments") && init?.method === "POST") {
        comments.push((JSON.parse(String(init.body)) as { body: string }).body);
        return json({ id: 2 }, { status: 201 });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch;

    const result = await runAdvisorySkillConflictCheck(CONFIG, EVENT, {
      fetchImpl,
    });

    expect(result).toMatchObject({
      candidateCount: 1,
      conflictCount: 0,
      unavailable: true,
    });
    expect(comments[0]).toContain("Validation was unavailable");
    expect(comments[0]).not.toContain("No deterministic conflicts found");
  });

  it("updates a marker comment authored by a PAT user", async () => {
    const writes: Array<{ method: string; url: string; body: string }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/skill-catalog/sources/mimir-main")) {
          return json(SOURCE);
        }
        if (url.includes("/pulls/42/files")) {
          return json([
            { filename: "shared/skills/new.md", status: "added" },
          ]);
        }
        if (url.includes("/contents/")) {
          return json({
            type: "file",
            encoding: "base64",
            content: Buffer.from("# New\n\nUnique.").toString("base64"),
          });
        }
        if (url.endsWith("/api/skill-conflicts")) {
          const payload = JSON.parse(String(init?.body)) as {
            candidates: Array<{ candidateId: string }>;
          };
          return json({
            catalog: {
              commitSha: BASE_SHA,
              snapshotState: "entries_ready",
            },
            matcherVersion: "v1",
            results: payload.candidates.map((candidate) => ({
              candidateId: candidate.candidateId,
              status: "clear",
              conflicts: [],
              related: [],
            })),
          });
        }
        if (url.includes("/issues/42/comments?")) {
          return json([
            {
              id: 98,
              body: "An unrelated review comment",
              user: { type: "User" },
            },
            {
              id: 99,
              body: `${SKILL_CONFLICT_COMMENT_MARKER}\nold result`,
              user: { type: "User" },
            },
          ]);
        }
        if (url.endsWith("/issues/comments/99")) {
          writes.push({
            method: String(init?.method),
            url,
            body: (JSON.parse(String(init?.body)) as { body: string }).body,
          });
          return json({ id: 99 });
        }
        throw new Error(
          `Unexpected request: ${init?.method ?? "GET"} ${url}`,
        );
      },
    ) as typeof fetch;

    const result = await runAdvisorySkillConflictCheck(CONFIG, EVENT, {
      fetchImpl,
    });

    expect(result).toMatchObject({
      outcome: "clear",
      commentPosted: true,
      commentError: null,
    });
    expect(writes).toEqual([
      expect.objectContaining({
        method: "PATCH",
        url: "https://api.github.example/repos/Adobe-acom/mimir/issues/comments/99",
        body: expect.stringContaining(SKILL_CONFLICT_COMMENT_MARKER),
      }),
    ]);
  });

  it.each([
    {
      validation: "clear" as const,
      outcome: "clear",
      blocked: false,
      exitCode: 0,
      expectedComment: "No deterministic conflicts found",
    },
    {
      validation: "conflict" as const,
      outcome: "conflict_found",
      blocked: true,
      exitCode: 1,
      expectedComment: "exact_content",
    },
    {
      validation: "unavailable" as const,
      outcome: "unavailable",
      blocked: true,
      exitCode: 1,
      expectedComment: "cannot pass without a deterministic verdict",
    },
    {
      validation: "malformed" as const,
      outcome: "unavailable",
      blocked: true,
      exitCode: 1,
      expectedComment: "cannot pass without a deterministic verdict",
    },
    {
      validation: "clear_comment_failure" as const,
      outcome: "clear",
      blocked: false,
      exitCode: 0,
      expectedComment: "No deterministic conflicts found",
    },
  ])(
    "required mode maps $validation validation to $outcome",
    async ({
      validation,
      outcome,
      blocked,
      exitCode,
      expectedComment,
    }) => {
      const comments: string[] = [];
      const fetchImpl = vi.fn(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/api/skill-catalog/sources/mimir-main")) {
            return json(SOURCE);
          }
          if (url.includes("/pulls/42/files")) {
            return json([
              { filename: "shared/skills/new.md", status: "added" },
            ]);
          }
          if (url.includes("/contents/")) {
            return json({
              type: "file",
              encoding: "base64",
              content: Buffer.from("# New\n\nUnique.").toString("base64"),
            });
          }
          if (url.endsWith("/api/skill-conflicts")) {
            if (validation === "unavailable") {
              return json({ error: "catalog_not_ready" }, { status: 503 });
            }
            if (validation === "malformed") {
              const payload = JSON.parse(String(init?.body)) as {
                candidates: Array<{ candidateId: string }>;
              };
              return json({
                catalog: {
                  commitSha: BASE_SHA,
                  snapshotState: "entries_ready",
                },
                matcherVersion: "v1",
                results: payload.candidates.map((candidate) => ({
                  candidateId: candidate.candidateId,
                  status: "conflict_found",
                  conflicts: [{ kind: "behavioral_near_duplicate" }],
                  related: [],
                })),
              });
            }
            const payload = JSON.parse(String(init?.body)) as {
              candidates: Array<{ candidateId: string }>;
            };
            return json({
              catalog: {
                commitSha: BASE_SHA,
                snapshotState: "entries_ready",
              },
              matcherVersion: "v1",
              results: payload.candidates.map((candidate) => ({
                candidateId: candidate.candidateId,
                status:
                  validation === "conflict" ? "conflict_found" : "clear",
                conflicts:
                  validation === "conflict"
                    ? [
                        {
                          kind: "exact_content",
                          existing: {
                            path: "shared/skills/existing.md",
                          },
                        },
                      ]
                    : [],
                related: [
                  {
                    name: "Existing helper",
                    namespace: "shared",
                    path: "shared/skills/existing-helper.md",
                    blobSha: "e".repeat(40),
                    similarity: 0.8,
                    excerpt: "A related but non-blocking helper.",
                  },
                  { path: "malformed advisory data" },
                ],
              })),
            });
          }
          if (url.includes("/issues/42/comments?")) return json([]);
          if (
            url.endsWith("/issues/42/comments") &&
            init?.method === "POST"
          ) {
            if (validation === "clear_comment_failure") {
              return json(
                { message: "comment service unavailable" },
                { status: 503 },
              );
            }
            comments.push(
              (JSON.parse(String(init.body)) as { body: string }).body,
            );
            return json({ id: 4 }, { status: 201 });
          }
          throw new Error(
            `Unexpected request: ${init?.method ?? "GET"} ${url}`,
          );
        },
      ) as typeof fetch;

      const result = await runSkillConflictCheck(
        { ...CONFIG, mode: "required" },
        EVENT,
        { fetchImpl },
      );
      const decision = decideSkillConflictCheck(result);

      expect(result).toMatchObject({
        mode: "required",
        outcome,
        candidateCount: 1,
        conflictCount: validation === "conflict" ? 1 : 0,
        relatedCount:
          validation === "unavailable" || validation === "malformed" ? 0 : 1,
        unavailable:
          validation === "unavailable" || validation === "malformed",
      });
      expect(decision).toEqual({
        mode: "required",
        outcome,
        blocked,
        exitCode,
      });
      expect(result.commentBody).toContain(
        "PIM skill conflict check (required)",
      );
      expect(result.commentBody).toContain(expectedComment);
      expect(result.commentBody).not.toContain("remains non-blocking");
      if (validation === "clear_comment_failure") {
        expect(comments).toHaveLength(0);
        expect(result).toMatchObject({
          commentPosted: false,
          commentError: expect.stringContaining(
            "Posting skill-conflict PR comment failed",
          ),
        });
      } else {
        expect(comments).toHaveLength(1);
        expect(result).toMatchObject({
          commentPosted: true,
          commentError: null,
        });
      }
      if (validation !== "unavailable" && validation !== "malformed") {
        expect(result.commentBody).toContain("Related skills (advisory)");
        expect(result.commentBody).toContain("never block this check");
      }
    },
  );

  it("splits more than 20 changed skills into API-safe batches", async () => {
    const payloadSizes: number[] = [];
    const files = Array.from({ length: 21 }, (_, index) => ({
      filename: `projects/batch/skills/${index}.md`,
      status: "added",
    }));
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/skill-catalog/sources/mimir-main")) return json(SOURCE);
      if (url.includes("/pulls/42/files")) return json(files);
      if (url.includes("/contents/")) {
        const path = decodedContentPath(url);
        const bodyPath = path.endsWith("/20.md")
          ? "projects/batch/skills/0.md"
          : path;
        return json({
          type: "file",
          encoding: "base64",
          content: Buffer.from(`# ${bodyPath}\n\nUnique.`).toString("base64"),
        });
      }
      if (url.endsWith("/api/skill-conflicts")) {
        const payload = JSON.parse(String(init?.body)) as {
          candidates: Array<{ candidateId: string }>;
        };
        payloadSizes.push(payload.candidates.length);
        return json({
          catalog: { commitSha: BASE_SHA, snapshotState: "entries_ready" },
          matcherVersion: "v1",
          results: payload.candidates.map((candidate) => ({
            candidateId: candidate.candidateId,
            status: "clear",
            conflicts: [],
            related: [],
          })),
        });
      }
      if (url.includes("/issues/42/comments?")) return json([]);
      if (url.endsWith("/issues/42/comments")) return json({ id: 3 }, { status: 201 });
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    }) as typeof fetch;

    const result = await runAdvisorySkillConflictCheck(CONFIG, EVENT, {
      fetchImpl,
    });

    expect(result.candidateCount).toBe(21);
    expect(payloadSizes).toEqual([20, 1]);
    expect(result.conflictCount).toBeGreaterThan(0);
    expect(result.commentBody).toContain("candidate_exact_content");
  });

  it("uses stable bounded candidate IDs for repository paths over 200 characters", async () => {
    const nestedPath = Array.from(
      { length: 24 },
      (_, index) => `segment-${index}`,
    ).join("/");
    const paths = [
      `projects/long/skills/${nestedPath}/first.md`,
      `projects/long/skills/${nestedPath}/second.md`,
    ];
    const validationPayloads: Array<{
      candidates: Array<{ candidateId: string; proposedPath: string }>;
    }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/skill-catalog/sources/mimir-main")) {
          return json(SOURCE);
        }
        if (url.includes("/pulls/42/files")) {
          return json(paths.map((filename) => ({ filename, status: "added" })));
        }
        if (url.includes("/contents/")) {
          const path = decodedContentPath(url);
          return json({
            type: "file",
            encoding: "base64",
            content: Buffer.from(
              path.endsWith("/first.md") ? "# First" : "# Second",
            ).toString("base64"),
          });
        }
        if (url.endsWith("/api/skill-conflicts")) {
          const payload = JSON.parse(String(init?.body)) as {
            candidates: Array<{
              candidateId: string;
              proposedPath: string;
            }>;
          };
          validationPayloads.push(payload);
          return json({
            catalog: {
              commitSha: BASE_SHA,
              snapshotState: "entries_ready",
            },
            matcherVersion: "v1",
            results: payload.candidates.map((candidate) => ({
              candidateId: candidate.candidateId,
              status: "clear",
              conflicts: [],
              related: [],
            })),
          });
        }
        if (url.includes("/issues/42/comments?")) return json([]);
        if (url.endsWith("/issues/42/comments")) {
          return json({ id: 5 }, { status: 201 });
        }
        throw new Error(
          `Unexpected request: ${init?.method ?? "GET"} ${url}`,
        );
      },
    ) as typeof fetch;

    const result = await runAdvisorySkillConflictCheck(CONFIG, EVENT, {
      fetchImpl,
    });

    expect(paths.every((path) => path.length > 200 && path.length <= 1_024)).toBe(
      true,
    );
    expect(result).toMatchObject({
      outcome: "clear",
      candidateCount: 2,
      unavailable: false,
    });
    const candidates = validationPayloads[0]?.candidates ?? [];
    const expectedIds = paths.map(
      (path) =>
        `path-sha256:${createHash("sha256").update(path, "utf8").digest("hex")}`,
    );
    expect(candidates.map((candidate) => candidate.candidateId)).toEqual(
      expectedIds,
    );
    expect(new Set(expectedIds).size).toBe(paths.length);
    expect(expectedIds.every((candidateId) => candidateId.length <= 200)).toBe(
      true,
    );
    expect(candidates.map((candidate) => candidate.proposedPath)).toEqual(
      paths,
    );
  });
});
