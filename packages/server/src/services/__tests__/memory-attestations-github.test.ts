import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseMemoryContract,
  type MemoryAttestationV1,
} from "@pim/shared";
import {
  resolveGithubMemoryState,
} from "../memory-attestations.js";
import type { MemoryRepositoryBinding } from "../memory-repository-registry.js";

const MERGE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REVERT_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BASE_SHA = "cccccccccccccccccccccccccccccccccccccccc";
const HEAD_SHA = "dddddddddddddddddddddddddddddddddddddddd";
const MERGED_AT = "2026-08-01T12:00:00.000Z";
const REVERTED_AT = "2026-08-02T12:00:00.000Z";
const previousGithubToken = process.env.GITHUB_TOKEN;

const repository: MemoryRepositoryBinding = {
  repository_row_id: "repository-github-resolver-test",
  org_id: "org-github-resolver-test",
  project_id: "project-github-resolver-test",
  provider: "github",
  provider_repository_id: "provider-repository-github-resolver-test",
  repository_id: "github.com/acme/checkout",
  display_slug: "Acme/Checkout",
  valid_from: MERGED_AT,
  valid_until: null,
  created_at: MERGED_AT,
  updated_at: MERGED_AT,
};

function revertAttestation(): MemoryAttestationV1 {
  return parseMemoryContract("MemoryAttestationV1", {
    schema_version: "pim.memory-attestation.v1",
    attestation_id: "github-revert-resolver-test",
    provider_event_id: "github-revert-delivery-test",
    type: "github_revert",
    repository_id: repository.repository_id,
    provider_pull_request_id: "github:acme/checkout#42",
    base_sha: BASE_SHA,
    head_sha: HEAD_SHA,
    merge_sha: MERGE_SHA,
    manifest_digest: `sha256:${"e".repeat(64)}`,
    occurred_at: REVERTED_AT,
  });
}

function installGithubFetch(commits: unknown[]): void {
  vi.stubGlobal("fetch", vi.fn(async (
    request: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(request);
    if (url.endsWith("/repos/acme/checkout/pulls/42")) {
      const accept = new Headers(init?.headers).get("accept");
      if (accept === "application/vnd.github.v3.diff") {
        return new Response("diff --git a/src/a.ts b/src/a.ts\n", { status: 200 });
      }
      return new Response(JSON.stringify({
        merged: true,
        merged_at: MERGED_AT,
        merge_commit_sha: MERGE_SHA,
        base: { ref: "main", sha: BASE_SHA },
        head: { sha: HEAD_SHA },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("https://api.github.com/repos/acme/checkout/commits?")) {
      return new Response(JSON.stringify(commits), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }));
}

beforeEach(() => {
  process.env.GITHUB_TOKEN = "github-resolver-test-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  if (previousGithubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = previousGithubToken;
});

describe("production GitHub memory resolver", () => {
  it("resolves a revert only from an exact commit marker on the authoritative base branch", async () => {
    installGithubFetch([{
      sha: REVERT_SHA,
      commit: {
        message: `Revert verified merge\n\nThis reverts commit ${MERGE_SHA}.`,
        committer: { date: REVERTED_AT },
      },
    }]);

    const state = await resolveGithubMemoryState({
      attestation: revertAttestation(),
      repository,
    });
    expect(state).toMatchObject({
      repositoryId: repository.repository_id,
      providerPullRequestId: "github:acme/checkout#42",
      merged: true,
      reverted: true,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      mergeSha: MERGE_SHA,
      occurredAt: REVERTED_AT,
      sourceCursor: REVERT_SHA,
    });
    expect(state.finalDiffDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2]![0])).toContain("sha=main");
    expect(String(fetchMock.mock.calls[2]![0])).toContain("since=2026-08-01T12%3A00%3A00.000Z");
  });

  it("does not accept a revert claim when authoritative commits lack the exact marker", async () => {
    installGithubFetch([{
      sha: REVERT_SHA,
      commit: {
        message: `Revert something else\n\nThis reverts commit ${HEAD_SHA}.`,
        committer: { date: REVERTED_AT },
      },
    }]);
    await expect(resolveGithubMemoryState({
      attestation: revertAttestation(),
      repository,
    })).resolves.toMatchObject({
      merged: true,
      reverted: false,
      sourceCursor: "github-revert-delivery-test",
    });
  });
});
