import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalJsonSha256,
  parseMemoryContract,
  type CodeEvidenceManifestV2,
  type MemoryAttestationV1,
  type MemoryCandidateV1,
  type RunReceiptV1,
} from "@pim/shared";
import db from "../../db/connection.js";
import { createMemoryTestContext, type MemoryTestContext } from "../../routes/__tests__/memory-test-app.js";
import {
  reconcileVerifiedGithubState,
  type AuthoritativeGithubState,
} from "../memory-activation.js";
import {
  canonicalMemoryConflictKey,
  getMemoryRecord,
  getMemoryRecordHistory,
  transitionMemoryRecordStatus,
} from "../memory-records.js";
import { runMemoryOutboxPass } from "../memory-outbox.js";
import {
  acceptMemoryRunReceipt,
  canonicalEvidenceManifestDigest,
} from "../memory-receipts.js";
import { resolveMemoryRepository, type MemoryRepositoryBinding } from "../memory-repository-registry.js";

const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const LATER_BASE_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const FIRST_HEAD_SHA = "1111111111111111111111111111111111111111";
const SECOND_HEAD_SHA = "2222222222222222222222222222222222222222";
const FIRST_MERGE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECOND_MERGE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

interface ActivationFixture {
  candidateId: string;
  attestationRowId: string;
  attestation: MemoryAttestationV1;
  state: AuthoritativeGithubState;
}

let context: MemoryTestContext;
let repository: MemoryRepositoryBinding;

function prepareActivation(input: {
  contentMarker: string;
  claimMarker: string;
  headSha: string;
  mergeSha: string;
  now: string;
  baseSha?: string;
  kind?: MemoryCandidateV1["kind"];
  supersedesRecordId?: string;
}): ActivationFixture {
  const baseSha = input.baseSha ?? BASE_SHA;
  const suffix = randomUUID();
  const producerRunId = `fiesta:test:lifecycle:${suffix}`;
  const evidenceRefId = `diff-${suffix}`;
  const providerPullRequestId = `github:acme/checkout#${suffix}`;
  const diffDigest = canonicalJsonSha256({ diff: suffix });
  const manifestBody: Omit<CodeEvidenceManifestV2, "digest"> = {
    schema_version: "pim.memory-code-evidence.v2",
    manifest_id: `manifest-${suffix}`,
    refs: [{
      id: evidenceRefId,
      type: "git_diff",
      uri: `https://github.com/acme/checkout/commit/${input.headSha}.diff`,
      digest: diffDigest,
      origin_id: `github.com/acme/checkout:${input.headSha}:${evidenceRefId}`,
      occurred_at: input.now,
      source_authority: "observed",
    }],
  };
  const manifest = parseMemoryContract("CodeEvidenceManifestV2", {
    ...manifestBody,
    digest: canonicalEvidenceManifestDigest(manifestBody),
  });
  const candidate = parseMemoryContract("MemoryCandidateV1", {
    schema_version: "pim.memory-candidate.v1",
    client_candidate_id: `candidate-${suffix}`,
    plane: "codebase",
    kind: input.kind ?? "constraint",
    content: {
      summary: `Preserve the ${input.contentMarker} checkout invariant.`,
      details: `The ${input.contentMarker} implementation must preserve the verified lifecycle behavior for this exact claim.`,
      rationale: `The ${input.contentMarker} rule prevents an unsafe checkout regression after a verified merge.`,
    },
    applicability: {
      repository_id: "github.com/acme/checkout",
      base_sha: baseSha,
      paths: [`src/${input.claimMarker}.ts`],
      symbols: [`${input.claimMarker}_boundary`],
      task_classes: ["bug_fix"],
    },
    validation: { strategy: "repository_anchors" },
    exceptions: [],
    source_run_ids: [producerRunId],
    evidence_refs: [evidenceRefId],
    extraction: {
      method: "model_then_deterministic_validation",
      extractor_version: "fiesta-candidate-extractor.lifecycle-test-v1",
      confidence: 0.95,
    },
    activation_requirement_requested: "verified_merge",
    ...(input.supersedesRecordId
      ? { extensions: { supersedes_record_id: input.supersedesRecordId } }
      : {}),
  }) as MemoryCandidateV1;
  const receipt = parseMemoryContract("RunReceiptV1", {
    schema_version: "pim.run-receipt.v1",
    external_session_id: `fiesta-thread-${suffix}`,
    producer: {
      harness_id: "fiesta",
      harness_version: "lifecycle-test",
      workflow_version: "code-change.v3",
      adapter_version: "fiesta-pim-adapter.v1",
    },
    tenant: { project_id: context.projectA },
    repository: {
      repository_id: "github.com/acme/checkout",
      display_slug: "Acme/Checkout",
      base_sha: baseSha,
      candidate_tree_sha: input.headSha,
      provider_pull_request_id: providerPullRequestId,
      pr_head_sha: input.headSha,
      pull_request_url: `https://github.com/acme/checkout/pull/${suffix}`,
    },
    task: {
      task_class: "bug_fix",
      summary: `Verify the ${input.contentMarker} lifecycle candidate.`,
    },
    outcome: {
      status: "completed",
      terminal_stage: "close",
      reason_code: "completed",
      verification_status: "passed",
      publication_status: "pr_open",
      gate_attestation_ids: [],
      failure_fingerprint: null,
    },
    retrieval_feedback: [],
    evidence_manifest: manifest,
    candidates: [candidate],
  }) as RunReceiptV1;
  const accepted = acceptMemoryRunReceipt({
    orgId: context.orgA.id,
    projectId: context.projectA,
    principalId: "memory-activation-lifecycle-test",
    producerRunId,
    repository,
    receipt,
    now: input.now,
  });
  const candidateId = accepted.result.candidate_results[0]!.candidate_id;
  expect(runMemoryOutboxPass({
    workerId: `candidate-validator-${suffix}`,
    maxJobs: 1,
    aggregateIds: [candidateId],
    now: input.now,
  })).toEqual({ claimed: 1, completed: 1, retried: 0, deadLettered: 0 });
  expect(db.prepare(
    "SELECT current_status FROM memory_candidates_v1 WHERE candidate_id = ?",
  ).get(candidateId)).toEqual({ current_status: "pending_merge" });

  const attestation = parseMemoryContract("MemoryAttestationV1", {
    schema_version: "pim.memory-attestation.v1",
    attestation_id: `attestation-${suffix}`,
    provider_event_id: `github-delivery-${suffix}`,
    type: "github_merge",
    repository_id: "github.com/acme/checkout",
    provider_pull_request_id: providerPullRequestId,
    base_sha: baseSha,
    head_sha: input.headSha,
    merge_sha: input.mergeSha,
    manifest_digest: manifest.digest,
    occurred_at: input.now,
  });
  const attestationRowId = `attestation_row_${suffix}`;
  const payloadDigest = canonicalJsonSha256(attestation);
  db.prepare(
    `INSERT INTO memory_attestations
       (attestation_row_id, org_id, project_id, repository_row_id, provider,
        provider_delivery_id, provider_event_id, producer_attestation_id,
        attestation_type, payload_digest, attestation_json,
        provider_pull_request_id, base_sha, head_sha, merge_sha, manifest_digest,
        occurred_at, verified_at, created_at)
     VALUES (?, ?, ?, ?, 'github', ?, ?, ?, 'github_merge', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    attestationRowId,
    context.orgA.id,
    context.projectA,
    repository.repository_row_id,
    attestation.provider_event_id,
    attestation.provider_event_id,
    attestation.attestation_id,
    payloadDigest,
    JSON.stringify(attestation),
    providerPullRequestId,
    baseSha,
    input.headSha,
    input.mergeSha,
    manifest.digest,
    input.now,
    input.now,
    input.now,
  );
  return {
    candidateId,
    attestationRowId,
    attestation,
    state: {
      repositoryId: "github.com/acme/checkout",
      providerPullRequestId,
      merged: true,
      baseSha,
      headSha: input.headSha,
      mergeSha: input.mergeSha,
      manifestDigest: manifest.digest,
      finalDiffDigest: diffDigest,
      occurredAt: input.now,
      sourceCursor: attestation.provider_event_id,
    },
  };
}

function activate(fixture: ActivationFixture, now: string) {
  return reconcileVerifiedGithubState({
    orgId: context.orgA.id,
    projectId: context.projectA,
    repositoryRowId: repository.repository_row_id,
    attestationRowId: fixture.attestationRowId,
    attestation: fixture.attestation,
    state: fixture.state,
    now,
  });
}

beforeAll(async () => {
  context = await createMemoryTestContext();
  const resolved = resolveMemoryRepository(
    context.orgA.id,
    context.projectA,
    "github.com/acme/checkout",
  );
  if (!resolved) throw new Error("Memory lifecycle fixture repository was not registered");
  repository = resolved;
});

afterAll(async () => {
  if (context) await context.app.close();
});

describe("verified memory activation lifecycle", () => {
  it("normalizes empty selectors and excludes checkout base from the conflict identity", () => {
    const withoutOptionalSelectors = canonicalMemoryConflictKey({
      kind: "constraint",
      applicability: { repository_id: "github.com/acme/checkout", base_sha: BASE_SHA },
    });
    const normalizedEquivalent = canonicalMemoryConflictKey({
      kind: "constraint",
      applicability: {
        repository_id: "github.com/acme/checkout",
        base_sha: LATER_BASE_SHA,
        paths: [],
        symbols: [],
        components: [],
        task_classes: [],
      },
    });
    expect(normalizedEquivalent).toBe(withoutOptionalSelectors);
  });

  it("replays the same verified activation without duplicating canonical state", () => {
    const fixture = prepareActivation({
      contentMarker: `replay-${randomUUID()}`,
      claimMarker: `replay_claim_${randomUUID().replaceAll("-", "_")}`,
      headSha: FIRST_HEAD_SHA,
      mergeSha: FIRST_MERGE_SHA,
      now: "2026-08-03T18:00:00.000Z",
    });
    const first = activate(fixture, "2026-08-03T18:01:00.000Z");
    expect(first).toMatchObject({
      status: "activated",
      candidateIds: [fixture.candidateId],
    });
    const recordId = first.recordIds[0]!;
    const replay = activate(fixture, "2026-08-03T18:02:00.000Z");
    expect(replay).toEqual(first);

    expect((db.prepare(
      "SELECT COUNT(*) AS count FROM memory_records WHERE record_id = ?",
    ).get(recordId) as { count: number }).count).toBe(1);
    expect((db.prepare(
      "SELECT COUNT(*) AS count FROM memory_record_versions WHERE record_id = ?",
    ).get(recordId) as { count: number }).count).toBe(1);
    expect((db.prepare(
      `SELECT COUNT(*) AS count FROM memory_transitions
       WHERE aggregate_type = 'candidate' AND aggregate_id = ? AND to_status = 'active'`,
    ).get(fixture.candidateId) as { count: number }).count).toBe(1);
    expect((db.prepare(
      `SELECT COUNT(*) AS count FROM memory_transitions
       WHERE aggregate_type = 'record' AND aggregate_id = ? AND to_status = 'active'`,
    ).get(recordId) as { count: number }).count).toBe(1);
    expect((db.prepare(
      "SELECT COUNT(*) AS count FROM memory_origins WHERE attestation_row_id = ?",
    ).get(fixture.attestationRowId) as { count: number }).count).toBe(1);
    expect((db.prepare(
      `SELECT COUNT(*) AS count FROM memory_outbox
       WHERE aggregate_type = 'record' AND aggregate_id = ?`,
    ).get(recordId) as { count: number }).count).toBe(2);
    expect(db.prepare(
      `SELECT current_status, aggregate_version, active_record_id, active_record_version
       FROM memory_candidates_v1 WHERE candidate_id = ?`,
    ).get(fixture.candidateId)).toEqual({
      current_status: "active",
      aggregate_version: 4,
      active_record_id: recordId,
      active_record_version: 1,
    });
  });

  it("supersedes the predecessor while preserving both immutable records and linkage", () => {
    const claimMarker = `successor_claim_${randomUUID().replaceAll("-", "_")}`;
    const predecessor = prepareActivation({
      contentMarker: `predecessor-${randomUUID()}`,
      claimMarker,
      headSha: FIRST_HEAD_SHA,
      mergeSha: FIRST_MERGE_SHA,
      now: "2026-08-03T19:00:00.000Z",
    });
    const predecessorResult = activate(predecessor, "2026-08-03T19:01:00.000Z");
    const predecessorRecordId = predecessorResult.recordIds[0]!;

    const successor = prepareActivation({
      contentMarker: `successor-${randomUUID()}`,
      claimMarker,
      headSha: SECOND_HEAD_SHA,
      mergeSha: SECOND_MERGE_SHA,
      now: "2026-08-03T20:00:00.000Z",
      baseSha: LATER_BASE_SHA,
      supersedesRecordId: predecessorRecordId,
    });
    const successorResult = activate(successor, "2026-08-03T20:01:00.000Z");
    const successorRecordId = successorResult.recordIds[0]!;
    expect(successorRecordId).not.toBe(predecessorRecordId);

    expect(getMemoryRecord(
      context.orgA.id,
      context.projectA,
      predecessorRecordId,
      1,
    )).toMatchObject({
      record_id: predecessorRecordId,
      record_version: 1,
      lifecycle: { status: "superseded" },
      transition_summary: {
        from_status: "active",
        to_status: "superseded",
        reason_code: "verified_successor_activated",
      },
    });
    expect(getMemoryRecord(
      context.orgA.id,
      context.projectA,
      successorRecordId,
      1,
    )).toMatchObject({
      record_id: successorRecordId,
      record_version: 1,
      lifecycle: { status: "active" },
      transition_summary: {
        from_status: null,
        to_status: "active",
        reason_code: "verified_merge_activated",
      },
    });
    expect(db.prepare(
      `SELECT predecessor_record_id, predecessor_record_version,
              successor_record_id, successor_record_version, candidate_id,
              attestation_row_id, transition_id
       FROM memory_record_supersessions WHERE predecessor_record_id = ?`,
    ).get(predecessorRecordId)).toMatchObject({
      predecessor_record_id: predecessorRecordId,
      predecessor_record_version: 1,
      successor_record_id: successorRecordId,
      successor_record_version: 1,
      candidate_id: successor.candidateId,
      attestation_row_id: successor.attestationRowId,
      transition_id: expect.stringMatching(/^transition_/),
    });
    expect((db.prepare(
      `SELECT COUNT(*) AS count FROM memory_record_versions
       WHERE record_id IN (?, ?)`,
    ).get(predecessorRecordId, successorRecordId) as { count: number }).count).toBe(2);
    expect(db.prepare(
      `SELECT current_candidate_id, current_record_id, current_record_version, aggregate_version
       FROM memory_activation_claims
       WHERE org_id = ? AND project_id = ? AND repository_row_id = ?
         AND current_record_id = ?`,
    ).get(
      context.orgA.id,
      context.projectA,
      repository.repository_row_id,
      successorRecordId,
    )).toEqual({
      current_candidate_id: successor.candidateId,
      current_record_id: successorRecordId,
      current_record_version: 1,
      aggregate_version: 3,
    });
    expect(db.prepare(
      `SELECT record_id FROM memory_records
       WHERE record_id IN (?, ?) AND current_status = 'active'`,
    ).all(predecessorRecordId, successorRecordId)).toEqual([{ record_id: successorRecordId }]);

    expect(getMemoryRecordHistory(
      context.orgA.id,
      context.projectA,
      predecessorRecordId,
    )).toMatchObject({
      record_id: predecessorRecordId,
      lifecycle: { status: "superseded" },
      versions: [{ record_version: 1 }],
      transitions: [
        { from_status: null, to_status: "active" },
        { from_status: "active", to_status: "superseded", reason_code: "verified_successor_activated" },
      ],
      replaces: null,
      replaced_by: {
        record_id: successorRecordId,
        record_version: 1,
        lifecycle: { status: "active" },
        reason_code: "verified_successor_activated",
      },
    });
    expect(getMemoryRecordHistory(
      context.orgA.id,
      context.projectA,
      successorRecordId,
    )).toMatchObject({
      record_id: successorRecordId,
      lifecycle: { status: "active" },
      replaces: {
        record_id: predecessorRecordId,
        record_version: 1,
        lifecycle: { status: "superseded" },
        reason_code: "verified_successor_activated",
      },
      replaced_by: null,
    });
  });

  it("keeps different kinds on the same selectors independently active", () => {
    const claimMarker = `shared_scope_${randomUUID().replaceAll("-", "_")}`;
    const first = prepareActivation({
      contentMarker: `independent-first-${randomUUID()}`,
      claimMarker,
      headSha: FIRST_HEAD_SHA,
      mergeSha: FIRST_MERGE_SHA,
      now: "2026-08-03T21:00:00.000Z",
    });
    const second = prepareActivation({
      contentMarker: `independent-second-${randomUUID()}`,
      claimMarker,
      headSha: SECOND_HEAD_SHA,
      mergeSha: SECOND_MERGE_SHA,
      now: "2026-08-03T21:01:00.000Z",
      kind: "decision",
    });
    const firstRecordId = activate(first, "2026-08-03T21:02:00.000Z").recordIds[0]!;
    const secondRecordId = activate(second, "2026-08-03T21:03:00.000Z").recordIds[0]!;
    expect(secondRecordId).not.toBe(firstRecordId);
    expect(db.prepare(
      `SELECT record_id, current_status FROM memory_records
       WHERE record_id IN (?, ?) ORDER BY record_id`,
    ).all(firstRecordId, secondRecordId)).toEqual([
      { record_id: firstRecordId, current_status: "active" },
      { record_id: secondRecordId, current_status: "active" },
    ].sort((left, right) => left.record_id.localeCompare(right.record_id)));
    expect((db.prepare(
      `SELECT COUNT(*) AS count FROM memory_record_supersessions
       WHERE predecessor_record_id IN (?, ?) OR successor_record_id IN (?, ?)`,
    ).get(firstRecordId, secondRecordId, firstRecordId, secondRecordId) as { count: number }).count).toBe(0);
  });

  it("fails closed when a different claim occupies the applicability lock", () => {
    const claimMarker = `locked_scope_${randomUUID().replaceAll("-", "_")}`;
    const first = prepareActivation({
      contentMarker: `locked-first-${randomUUID()}`,
      claimMarker,
      headSha: FIRST_HEAD_SHA,
      mergeSha: FIRST_MERGE_SHA,
      now: "2026-08-03T21:10:00.000Z",
    });
    const conflicting = prepareActivation({
      contentMarker: `locked-conflict-${randomUUID()}`,
      claimMarker,
      headSha: SECOND_HEAD_SHA,
      mergeSha: SECOND_MERGE_SHA,
      now: "2026-08-03T21:11:00.000Z",
    });
    const firstRecordId = activate(first, "2026-08-03T21:12:00.000Z").recordIds[0]!;

    expect(() => activate(conflicting, "2026-08-03T21:13:00.000Z"))
      .toThrow("A different active claim already owns this applicability scope");
    expect(db.prepare(
      `SELECT current_status, active_record_id FROM memory_candidates_v1
       WHERE candidate_id = ?`,
    ).get(conflicting.candidateId)).toEqual({
      current_status: "pending_merge",
      active_record_id: null,
    });
    expect((db.prepare(
      `SELECT COUNT(*) AS count FROM memory_records
       WHERE org_id = ? AND project_id = ? AND current_status = 'active'
         AND record_id = ?`,
    ).get(context.orgA.id, context.projectA, firstRecordId) as { count: number }).count).toBe(1);
  });

  it("cannot use same-claim reuse to supersede an unrelated active record", () => {
    const contentMarker = `same-claim-${randomUUID()}`;
    const claimMarker = `same_claim_scope_${randomUUID().replaceAll("-", "_")}`;
    const first = prepareActivation({
      contentMarker,
      claimMarker,
      headSha: FIRST_HEAD_SHA,
      mergeSha: FIRST_MERGE_SHA,
      now: "2026-08-03T21:20:00.000Z",
    });
    const unrelated = prepareActivation({
      contentMarker: `unrelated-${randomUUID()}`,
      claimMarker: `unrelated_scope_${randomUUID().replaceAll("-", "_")}`,
      headSha: SECOND_HEAD_SHA,
      mergeSha: SECOND_MERGE_SHA,
      now: "2026-08-03T21:21:00.000Z",
    });
    const firstRecordId = activate(first, "2026-08-03T21:22:00.000Z").recordIds[0]!;
    const unrelatedRecordId = activate(unrelated, "2026-08-03T21:23:00.000Z").recordIds[0]!;
    const maliciousReplay = prepareActivation({
      contentMarker,
      claimMarker,
      headSha: FIRST_HEAD_SHA,
      mergeSha: FIRST_MERGE_SHA,
      now: "2026-08-03T21:24:00.000Z",
      supersedesRecordId: unrelatedRecordId,
    });

    expect(() => activate(maliciousReplay, "2026-08-03T21:25:00.000Z"))
      .toThrow("The declared predecessor is not a valid successor target");
    expect(db.prepare(
      `SELECT record_id, current_status FROM memory_records
       WHERE record_id IN (?, ?) ORDER BY record_id`,
    ).all(firstRecordId, unrelatedRecordId)).toEqual([
      { record_id: firstRecordId, current_status: "active" },
      { record_id: unrelatedRecordId, current_status: "active" },
    ].sort((left, right) => left.record_id.localeCompare(right.record_id)));
    expect((db.prepare(
      `SELECT COUNT(*) AS count FROM memory_record_supersessions
       WHERE predecessor_record_id IN (?, ?)`,
    ).get(firstRecordId, unrelatedRecordId) as { count: number }).count).toBe(0);
  });

  it("does not reactivate an inactive canonical claim through deduplication", () => {
    const contentMarker = `inactive-${randomUUID()}`;
    const claimMarker = `inactive_scope_${randomUUID().replaceAll("-", "_")}`;
    const first = prepareActivation({
      contentMarker,
      claimMarker,
      headSha: FIRST_HEAD_SHA,
      mergeSha: FIRST_MERGE_SHA,
      now: "2026-08-03T21:30:00.000Z",
    });
    const recordId = activate(first, "2026-08-03T21:31:00.000Z").recordIds[0]!;
    transitionMemoryRecordStatus({
      orgId: context.orgA.id,
      projectId: context.projectA,
      recordId,
      toStatus: "revoked",
      actorId: "memory-lifecycle-test",
      reasonCode: "test_revocation",
      explanation: "Exercise inactive canonical claim handling.",
      now: "2026-08-03T21:32:00.000Z",
    });
    db.prepare(
      `UPDATE memory_activation_claims
       SET aggregate_version = aggregate_version + 1,
           current_candidate_id = NULL, current_record_id = NULL,
           current_record_version = NULL, updated_at = ?
       WHERE current_record_id = ?`,
    ).run("2026-08-03T21:32:00.000Z", recordId);
    const laterOrigin = prepareActivation({
      contentMarker,
      claimMarker,
      headSha: SECOND_HEAD_SHA,
      mergeSha: SECOND_MERGE_SHA,
      now: "2026-08-03T21:33:00.000Z",
    });

    expect(() => activate(laterOrigin, "2026-08-03T21:34:00.000Z"))
      .toThrow("canonical claim exists only in inactive history");
    expect(getMemoryRecord(context.orgA.id, context.projectA, recordId, 1))
      .toMatchObject({ lifecycle: { status: "revoked" } });
    expect(db.prepare(
      `SELECT current_status, active_record_id FROM memory_candidates_v1
       WHERE candidate_id = ?`,
    ).get(laterOrigin.candidateId)).toEqual({
      current_status: "pending_merge",
      active_record_id: null,
    });
  });

  it("reuses one canonical record for the same claim from an independent origin", () => {
    const contentMarker = `corroborated-${randomUUID()}`;
    const claimMarker = `corroborated_scope_${randomUUID().replaceAll("-", "_")}`;
    const first = prepareActivation({
      contentMarker,
      claimMarker,
      headSha: FIRST_HEAD_SHA,
      mergeSha: FIRST_MERGE_SHA,
      now: "2026-08-03T22:00:00.000Z",
    });
    const second = prepareActivation({
      contentMarker,
      claimMarker,
      headSha: SECOND_HEAD_SHA,
      mergeSha: SECOND_MERGE_SHA,
      now: "2026-08-03T22:01:00.000Z",
    });
    const firstResult = activate(first, "2026-08-03T22:02:00.000Z");
    const secondResult = activate(second, "2026-08-03T22:03:00.000Z");
    expect(secondResult.recordIds).toEqual(firstResult.recordIds);
    const recordId = firstResult.recordIds[0]!;
    expect(db.prepare(
      `SELECT current_status, active_record_id, active_record_version
       FROM memory_candidates_v1 WHERE candidate_id = ?`,
    ).get(second.candidateId)).toEqual({
      current_status: "active",
      active_record_id: recordId,
      active_record_version: 1,
    });
    expect((db.prepare(
      `SELECT COUNT(*) AS count FROM memory_origins
       WHERE attestation_row_id IN (?, ?)`,
    ).get(first.attestationRowId, second.attestationRowId) as { count: number }).count).toBe(2);
    expect(db.prepare(
      `SELECT status FROM memory_outbox
       WHERE job_type = 'record_revalidation'
         AND json_extract(payload_json, '$.candidate_id') = ?`,
    ).get(second.candidateId)).toEqual({ status: "pending" });
    expect(runMemoryOutboxPass({
      maxJobs: 1,
      aggregateIds: [recordId],
      jobTypes: ["record_revalidation"],
      now: "2026-08-03T22:04:00.000Z",
    })).toEqual({ claimed: 1, completed: 1, retried: 0, deadLettered: 0 });
  });
});
