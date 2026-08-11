import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJsonSha256,
  parseMemoryContract,
  type MemoryAttestationV1,
} from "@pim/shared";
import db from "../../db/connection.js";
import {
  createMemoryTestContext,
  type MemoryTestContext,
} from "../../routes/__tests__/memory-test-app.js";
import {
  setMemoryGithubResolver,
} from "../memory-attestations.js";
import { importActiveMemoryRecord } from "../memory-records.js";
import { resolveMemoryRepository } from "../memory-repository-registry.js";
import { memoryV2ProductionReverificationProvider } from "../memory-v2-reverification-provider.js";
import type { MemoryV2ReverificationProviderContext } from "../memory-v2-reverification.js";

const NOW = "2026-08-10T12:00:00.000Z";
const MERGED_AT = "2026-08-01T12:00:00.000Z";
const REVERTED_AT = "2026-08-02T12:00:00.000Z";
const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const MERGE_SHA = "3".repeat(40);
const MANIFEST_DIGEST = `sha256:${"4".repeat(64)}`;
const DIFF_DIGEST = `sha256:${"5".repeat(64)}`;

let context: MemoryTestContext;

function seedGithubRecord(): {
  providerContext: MemoryV2ReverificationProviderContext;
  attestation: MemoryAttestationV1;
} {
  const repository = resolveMemoryRepository(
    context.orgA.id,
    context.projectA,
    "github.com/acme/checkout",
  )!;
  const marker = randomUUID();
  const attestation = parseMemoryContract("MemoryAttestationV1", {
    schema_version: "pim.memory-attestation.v1",
    attestation_id: `provider-reverify-attestation-${marker}`,
    provider_event_id: `provider-reverify-event-${marker}`,
    type: "github_merge",
    repository_id: repository.repository_id,
    provider_pull_request_id: `github:acme/checkout#${marker.replaceAll("-", "").slice(0, 6)}`,
    base_sha: BASE_SHA,
    head_sha: HEAD_SHA,
    merge_sha: MERGE_SHA,
    manifest_digest: MANIFEST_DIGEST,
    occurred_at: MERGED_AT,
  });
  const attestationRowId = `provider-reverify-attestation-row-${marker}`;
  const payloadDigest = canonicalJsonSha256(attestation);
  db.prepare(
    `INSERT INTO memory_attestations
       (attestation_row_id, org_id, project_id, repository_row_id, provider,
        provider_delivery_id, provider_event_id, producer_attestation_id,
        attestation_type, payload_digest, attestation_json, provider_pull_request_id,
        base_sha, head_sha, merge_sha, manifest_digest, occurred_at, verified_at,
        created_at, authoritative_diff_digest)
     VALUES (?, ?, ?, ?, 'github', ?, ?, ?, 'github_merge', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    attestationRowId,
    context.orgA.id,
    context.projectA,
    repository.repository_row_id,
    `provider-reverify-delivery-${marker}`,
    attestation.provider_event_id,
    attestation.attestation_id,
    payloadDigest,
    JSON.stringify(attestation),
    attestation.provider_pull_request_id!,
    attestation.base_sha!,
    attestation.head_sha!,
    attestation.merge_sha!,
    attestation.manifest_digest,
    attestation.occurred_at,
    MERGED_AT,
    MERGED_AT,
    DIFF_DIGEST,
  );
  const recordId = `provider-reverify-record-${marker}`;
  const record = importActiveMemoryRecord({
    orgId: context.orgA.id,
    projectId: context.projectA,
    repositoryRowId: repository.repository_row_id,
    recordId,
    kind: "constraint",
    content: {
      summary: `Reverify exact GitHub source ${marker}`,
      details: "The production provider must re-check the immutable activation source.",
      rationale: "A current record cannot remain trusted after its merge source changes.",
    },
    applicability: {
      repository_id: repository.repository_id,
      base_sha: BASE_SHA,
      paths: [`src/provider-${marker}.ts`],
      symbols: [`provider_${marker.replaceAll("-", "_")}`],
      task_classes: ["bug_fix"],
    },
    exceptions: [],
    compatibility: {
      harness_version_range: "*",
      workflow_version_range: "*",
      adapter_version_range: "*",
    },
    validation: {
      strategy: "repository_anchors",
      anchor_refs: [{
        type: "path",
        value: `src/provider-${marker}.ts`,
        digest: DIFF_DIGEST,
      }],
    },
    evidence: [{
      evidence_ref_id: attestationRowId,
      type: "github_merge",
      digest: payloadDigest,
      origin_id: attestation.provider_event_id,
      source_authority: "verified",
    }],
    evidenceSummary: { strength: "verified_merge", ref_count: 1 },
    freshness: { last_confirmed_at: MERGED_AT, expires_at: null },
    provenance: { attestation_id: attestationRowId, extractor_version: "provider-test.v1" },
    now: MERGED_AT,
  });
  const facet = db.prepare(
    `SELECT resource_row_id FROM memory_v2_record_facets
     WHERE record_id = ? AND record_version = ?`,
  ).get(record.record_id, record.record_version) as { resource_row_id: string };
  return {
    attestation,
    providerContext: {
      recordId: record.record_id,
      recordVersion: record.record_version,
      orgId: context.orgA.id,
      projectId: context.projectA,
      plane: "codebase",
      resourceRowId: facet.resource_row_id,
      resolverType: "github",
      policyRevision: 1,
      attemptNumber: 1,
      attemptedAt: NOW,
    },
  };
}

beforeAll(async () => {
  context = await createMemoryTestContext();
});

afterEach(() => {
  setMemoryGithubResolver(null);
});

afterAll(async () => {
  setMemoryGithubResolver(null);
  if (context) await context.app.close();
});

describe.sequential("Slice 6 production reverification provider", () => {
  it("reuses the exact GitHub activation source and maps verified, changed, and reverted state", async () => {
    const seeded = seedGithubRecord();
    const exactState = {
      repositoryId: seeded.attestation.repository_id,
      providerPullRequestId: seeded.attestation.provider_pull_request_id!,
      merged: true,
      reverted: false,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      mergeSha: MERGE_SHA,
      manifestDigest: MANIFEST_DIGEST,
      finalDiffDigest: DIFF_DIGEST,
      occurredAt: MERGED_AT,
      sourceCursor: MERGE_SHA,
    };
    setMemoryGithubResolver(async ({ attestation }) => {
      expect(attestation.type).toBe("github_revert");
      expect(attestation.merge_sha).toBe(MERGE_SHA);
      return exactState;
    });
    await expect(memoryV2ProductionReverificationProvider(seeded.providerContext))
      .resolves.toMatchObject({
        outcome: "verified",
        verifiedAt: NOW,
        sourceOccurredAt: MERGED_AT,
        evidenceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });

    setMemoryGithubResolver(async () => ({ ...exactState, headSha: "6".repeat(40) }));
    await expect(memoryV2ProductionReverificationProvider(seeded.providerContext))
      .resolves.toMatchObject({
        outcome: "contradicted",
        reasonCode: "github_authoritative_state_changed",
      });

    setMemoryGithubResolver(async () => ({
      ...exactState,
      reverted: true,
      occurredAt: REVERTED_AT,
      sourceCursor: "7".repeat(40),
    }));
    const withdrawn = await memoryV2ProductionReverificationProvider(seeded.providerContext);
    expect(withdrawn).toMatchObject({
      outcome: "withdrawn",
      reasonCode: "github_activating_merge_reverted",
      sourceOccurredAt: REVERTED_AT,
    });
    expect(JSON.stringify(withdrawn)).not.toContain(seeded.attestation.provider_pull_request_id);
  });

  it("fails closed for an unsupported plane/resolver pairing", async () => {
    const seeded = seedGithubRecord();
    await expect(memoryV2ProductionReverificationProvider({
      ...seeded.providerContext,
      resolverType: "runtime_attestation",
    })).resolves.toEqual({
      outcome: "unavailable",
      errorCode: "resolver_scope_mismatch",
    });
  });
});
