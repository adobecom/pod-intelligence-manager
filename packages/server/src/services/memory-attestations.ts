import { createHash, randomUUID } from "node:crypto";
import {
  canonicalJsonSha256,
  parseMemoryContract,
  type MemoryAttestationResultV1,
  type MemoryAttestationV1,
  type PimErrorV1,
} from "@pim/shared";
import db, { withImmediateTransaction } from "../db/connection.js";
import type { ServiceTokenAuthMetadata } from "./service-tokens.js";
import { recordMemoryMetric } from "./memory-metrics.js";
import type { MemoryRepositoryBinding } from "./memory-repository-registry.js";
import type { MemoryV2ReverificationProviderResult } from "./memory-v2-reverification.js";
import {
  reconcileVerifiedGithubState,
  type AuthoritativeGithubState,
  type MemoryActivationResult,
} from "./memory-activation.js";

type AttestationErrorCode = PimErrorV1["code"];

export class MemoryAttestationIngressError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: AttestationErrorCode,
  ) {
    super(message);
    this.name = "MemoryAttestationIngressError";
  }
}

export interface ResolveGithubMemoryInput {
  attestation: MemoryAttestationV1;
  repository: MemoryRepositoryBinding;
}

export type MemoryGithubResolver = (
  input: ResolveGithubMemoryInput,
) => Promise<AuthoritativeGithubState>;

export interface SubmitGithubMemoryAttestationInput {
  auth: ServiceTokenAuthMetadata;
  repository: MemoryRepositoryBinding;
  deliveryId: string;
  rawBody: Buffer;
  attestation: MemoryAttestationV1;
}

export type GithubAttestationSubmissionResult = MemoryAttestationResultV1;

export interface MemoryGithubProviderEvent {
  deliveryId: string;
  sourceCursor: string;
  attestation: MemoryAttestationV1;
}

export interface MemoryGithubProviderEventPage {
  events: MemoryGithubProviderEvent[];
  nextCursor: string | null;
}

export type MemoryGithubProviderEventSource = (input: {
  repository: MemoryRepositoryBinding;
  cursor: string | null;
  maxEvents: number;
}) => Promise<MemoryGithubProviderEventPage | null>;

export interface MemoryProviderReconciliationResult {
  repositoryRowId: string;
  previousCursor: string | null;
  nextCursor: string | null;
  discoveredCount: number;
  duplicateCount: number;
  processedCount: number;
}

const GITHUB_PROVIDER_POLL_STREAM = "repository_events_poll";
const GITHUB_CANDIDATE_POLL_CURSOR_PREFIX = "candidate_scan_v1:";

interface InboxRow {
  inbox_event_id: string;
  org_id: string;
  project_id: string;
  repository_row_id: string;
  provider_delivery_id: string;
  event_type: "github_merge" | "github_revert";
  payload_digest: string;
  payload_json: string;
  source_cursor: string | null;
  status: "pending" | "leased" | "unmatched" | "completed" | "dead_letter";
  attempt_count: number;
  max_attempts: number;
  attempt_history_json: string;
  next_attempt_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error_code: string | null;
  occurred_at: string;
  dead_lettered_at: string | null;
  response_json: string | null;
  last_replayed_at: string | null;
}

interface InboxProcessResult {
  inboxEventId: string;
  result: MemoryActivationResult | null;
  errorCode?: string;
}

function rawSha256(body: Buffer): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function configuredActivationRepositories(): Set<string> {
  const raw = process.env.MEMORY_ACTIVATION_REPOSITORIES?.trim();
  if (!raw) return new Set();
  return new Set(raw.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function assertActivationAllowlist(repository: MemoryRepositoryBinding): void {
  const configured = configuredActivationRepositories();
  if (!configured.has(repository.repository_id.toLowerCase())) {
    throw new MemoryAttestationIngressError(
      "Repository is not allowlisted for automatic memory activation",
      403,
      "resource_binding_mismatch",
    );
  }
}

interface GithubPullResponse {
  merged?: boolean;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  base?: { ref?: string; sha?: string };
  head?: { sha?: string };
}

interface GithubCommitResponse {
  sha?: string;
  commit?: {
    message?: string;
    author?: { date?: string | null } | null;
    committer?: { date?: string | null } | null;
  };
}

function githubResolutionError(message: string, status: number): MemoryAttestationIngressError {
  return new MemoryAttestationIngressError(
    message,
    status >= 500 ? 503 : 422,
    status >= 500 ? "temporarily_unavailable" : "evidence_unresolvable",
  );
}

async function findAuthoritativeRevert(input: {
  repositoryPath: string;
  baseRef: string;
  mergeSha: string;
  mergedAt: string;
  headers: Record<string, string>;
}): Promise<{ sha: string; occurredAt: string } | null> {
  const expectedMarker = `this reverts commit ${input.mergeSha.toLowerCase()}.`;
  for (let page = 1; page <= 10; page += 1) {
    const params = new URLSearchParams({
      sha: input.baseRef,
      since: input.mergedAt,
      per_page: "100",
      page: String(page),
    });
    const response = await fetch(
      `https://api.github.com/repos/${input.repositoryPath}/commits?${params.toString()}`,
      { headers: input.headers, signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) {
      throw githubResolutionError("Authoritative GitHub revert resolution failed", response.status);
    }
    const commits = await response.json() as GithubCommitResponse[];
    for (const commit of commits) {
      const hasExactMarker = commit.commit?.message
        ?.split(/\r?\n/)
        .some((line) => line.trim().toLowerCase() === expectedMarker);
      if (hasExactMarker && commit.sha) {
        return {
          sha: commit.sha,
          occurredAt: commit.commit?.committer?.date
            ?? commit.commit?.author?.date
            ?? input.mergedAt,
        };
      }
    }
    if (commits.length < 100) return null;
  }
  throw new MemoryAttestationIngressError(
    "Authoritative GitHub revert history exceeded the bounded scan",
    503,
    "temporarily_unavailable",
  );
}

export async function resolveGithubMemoryState(
  input: ResolveGithubMemoryInput,
): Promise<AuthoritativeGithubState> {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) {
    throw new MemoryAttestationIngressError(
      "Authoritative GitHub resolution is not configured",
      503,
      "temporarily_unavailable",
    );
  }
  const match = input.attestation.provider_pull_request_id?.match(/#(\d+)$/);
  if (!match) {
    throw new MemoryAttestationIngressError(
      "GitHub pull-request identity is invalid",
      422,
      "evidence_unresolvable",
    );
  }
  const repositoryPath = input.repository.repository_id.slice("github.com/".length);
  const apiUrl = `https://api.github.com/repos/${repositoryPath}/pulls/${match[1]}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pim-memory-attestation-resolver",
  };
  const response = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw githubResolutionError("Authoritative GitHub pull-request resolution failed", response.status);
  }
  const pull = await response.json() as GithubPullResponse;
  const diffResponse = await fetch(apiUrl, {
    headers: { ...headers, Accept: "application/vnd.github.v3.diff" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!diffResponse.ok) {
    throw githubResolutionError("Authoritative GitHub diff resolution failed", diffResponse.status);
  }
  const diffDigest = `sha256:${createHash("sha256").update(Buffer.from(await diffResponse.arrayBuffer())).digest("hex")}`;
  let revert: { sha: string; occurredAt: string } | null = null;
  if (input.attestation.type === "github_revert" && pull.merged === true) {
    if (!pull.base?.ref || !pull.merge_commit_sha || !pull.merged_at) {
      throw new MemoryAttestationIngressError(
        "Authoritative GitHub pull request lacks revert correlation fields",
        422,
        "evidence_unresolvable",
      );
    }
    revert = await findAuthoritativeRevert({
      repositoryPath,
      baseRef: pull.base.ref,
      mergeSha: pull.merge_commit_sha,
      mergedAt: pull.merged_at,
      headers,
    });
  }
  return {
    repositoryId: input.repository.repository_id,
    providerPullRequestId: input.attestation.provider_pull_request_id!,
    merged: pull.merged === true,
    reverted: revert !== null,
    baseSha: pull.base?.sha ?? "",
    headSha: pull.head?.sha ?? "",
    mergeSha: pull.merge_commit_sha ?? "",
    manifestDigest: input.attestation.manifest_digest,
    finalDiffDigest: diffDigest,
    occurredAt: revert?.occurredAt ?? pull.merged_at ?? input.attestation.occurred_at,
    sourceCursor: revert?.sha ?? input.attestation.provider_event_id,
  };
}

let githubResolver: MemoryGithubResolver = resolveGithubMemoryState;

export function setMemoryGithubResolver(resolver: MemoryGithubResolver | null): void {
  githubResolver = resolver ?? resolveGithubMemoryState;
}

interface GithubReverificationRecordRow {
  provenance_json: string;
  evidence_json: string;
  repository_row_id: string;
  org_id: string;
  project_id: string;
  provider: "github";
  provider_repository_id: string;
  repository_id: string;
  display_slug: string;
  valid_from: string;
  valid_until: string | null;
  created_at: string;
  updated_at: string;
}

interface GithubReverificationAttestationRow {
  attestation_row_id: string;
  provider_event_id: string;
  producer_attestation_id: string;
  attestation_type: string;
  payload_digest: string;
  attestation_json: string;
  provider_pull_request_id: string | null;
  base_sha: string | null;
  head_sha: string | null;
  merge_sha: string | null;
  manifest_digest: string;
  occurred_at: string;
  authoritative_diff_digest: string | null;
}

export interface ReverifyGithubMemoryRecordInput {
  recordId: string;
  recordVersion: number;
  orgId: string;
  projectId: string;
  resourceRowId: string;
  attemptedAt: string;
}

function unavailableGithubReverification(
  errorCode: string,
): MemoryV2ReverificationProviderResult {
  return { outcome: "unavailable", errorCode };
}

function githubReverificationDigest(input: {
  outcome: "verified" | "contradicted" | "withdrawn";
  attestationRowId: string;
  payloadDigest: string;
  authoritativeDiffDigest: string;
  state: AuthoritativeGithubState;
}): string {
  return canonicalJsonSha256({
    schema_version: "pim.memory-v2-github-reverification-evidence.v1",
    outcome: input.outcome,
    attestation_row_id: input.attestationRowId,
    payload_digest: input.payloadDigest,
    authoritative_diff_digest: input.authoritativeDiffDigest,
    provider_state: {
      repository_id: input.state.repositoryId,
      provider_pull_request_id: input.state.providerPullRequestId,
      merged: input.state.merged,
      reverted: input.state.reverted === true,
      base_sha: input.state.baseSha,
      head_sha: input.state.headSha,
      merge_sha: input.state.mergeSha,
      manifest_digest: input.state.manifestDigest,
      final_diff_digest: input.state.finalDiffDigest,
      occurred_at: input.state.occurredAt,
    },
  });
}

/**
 * Re-check one active codebase record against the same immutable GitHub
 * attestation that activated it. The returned evidence is digest-only; raw
 * provider material never leaves this service boundary.
 */
export async function reverifyGithubMemoryRecord(
  input: ReverifyGithubMemoryRecordInput,
): Promise<MemoryV2ReverificationProviderResult> {
  if (!Number.isFinite(Date.parse(input.attemptedAt))) {
    return unavailableGithubReverification("github_reverification_time_invalid");
  }
  const source = db.prepare(
    `SELECT version.provenance_json, version.evidence_json,
            repository.repository_row_id, repository.org_id, repository.project_id,
            repository.provider, repository.provider_repository_id,
            repository.repository_id, repository.display_slug, repository.valid_from,
            repository.valid_until, repository.created_at, repository.updated_at
     FROM memory_records AS record
     JOIN memory_record_versions AS version
       ON version.record_id = record.record_id AND version.record_version = ?
     JOIN memory_v2_record_facets AS facet
       ON facet.record_id = record.record_id AND facet.record_version = ?
     JOIN memory_v2_resources AS resource
       ON resource.resource_row_id = facet.resource_row_id
     JOIN memory_repository_registry AS repository
       ON repository.repository_row_id = record.repository_row_id
      AND repository.repository_row_id = resource.source_row_id
     WHERE record.record_id = ? AND record.current_version = ?
       AND record.current_status = 'active'
       AND record.org_id = ? AND record.project_id = ? AND record.plane = 'codebase'
       AND facet.org_id = record.org_id AND facet.project_id = record.project_id
       AND facet.plane = 'codebase' AND facet.resource_row_id = ?
       AND facet.projection_status = 'mapped'
       AND resource.org_id = record.org_id AND resource.project_id = record.project_id
       AND resource.plane = 'codebase' AND resource.resource_type = 'repository'
       AND resource.source_authority = 'memory_repository_registry'
       AND resource.valid_until IS NULL AND repository.valid_until IS NULL`,
  ).get(
    input.recordVersion,
    input.recordVersion,
    input.recordId,
    input.recordVersion,
    input.orgId,
    input.projectId,
    input.resourceRowId,
  ) as unknown as GithubReverificationRecordRow | undefined;
  if (!source) return unavailableGithubReverification("github_record_source_unavailable");

  let attestationRowId: string | null = null;
  let evidence: unknown = null;
  try {
    const provenance = JSON.parse(source.provenance_json) as Record<string, unknown>;
    attestationRowId = typeof provenance.attestation_id === "string"
      ? provenance.attestation_id
      : null;
    evidence = JSON.parse(source.evidence_json) as unknown;
  } catch {
    return unavailableGithubReverification("github_record_provenance_invalid");
  }
  if (!attestationRowId || !Array.isArray(evidence)) {
    return unavailableGithubReverification("github_record_attestation_unavailable");
  }

  const stored = db.prepare(
    `SELECT attestation_row_id, provider_event_id, producer_attestation_id,
            attestation_type, payload_digest, attestation_json,
            provider_pull_request_id, base_sha, head_sha, merge_sha,
            manifest_digest, occurred_at, authoritative_diff_digest
     FROM memory_attestations
     WHERE attestation_row_id = ? AND org_id = ? AND project_id = ?
       AND repository_row_id = ? AND provider = 'github'`,
  ).get(
    attestationRowId,
    input.orgId,
    input.projectId,
    source.repository_row_id,
  ) as GithubReverificationAttestationRow | undefined;
  if (!stored || stored.attestation_type !== "github_merge"
      || !/^sha256:[0-9a-f]{64}$/.test(stored.payload_digest)
      || !stored.authoritative_diff_digest
      || !/^sha256:[0-9a-f]{64}$/.test(stored.authoritative_diff_digest)) {
    return unavailableGithubReverification("github_activation_attestation_invalid");
  }

  let attestation: MemoryAttestationV1;
  try {
    attestation = parseMemoryContract(
      "MemoryAttestationV1",
      JSON.parse(stored.attestation_json) as unknown,
    );
  } catch {
    return unavailableGithubReverification("github_activation_attestation_invalid");
  }
  const exactEvidence = evidence.some((item) => {
    if (!item || typeof item !== "object") return false;
    const handle = item as Record<string, unknown>;
    return handle.evidence_ref_id === stored.attestation_row_id
      && handle.type === "github_merge"
      && handle.digest === stored.payload_digest
      && handle.origin_id === stored.provider_event_id
      && handle.source_authority === "verified";
  });
  if (!exactEvidence
      || attestation.type !== "github_merge"
      || attestation.attestation_id !== stored.producer_attestation_id
      || attestation.provider_event_id !== stored.provider_event_id
      || attestation.provider_pull_request_id !== stored.provider_pull_request_id
      || attestation.base_sha !== stored.base_sha
      || attestation.head_sha !== stored.head_sha
      || attestation.merge_sha !== stored.merge_sha
      || attestation.manifest_digest !== stored.manifest_digest
      || attestation.occurred_at !== stored.occurred_at
      || !stored.merge_sha) {
    return unavailableGithubReverification("github_activation_attestation_invalid");
  }

  let probe: MemoryAttestationV1;
  try {
    // A revert probe preserves the exact activating correlation while asking
    // the existing resolver to scan the bounded base-branch revert history.
    probe = parseMemoryContract("MemoryAttestationV1", {
      ...attestation,
      type: "github_revert",
    });
  } catch {
    return unavailableGithubReverification("github_reverification_probe_invalid");
  }

  let state: AuthoritativeGithubState;
  try {
    state = await githubResolver({ attestation: probe, repository: source });
  } catch (error) {
    return unavailableGithubReverification(
      error instanceof MemoryAttestationIngressError
        && error.code === "evidence_unresolvable"
        ? "github_source_unresolvable"
        : "github_provider_unavailable",
    );
  }
  if (!Number.isFinite(Date.parse(state.occurredAt))
      || !/^sha256:[0-9a-f]{64}$/.test(state.finalDiffDigest)) {
    return unavailableGithubReverification("github_provider_result_invalid");
  }

  if (!state.merged || state.reverted === true) {
    return {
      outcome: "withdrawn",
      evidenceDigest: githubReverificationDigest({
        outcome: "withdrawn",
        attestationRowId,
        payloadDigest: stored.payload_digest,
        authoritativeDiffDigest: stored.authoritative_diff_digest,
        state,
      }),
      sourceOccurredAt: state.occurredAt,
      reasonCode: state.reverted === true
        ? "github_activating_merge_reverted"
        : "github_activating_merge_withdrawn",
    };
  }

  const exact = state.repositoryId === source.repository_id
    && state.providerPullRequestId === stored.provider_pull_request_id
    && state.baseSha === stored.base_sha
    && state.headSha === stored.head_sha
    && state.mergeSha === stored.merge_sha
    && state.manifestDigest === stored.manifest_digest
    && state.finalDiffDigest === stored.authoritative_diff_digest;
  if (!exact) {
    return {
      outcome: "contradicted",
      evidenceDigest: githubReverificationDigest({
        outcome: "contradicted",
        attestationRowId,
        payloadDigest: stored.payload_digest,
        authoritativeDiffDigest: stored.authoritative_diff_digest,
        state,
      }),
      sourceOccurredAt: state.occurredAt,
      reasonCode: "github_authoritative_state_changed",
    };
  }
  return {
    outcome: "verified",
    verifiedAt: input.attemptedAt,
    evidenceDigest: githubReverificationDigest({
      outcome: "verified",
      attestationRowId,
      payloadDigest: stored.payload_digest,
      authoritativeDiffDigest: stored.authoritative_diff_digest,
      state,
    }),
    sourceOccurredAt: state.occurredAt,
  };
}

interface GithubCandidateCorrelation {
  candidate_id: string;
  current_status: "pending_merge" | "active";
  provider_pull_request_id: string;
  base_sha: string;
  head_sha: string;
  manifest_digest: string;
  activating_merge_sha: string | null;
  created_at: string;
}

function githubCandidateCorrelations(
  repositoryRowId: string,
  cursor: string | null,
  maxEvents: number,
): GithubCandidateCorrelation[] {
  const afterCandidateId = cursor?.startsWith(GITHUB_CANDIDATE_POLL_CURSOR_PREFIX)
    ? cursor.slice(GITHUB_CANDIDATE_POLL_CURSOR_PREFIX.length)
    : null;
  const cursorClause = afterCandidateId ? "AND candidate.candidate_id > ?" : "";
  return db.prepare(
    `SELECT candidate.candidate_id, candidate.current_status,
            json_extract(receipt.receipt_json, '$.repository.provider_pull_request_id')
              AS provider_pull_request_id,
            json_extract(receipt.receipt_json, '$.repository.base_sha') AS base_sha,
            json_extract(receipt.receipt_json, '$.repository.pr_head_sha') AS head_sha,
            manifest.manifest_digest, activation_attestation.merge_sha AS activating_merge_sha,
            candidate.created_at
     FROM memory_candidates_v1 candidate
     INNER JOIN memory_run_receipts receipt ON receipt.receipt_id = candidate.receipt_id
     INNER JOIN memory_evidence_manifests manifest
       ON manifest.evidence_manifest_row_id = candidate.evidence_manifest_row_id
     LEFT JOIN memory_records active_record
       ON active_record.record_id = candidate.active_record_id
     LEFT JOIN memory_transitions activation_transition
       ON activation_transition.aggregate_type = 'candidate'
      AND activation_transition.aggregate_id = candidate.candidate_id
      AND activation_transition.to_status = 'active'
      AND activation_transition.actor_type = 'system'
     LEFT JOIN memory_attestations activation_attestation
       ON activation_attestation.attestation_row_id = activation_transition.actor_id
      AND activation_attestation.provider = 'github'
      AND activation_attestation.attestation_type = 'github_merge'
     WHERE candidate.repository_row_id = ? AND candidate.plane = 'codebase'
       AND (
         candidate.current_status = 'pending_merge'
         OR (
           candidate.current_status = 'active'
           AND active_record.current_status = 'active'
           AND activation_attestation.attestation_row_id IS NOT NULL
         )
       )
       AND json_type(receipt.receipt_json, '$.repository.provider_pull_request_id') = 'text'
       AND json_type(receipt.receipt_json, '$.repository.base_sha') = 'text'
       AND json_type(receipt.receipt_json, '$.repository.pr_head_sha') = 'text'
       ${cursorClause}
     ORDER BY candidate.candidate_id
     LIMIT ?`,
  ).all(
    repositoryRowId,
    ...(afterCandidateId ? [afterCandidateId] : []),
    maxEvents,
  ) as unknown as GithubCandidateCorrelation[];
}

async function pollGithubMemoryProviderEvents(input: {
  repository: MemoryRepositoryBinding;
  cursor: string | null;
  maxEvents: number;
}): Promise<MemoryGithubProviderEventPage | null> {
  if (githubResolver === resolveGithubMemoryState && !process.env.GITHUB_TOKEN?.trim()) return null;
  const correlations = githubCandidateCorrelations(
    input.repository.repository_row_id,
    input.cursor,
    input.maxEvents,
  );
  const events: MemoryGithubProviderEvent[] = [];
  for (const correlation of correlations) {
    const eventType = correlation.current_status === "active" ? "github_revert" : "github_merge";
    const probeDigest = canonicalJsonSha256({
      candidate_id: correlation.candidate_id,
      manifest_digest: correlation.manifest_digest,
      type: eventType,
    }).slice("sha256:".length);
    const probe = parseMemoryContract("MemoryAttestationV1", {
      schema_version: "pim.memory-attestation.v1",
      attestation_id: `poll-probe-${probeDigest}`,
      provider_event_id: `poll-probe-${probeDigest}`,
      type: eventType,
      repository_id: input.repository.repository_id,
      provider_pull_request_id: correlation.provider_pull_request_id,
      base_sha: correlation.base_sha,
      head_sha: correlation.head_sha,
      ...(correlation.activating_merge_sha
        ? { merge_sha: correlation.activating_merge_sha }
        : {}),
      manifest_digest: correlation.manifest_digest,
      occurred_at: correlation.created_at,
    });
    const state = await githubResolver({ attestation: probe, repository: input.repository });
    if (!state.mergeSha
        || (eventType === "github_merge" && !state.merged)
        || (eventType === "github_revert" && !state.reverted)) {
      continue;
    }
    const sourceCursor = eventType === "github_revert"
      ? state.sourceCursor ?? state.mergeSha
      : state.mergeSha;
    const digest = canonicalJsonSha256({
      candidate_id: correlation.candidate_id,
      merge_sha: state.mergeSha,
      manifest_digest: correlation.manifest_digest,
      source_cursor: sourceCursor,
      type: eventType,
    }).slice("sha256:".length);
    const deliveryId = `github-poll-${digest}`;
    events.push({
      deliveryId,
      sourceCursor,
      attestation: parseMemoryContract("MemoryAttestationV1", {
        schema_version: "pim.memory-attestation.v1",
        attestation_id: `attestation-${digest}`,
        provider_event_id: deliveryId,
        type: eventType,
        repository_id: input.repository.repository_id,
        provider_pull_request_id: correlation.provider_pull_request_id,
        base_sha: correlation.base_sha,
        head_sha: correlation.head_sha,
        merge_sha: state.mergeSha,
        manifest_digest: correlation.manifest_digest,
        occurred_at: state.occurredAt,
      }),
    });
  }
  return {
    events,
    nextCursor: correlations.length === 0
      ? null
      : `${GITHUB_CANDIDATE_POLL_CURSOR_PREFIX}${correlations.at(-1)!.candidate_id}`,
  };
}

let githubProviderEventSource: MemoryGithubProviderEventSource = pollGithubMemoryProviderEvents;

export function setMemoryGithubProviderEventSource(
  source: MemoryGithubProviderEventSource | null,
): void {
  githubProviderEventSource = source ?? pollGithubMemoryProviderEvents;
}

function findScopedInbox(
  deliveryId: string,
  input: SubmitGithubMemoryAttestationInput,
): InboxRow | null {
  const projectId = attestationProjectId(input);
  return (db.prepare(
    `SELECT * FROM memory_inbox
     WHERE provider = 'github' AND provider_delivery_id = ?
       AND org_id = ? AND project_id = ? AND repository_row_id = ?`,
  ).get(
    deliveryId,
    input.auth.orgId,
    projectId,
    input.repository.repository_row_id,
  ) as unknown as InboxRow | undefined) ?? null;
}

function assertNoDeliveryScopeCollision(
  deliveryId: string,
  input: SubmitGithubMemoryAttestationInput,
): void {
  const projectId = attestationProjectId(input);
  const collision = db.prepare(
    `SELECT 1 AS collision FROM memory_inbox
     WHERE provider = 'github' AND provider_delivery_id = ?
       AND NOT (org_id = ? AND project_id = ? AND repository_row_id = ?)`,
  ).get(
    deliveryId,
    input.auth.orgId,
    projectId,
    input.repository.repository_row_id,
  );
  if (collision) {
    throw new MemoryAttestationIngressError(
      "GitHub delivery identity is already bound to another resource scope",
      409,
      "idempotency_conflict",
    );
  }
}

function attestationProjectId(input: SubmitGithubMemoryAttestationInput): string {
  if (!input.auth.projectId) {
    throw new MemoryAttestationIngressError(
      "GitHub attestation ingress requires a project scope",
      403,
      "resource_binding_mismatch",
    );
  }
  return input.auth.projectId;
}

function appendAttemptHistory(row: InboxRow, entry: Record<string, unknown>): string {
  const history = parseJson<unknown[]>(row.attempt_history_json);
  return JSON.stringify([...history, entry].slice(-64));
}

function claimInbox(input: {
  workerId: string;
  now: string;
  inboxEventIds?: string[];
  repositoryRowIds?: string[];
  excludeEventIds?: string[];
  forceUnmatched?: boolean;
}): InboxRow | null {
  return withImmediateTransaction(() => {
    const eventIds = input.inboxEventIds?.length ? [...new Set(input.inboxEventIds)] : null;
    const repositories = input.repositoryRowIds?.length ? [...new Set(input.repositoryRowIds)] : null;
    const excludedEventIds = input.excludeEventIds?.length
      ? [...new Set(input.excludeEventIds)]
      : null;
    const clauses: string[] = [];
    const params: string[] = [input.now, input.now];
    if (eventIds) {
      clauses.push(`inbox_event_id IN (${eventIds.map(() => "?").join(",")})`);
      params.push(...eventIds);
    }
    if (repositories) {
      clauses.push(`repository_row_id IN (${repositories.map(() => "?").join(",")})`);
      params.push(...repositories);
    }
    if (excludedEventIds) {
      clauses.push(`inbox_event_id NOT IN (${excludedEventIds.map(() => "?").join(",")})`);
      params.push(...excludedEventIds);
    }
    const unmatchedTime = input.forceUnmatched ? "1 = 1" : "next_attempt_at <= ?";
    if (!input.forceUnmatched) params.splice(2, 0, input.now);
    const row = db.prepare(
      `SELECT * FROM memory_inbox
       WHERE provider = 'github' AND (
         (status = 'pending' AND next_attempt_at <= ?)
         OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
         OR (status = 'unmatched' AND ${unmatchedTime})
       )
       ${clauses.length ? `AND ${clauses.join(" AND ")}` : ""}
       ORDER BY received_at, inbox_event_id LIMIT 1`,
    ).get(...params) as unknown as InboxRow | undefined;
    if (!row) return null;
    const leaseExpiresAt = new Date(Date.parse(input.now) + 30_000).toISOString();
    const attempt = row.attempt_count + 1;
    const attemptHistory = appendAttemptHistory(
      row,
      { attempt, worker_id: input.workerId, started_at: input.now },
    );
    const updated = db.prepare(
      `UPDATE memory_inbox
       SET status = 'leased', attempt_count = ?, lease_owner = ?, lease_expires_at = ?,
           attempt_history_json = ?, updated_at = ?
       WHERE inbox_event_id = ? AND status = ?`,
    ).run(
      attempt,
      input.workerId,
      leaseExpiresAt,
      attemptHistory,
      input.now,
      row.inbox_event_id,
      row.status,
    );
    return updated.changes === 1
      ? {
          ...row,
          status: "leased",
          attempt_count: attempt,
          attempt_history_json: attemptHistory,
          lease_owner: input.workerId,
          lease_expires_at: leaseExpiresAt,
        }
      : null;
  });
}

function persistVerifiedAttestation(input: {
  row: InboxRow;
  attestation: MemoryAttestationV1;
  state: AuthoritativeGithubState;
  now: string;
}): string {
  const existing = db.prepare(
    `SELECT attestation_row_id FROM memory_attestations
     WHERE org_id = ? AND provider = 'github' AND provider_delivery_id = ?`,
  ).get(input.row.org_id, input.row.provider_delivery_id) as { attestation_row_id: string } | undefined;
  if (existing) return existing.attestation_row_id;
  const attestationRowId = `attestation_${randomUUID()}`;
  db.prepare(
    `INSERT INTO memory_attestations
       (attestation_row_id, org_id, project_id, repository_row_id, provider,
        provider_delivery_id, provider_event_id, producer_attestation_id,
        attestation_type, payload_digest, attestation_json, provider_pull_request_id,
        base_sha, head_sha, merge_sha, manifest_digest, occurred_at, verified_at, created_at,
        authoritative_diff_digest)
     VALUES (?, ?, ?, ?, 'github', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    attestationRowId,
    input.row.org_id,
    input.row.project_id,
    input.row.repository_row_id,
    input.row.provider_delivery_id,
    input.attestation.provider_event_id,
    input.attestation.attestation_id,
    input.attestation.type,
    input.row.payload_digest,
    JSON.stringify(input.attestation),
    input.state.providerPullRequestId,
    input.state.baseSha,
    input.state.headSha,
    input.state.mergeSha,
    input.state.manifestDigest,
    input.state.occurredAt,
    input.now,
    input.now,
    input.state.finalDiffDigest,
  );
  return attestationRowId;
}

function updateProviderCursor(input: {
  row: InboxRow;
  cursor: string;
  now: string;
}): void {
  db.prepare(
    `INSERT INTO memory_provider_cursors
       (cursor_id, org_id, project_id, repository_row_id, provider, stream_name,
        cursor_value, aggregate_version, last_attempted_sync_at, last_successful_sync_at,
        last_error_code, last_error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'github', 'pull_request_events', ?, 1, ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT (org_id, project_id, repository_row_id, provider, stream_name)
     DO UPDATE SET cursor_value = excluded.cursor_value,
                   aggregate_version = memory_provider_cursors.aggregate_version + 1,
                   last_attempted_sync_at = excluded.last_attempted_sync_at,
                   last_successful_sync_at = excluded.last_successful_sync_at,
                   last_error_code = NULL, last_error_message = NULL,
                   updated_at = excluded.updated_at`,
  ).run(
    `cursor_${randomUUID()}`,
    input.row.org_id,
    input.row.project_id,
    input.row.repository_row_id,
    input.cursor,
    input.now,
    input.now,
    input.now,
    input.now,
  );
}

function acceptedResponse(
  inboxEventId: string,
  result: MemoryActivationResult,
): MemoryAttestationResultV1 | null {
  if (result.errorCode === "evidence_mismatch"
      || result.errorCode === "activation_requirement_unsatisfied") {
    return null;
  }
  return parseMemoryContract("MemoryAttestationResultV1", {
    schema_version: "pim.memory-attestation-result.v1",
    accepted: true,
    duplicate: false,
    inbox_event_id: inboxEventId,
    status: result.status,
    candidate_ids: result.candidateIds,
    record_ids: result.recordIds,
  });
}

function storedResponse(row: InboxRow): MemoryAttestationResultV1 | null {
  if (!row.response_json) return null;
  try {
    return parseMemoryContract(
      "MemoryAttestationResultV1",
      parseJson<unknown>(row.response_json),
    );
  } catch {
    return null;
  }
}

function finishInbox(input: {
  row: InboxRow;
  workerId: string;
  now: string;
  result: MemoryActivationResult;
}): void {
  const completed = input.result.status !== "unmatched";
  const nextAttemptAt = new Date(Date.parse(input.now) + 5 * 60_000).toISOString();
  const response = acceptedResponse(input.row.inbox_event_id, input.result);
  db.prepare(
    `UPDATE memory_inbox
     SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
         last_error_code = ?, last_error_message = ?, next_attempt_at = ?,
         attempt_history_json = ?, updated_at = ?, processed_at = ?,
         response_json = COALESCE(response_json, ?)
     WHERE inbox_event_id = ? AND status = 'leased' AND lease_owner = ?`,
  ).run(
    completed ? "completed" : "unmatched",
    input.result.errorCode ?? null,
    input.result.errorCode ? "Provider event did not satisfy a candidate correlation" : null,
    nextAttemptAt,
    appendAttemptHistory(input.row, {
      attempt: input.row.attempt_count,
      completed_at: input.now,
      outcome: completed ? "completed" : "unmatched",
      error_code: input.result.errorCode ?? null,
    }),
    input.now,
    completed ? input.now : null,
    response ? JSON.stringify(response) : null,
    input.row.inbox_event_id,
    input.workerId,
  );
}

function failInbox(input: {
  row: InboxRow;
  workerId: string;
  now: string;
  error: unknown;
}): string {
  const code = input.error instanceof MemoryAttestationIngressError
    ? input.error.code
    : "temporarily_unavailable";
  const dead = input.row.attempt_count >= input.row.max_attempts;
  const nextAttemptAt = new Date(Date.parse(input.now) + Math.min(60_000, 1_000 * (2 ** input.row.attempt_count))).toISOString();
  db.prepare(
    `UPDATE memory_inbox
     SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
         last_error_code = ?, last_error_message = ?, next_attempt_at = ?,
         attempt_history_json = ?, updated_at = ?, dead_lettered_at = ?
     WHERE inbox_event_id = ? AND status = 'leased' AND lease_owner = ?`,
  ).run(
    dead ? "dead_letter" : "pending",
    code,
    "Provider inbox processing failed",
    nextAttemptAt,
    appendAttemptHistory(input.row, {
      attempt: input.row.attempt_count,
      completed_at: input.now,
      outcome: dead ? "dead_letter" : "retry",
      error_code: code,
    }),
    input.now,
    dead ? input.now : null,
    input.row.inbox_event_id,
    input.workerId,
  );
  return code;
}

function repositoryFor(row: InboxRow): MemoryRepositoryBinding {
  const repository = db.prepare(
    "SELECT * FROM memory_repository_registry WHERE repository_row_id = ?",
  ).get(row.repository_row_id) as unknown as MemoryRepositoryBinding | undefined;
  if (!repository) {
    throw new MemoryAttestationIngressError(
      "Provider event repository binding is unavailable",
      422,
      "evidence_unresolvable",
    );
  }
  return repository;
}

function recordActivationOutcome(
  row: InboxRow,
  outcome: MemoryActivationResult["status"] | "error",
  input: {
    candidateId?: string;
    recordId?: string;
    reasonCode?: string;
  } = {},
): void {
  recordMemoryMetric({
    name: "ActivationOutcome",
    value: 1,
    unit: "Count",
    dimensions: {
      outcome,
      attestation_type: row.event_type,
    },
    fields: {
      org_id: row.org_id,
      project_id: row.project_id,
      inbox_event_id: row.inbox_event_id,
      provider_delivery_id: row.provider_delivery_id,
      candidate_id: input.candidateId ?? null,
      record_id: input.recordId ?? null,
      reason_code: input.reasonCode ?? null,
    },
  });
}

async function processInboxRow(row: InboxRow, workerId: string, now: string): Promise<InboxProcessResult> {
  try {
    const attestation = parseJson<MemoryAttestationV1>(row.payload_json);
    const repository = repositoryFor(row);
    assertActivationAllowlist(repository);
    const state = await githubResolver({ attestation, repository });
    if ((attestation.type === "github_merge" && !state.merged)
        || (attestation.type === "github_revert" && !state.reverted)) {
      const result: MemoryActivationResult = {
        status: "unmatched",
        candidateIds: [],
        recordIds: [],
        errorCode: "activation_requirement_unsatisfied",
      };
      finishInbox({ row, workerId, now, result });
      recordActivationOutcome(row, result.status, {
        reasonCode: result.errorCode,
      });
      return { inboxEventId: row.inbox_event_id, result };
    }
    const attestationRowId = persistVerifiedAttestation({ row, attestation, state, now });
    updateProviderCursor({ row, cursor: state.sourceCursor ?? attestation.provider_event_id, now });
    const result = reconcileVerifiedGithubState({
      orgId: row.org_id,
      projectId: row.project_id,
      repositoryRowId: row.repository_row_id,
      attestationRowId,
      attestation,
      state,
      now,
    });
    finishInbox({ row, workerId, now, result });
    recordActivationOutcome(row, result.status, {
      candidateId: result.candidateIds[0],
      recordId: result.recordIds[0],
      reasonCode: result.errorCode,
    });
    return { inboxEventId: row.inbox_event_id, result };
  } catch (error) {
    const errorCode = failInbox({ row, workerId, now, error });
    recordActivationOutcome(row, "error", { reasonCode: errorCode });
    return {
      inboxEventId: row.inbox_event_id,
      result: null,
      errorCode,
    };
  }
}

export async function runMemoryInboxPass(options: {
  workerId?: string;
  maxEvents?: number;
  inboxEventIds?: string[];
  repositoryRowIds?: string[];
  forceUnmatched?: boolean;
  now?: string;
} = {}): Promise<InboxProcessResult[]> {
  const workerId = options.workerId ?? `memory-inbox-${randomUUID()}`;
  const maxEvents = Math.max(0, Math.min(options.maxEvents ?? 32, 128));
  const now = options.now ?? new Date().toISOString();
  const results: InboxProcessResult[] = [];
  const processedEventIds = new Set<string>();
  for (let index = 0; index < maxEvents; index += 1) {
    const row = claimInbox({
      workerId,
      now,
      inboxEventIds: options.inboxEventIds,
      repositoryRowIds: options.repositoryRowIds,
      excludeEventIds: [...processedEventIds],
      forceUnmatched: options.forceUnmatched,
    });
    if (!row) break;
    processedEventIds.add(row.inbox_event_id);
    results.push(await processInboxRow(row, workerId, now));
  }
  return results;
}

function providerPollCursor(repository: MemoryRepositoryBinding): string | null {
  const row = db.prepare(
    `SELECT cursor_value FROM memory_provider_cursors
     WHERE org_id = ? AND project_id = ? AND repository_row_id = ?
       AND provider = 'github' AND stream_name = ?`,
  ).get(
    repository.org_id,
    repository.project_id,
    repository.repository_row_id,
    GITHUB_PROVIDER_POLL_STREAM,
  ) as { cursor_value: string | null } | undefined;
  return row?.cursor_value ?? null;
}

function upsertProviderPollCursor(input: {
  repository: MemoryRepositoryBinding;
  cursor: string | null;
  now: string;
}): void {
  db.prepare(
    `INSERT INTO memory_provider_cursors
       (cursor_id, org_id, project_id, repository_row_id, provider, stream_name,
        cursor_value, aggregate_version, last_attempted_sync_at, last_successful_sync_at,
        last_error_code, last_error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'github', ?, ?, 1, ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT (org_id, project_id, repository_row_id, provider, stream_name)
     DO UPDATE SET cursor_value = excluded.cursor_value,
                   aggregate_version = memory_provider_cursors.aggregate_version + 1,
                   last_attempted_sync_at = excluded.last_attempted_sync_at,
                   last_successful_sync_at = excluded.last_successful_sync_at,
                   last_error_code = NULL, last_error_message = NULL,
                   updated_at = excluded.updated_at`,
  ).run(
    `cursor_${randomUUID()}`,
    input.repository.org_id,
    input.repository.project_id,
    input.repository.repository_row_id,
    GITHUB_PROVIDER_POLL_STREAM,
    input.cursor,
    input.now,
    input.now,
    input.now,
    input.now,
  );
}

function recordProviderPollFailure(input: {
  repository: MemoryRepositoryBinding;
  error: unknown;
  now: string;
}): void {
  const errorCode = input.error instanceof MemoryAttestationIngressError
    ? input.error.code
    : "temporarily_unavailable";
  db.prepare(
    `INSERT INTO memory_provider_cursors
       (cursor_id, org_id, project_id, repository_row_id, provider, stream_name,
        cursor_value, aggregate_version, last_attempted_sync_at, last_successful_sync_at,
        last_error_code, last_error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'github', ?, NULL, 1, ?, NULL, ?,
             'Provider event poll failed', ?, ?)
     ON CONFLICT (org_id, project_id, repository_row_id, provider, stream_name)
     DO UPDATE SET aggregate_version = memory_provider_cursors.aggregate_version + 1,
                   last_attempted_sync_at = excluded.last_attempted_sync_at,
                   last_error_code = excluded.last_error_code,
                   last_error_message = excluded.last_error_message,
                   updated_at = excluded.updated_at`,
  ).run(
    `cursor_${randomUUID()}`,
    input.repository.org_id,
    input.repository.project_id,
    input.repository.repository_row_id,
    GITHUB_PROVIDER_POLL_STREAM,
    input.now,
    errorCode,
    input.now,
    input.now,
  );
}

function recordProviderPollAttempt(input: {
  repository: MemoryRepositoryBinding;
  now: string;
}): void {
  db.prepare(
    `INSERT INTO memory_provider_cursors
       (cursor_id, org_id, project_id, repository_row_id, provider, stream_name,
        cursor_value, aggregate_version, last_attempted_sync_at, last_successful_sync_at,
        last_error_code, last_error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'github', ?, NULL, 1, ?, NULL, NULL, NULL, ?, ?)
     ON CONFLICT (org_id, project_id, repository_row_id, provider, stream_name)
     DO UPDATE SET aggregate_version = memory_provider_cursors.aggregate_version + 1,
                   last_attempted_sync_at = excluded.last_attempted_sync_at,
                   updated_at = excluded.updated_at`,
  ).run(
    `cursor_${randomUUID()}`,
    input.repository.org_id,
    input.repository.project_id,
    input.repository.repository_row_id,
    GITHUB_PROVIDER_POLL_STREAM,
    input.now,
    input.now,
    input.now,
  );
}

function repositoriesForProviderReconciliation(input: {
  repositoryRowIds?: string[];
  maxRepositories: number;
}): MemoryRepositoryBinding[] {
  const allowlist = [...configuredActivationRepositories()];
  if (allowlist.length === 0) return [];
  const ids = input.repositoryRowIds?.length ? [...new Set(input.repositoryRowIds)] : null;
  const idClause = ids ? `AND repository.repository_row_id IN (${ids.map(() => "?").join(",")})` : "";
  const allowlistClause = `AND repository.repository_id IN (${allowlist.map(() => "?").join(",")})`;
  return db.prepare(
    `SELECT DISTINCT repository.*
     FROM memory_repository_registry repository
     INNER JOIN memory_candidates_v1 candidate
       ON candidate.repository_row_id = repository.repository_row_id
     LEFT JOIN memory_provider_cursors poll_cursor
       ON poll_cursor.org_id = repository.org_id
      AND poll_cursor.project_id = repository.project_id
      AND poll_cursor.repository_row_id = repository.repository_row_id
      AND poll_cursor.provider = 'github'
      AND poll_cursor.stream_name = '${GITHUB_PROVIDER_POLL_STREAM}'
     WHERE repository.provider = 'github' AND repository.valid_until IS NULL
       AND candidate.plane = 'codebase'
       AND candidate.current_status IN ('pending_merge','active')
       ${idClause}
       ${allowlistClause}
     ORDER BY CASE WHEN poll_cursor.cursor_id IS NULL THEN 0 ELSE 1 END,
              poll_cursor.last_attempted_sync_at,
              poll_cursor.aggregate_version,
              repository.org_id, repository.project_id, repository.repository_id
     LIMIT ?`,
  ).all(...(ids ?? []), ...allowlist, input.maxRepositories) as unknown as MemoryRepositoryBinding[];
}

function normalizedDiscoveredGithubEvent(
  repository: MemoryRepositoryBinding,
  event: MemoryGithubProviderEvent,
): MemoryGithubProviderEvent {
  if (!event.deliveryId || event.deliveryId.length > 256
      || !event.sourceCursor || event.sourceCursor.length > 512) {
    throw new MemoryAttestationIngressError(
      "Discovered GitHub event identity or cursor is invalid",
      422,
      "evidence_unresolvable",
    );
  }
  const attestation = parseMemoryContract("MemoryAttestationV1", event.attestation);
  if ((attestation.type !== "github_merge" && attestation.type !== "github_revert")
      || attestation.provider_event_id !== event.deliveryId
      || attestation.repository_id !== repository.repository_id) {
    throw new MemoryAttestationIngressError(
      "Discovered GitHub event does not match its canonical repository scope",
      422,
      "evidence_mismatch",
    );
  }
  return { ...event, attestation };
}

function persistDiscoveredGithubEvents(input: {
  repository: MemoryRepositoryBinding;
  page: MemoryGithubProviderEventPage;
  now: string;
}): { inboxEventIds: string[]; duplicateCount: number } {
  if (input.page.events.length > 512
      || (input.page.nextCursor !== null
        && (input.page.nextCursor.length === 0 || input.page.nextCursor.length > 512))) {
    throw new MemoryAttestationIngressError(
      "Discovered GitHub event page exceeds bounded reconciliation limits",
      422,
      "evidence_unresolvable",
    );
  }
  const events = input.page.events.map((event) =>
    normalizedDiscoveredGithubEvent(input.repository, event));
  if (events.length > 0 && input.page.nextCursor === null) {
    throw new MemoryAttestationIngressError(
      "A non-empty GitHub event page requires a durable next cursor",
      422,
      "evidence_unresolvable",
    );
  }
  return withImmediateTransaction(() => {
    const inboxEventIds: string[] = [];
    let duplicateCount = 0;
    for (const event of events) {
      const payloadDigest = canonicalJsonSha256(event.attestation);
      const existing = db.prepare(
        `SELECT inbox_event_id, org_id, project_id, repository_row_id,
                payload_digest, source_cursor
         FROM memory_inbox
         WHERE provider = 'github' AND provider_delivery_id = ?`,
      ).get(event.deliveryId) as {
        inbox_event_id: string;
        org_id: string;
        project_id: string;
        repository_row_id: string;
        payload_digest: string;
        source_cursor: string | null;
      } | undefined;
      if (existing) {
        if (existing.org_id !== input.repository.org_id
            || existing.project_id !== input.repository.project_id
            || existing.repository_row_id !== input.repository.repository_row_id
            || existing.payload_digest !== payloadDigest
            || existing.source_cursor !== event.sourceCursor) {
          throw new MemoryAttestationIngressError(
            "Discovered GitHub event identity was reused with different content or scope",
            409,
            "idempotency_conflict",
          );
        }
        duplicateCount += 1;
        continue;
      }
      const inboxEventId = `inbox_${randomUUID()}`;
      db.prepare(
        `INSERT INTO memory_inbox
           (inbox_event_id, org_id, project_id, repository_row_id, provider,
            provider_delivery_id, event_type, payload_digest, payload_json, source_cursor,
            status, attempt_count, max_attempts, attempt_history_json, next_attempt_at,
            lease_owner, lease_expires_at, last_error_code, last_error_message, occurred_at,
            received_at, updated_at, processed_at, dead_lettered_at)
         VALUES (?, ?, ?, ?, 'github', ?, ?, ?, ?, ?, 'pending', 0, 8, '[]', ?,
                 NULL, NULL, NULL, NULL, ?, ?, ?, NULL, NULL)`,
      ).run(
        inboxEventId,
        input.repository.org_id,
        input.repository.project_id,
        input.repository.repository_row_id,
        event.deliveryId,
        event.attestation.type,
        payloadDigest,
        JSON.stringify(event.attestation),
        event.sourceCursor,
        input.now,
        event.attestation.occurred_at,
        input.now,
        input.now,
      );
      inboxEventIds.push(inboxEventId);
    }
    upsertProviderPollCursor({
      repository: input.repository,
      cursor: input.page.nextCursor,
      now: input.now,
    });
    return { inboxEventIds, duplicateCount };
  });
}

export async function runMemoryProviderReconciliationPass(options: {
  repositoryRowIds?: string[];
  maxRepositories?: number;
  maxEventsPerRepository?: number;
  now?: string;
} = {}): Promise<MemoryProviderReconciliationResult[]> {
  const now = options.now ?? new Date().toISOString();
  const maxRepositories = Math.max(0, Math.min(options.maxRepositories ?? 32, 128));
  const maxEvents = Math.max(1, Math.min(options.maxEventsPerRepository ?? 32, 128));
  const repositories = repositoriesForProviderReconciliation({
    repositoryRowIds: options.repositoryRowIds,
    maxRepositories,
  });
  const results: MemoryProviderReconciliationResult[] = [];
  for (const repository of repositories) {
    assertActivationAllowlist(repository);
    const previousCursor = providerPollCursor(repository);
    let page: MemoryGithubProviderEventPage | null;
    let persisted: { inboxEventIds: string[]; duplicateCount: number };
    try {
      page = await githubProviderEventSource({
        repository,
        cursor: previousCursor,
        maxEvents,
      });
      if (page === null) {
        recordProviderPollAttempt({ repository, now });
        continue;
      }
      persisted = persistDiscoveredGithubEvents({ repository, page, now });
    } catch (error) {
      recordProviderPollFailure({ repository, error, now });
      throw error;
    }
    const processed = persisted.inboxEventIds.length === 0
      ? []
      : await runMemoryInboxPass({
          workerId: `github-poll:${repository.repository_row_id}`,
          maxEvents: persisted.inboxEventIds.length,
          inboxEventIds: persisted.inboxEventIds,
          now,
        });
    results.push({
      repositoryRowId: repository.repository_row_id,
      previousCursor,
      nextCursor: page.nextCursor,
      discoveredCount: persisted.inboxEventIds.length,
      duplicateCount: persisted.duplicateCount,
      processedCount: processed.length,
    });
  }
  return results;
}

export interface MemoryInboxDeadLetter {
  inbox_event_id: string;
  repository_row_id: string;
  provider_delivery_id: string;
  event_type: "github_merge" | "github_revert";
  attempt_count: number;
  max_attempts: number;
  last_error_code: string;
  dead_lettered_at: string;
  last_replayed_at: string | null;
}

export function listMemoryInboxDeadLetters(
  orgId: string,
  projectId: string,
): MemoryInboxDeadLetter[] {
  return db.prepare(
    `SELECT inbox_event_id, repository_row_id, provider_delivery_id, event_type,
            attempt_count, max_attempts, last_error_code, dead_lettered_at,
            last_replayed_at
     FROM memory_inbox
     WHERE org_id = ? AND project_id = ? AND status = 'dead_letter'
     ORDER BY dead_lettered_at DESC, inbox_event_id`,
  ).all(orgId, projectId) as unknown as MemoryInboxDeadLetter[];
}

export function replayMemoryInboxDeadLetter(input: {
  orgId: string;
  projectId: string;
  repositoryRowId: string;
  inboxEventId: string;
  now?: string;
}): boolean {
  const now = input.now ?? new Date().toISOString();
  return withImmediateTransaction(() => {
    const row = db.prepare(
      `SELECT * FROM memory_inbox
       WHERE inbox_event_id = ? AND org_id = ? AND project_id = ?
         AND repository_row_id = ? AND provider = 'github' AND status = 'dead_letter'`,
    ).get(
      input.inboxEventId,
      input.orgId,
      input.projectId,
      input.repositoryRowId,
    ) as unknown as InboxRow | undefined;
    if (!row) return false;
    assertActivationAllowlist(repositoryFor(row));
    const updated = db.prepare(
      `UPDATE memory_inbox
       SET status = 'pending', max_attempts = attempt_count + 8,
           next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL,
           last_error_code = NULL, last_error_message = NULL,
           dead_lettered_at = NULL, last_replayed_at = ?, updated_at = ?,
           attempt_history_json = ?
       WHERE inbox_event_id = ? AND org_id = ? AND project_id = ?
         AND repository_row_id = ? AND status = 'dead_letter'`,
    ).run(
      now,
      now,
      now,
      appendAttemptHistory(row, {
        replayed_at: now,
        outcome: "replayed",
        prior_error_code: row.last_error_code,
      }),
      input.inboxEventId,
      input.orgId,
      input.projectId,
      input.repositoryRowId,
    );
    return updated.changes === 1;
  });
}

function submissionFromResult(
  inboxEventId: string,
  processed: InboxProcessResult | undefined,
): GithubAttestationSubmissionResult {
  if (!processed?.result) {
    throw new MemoryAttestationIngressError(
      "GitHub attestation could not be resolved authoritatively",
      503,
      "temporarily_unavailable",
    );
  }
  if (processed.result.errorCode === "evidence_mismatch") {
    throw new MemoryAttestationIngressError(
      "GitHub attestation does not match candidate evidence",
      422,
      "evidence_mismatch",
    );
  }
  if (processed.result.errorCode === "activation_requirement_unsatisfied") {
    throw new MemoryAttestationIngressError(
      "Authoritative provider state does not satisfy verified merge activation",
      422,
      "activation_requirement_unsatisfied",
    );
  }
  const response = acceptedResponse(inboxEventId, processed.result);
  if (!response) {
    throw new MemoryAttestationIngressError(
      "GitHub attestation could not produce a stable result",
      503,
      "temporarily_unavailable",
    );
  }
  return response;
}

export async function submitGithubMemoryAttestation(
  input: SubmitGithubMemoryAttestationInput,
): Promise<GithubAttestationSubmissionResult> {
  assertActivationAllowlist(input.repository);
  const digest = rawSha256(input.rawBody);
  const existing = findScopedInbox(input.deliveryId, input);
  if (existing) {
    if (existing.payload_digest !== digest) {
      throw new MemoryAttestationIngressError(
        "GitHub delivery identity was reused with different content",
        409,
        "idempotency_conflict",
      );
    }
    const replay = storedResponse(existing);
    if (replay) return replay;
    const processed = await runMemoryInboxPass({
      workerId: `github-submit:${input.deliveryId}`,
      maxEvents: 1,
      inboxEventIds: [existing.inbox_event_id],
      forceUnmatched: true,
    });
    return submissionFromResult(existing.inbox_event_id, processed[0]);
  }
  assertNoDeliveryScopeCollision(input.deliveryId, input);

  const now = new Date().toISOString();
  const inboxEventId = `inbox_${randomUUID()}`;
  withImmediateTransaction(() => {
    const concurrent = findScopedInbox(input.deliveryId, input);
    if (concurrent) {
      if (concurrent.payload_digest !== digest) {
        throw new MemoryAttestationIngressError(
          "GitHub delivery identity was reused with different content",
          409,
          "idempotency_conflict",
        );
      }
      return;
    }
    assertNoDeliveryScopeCollision(input.deliveryId, input);
    db.prepare(
      `INSERT INTO memory_inbox
         (inbox_event_id, org_id, project_id, repository_row_id, provider,
          provider_delivery_id, event_type, payload_digest, payload_json, source_cursor,
          status, attempt_count, max_attempts, attempt_history_json, next_attempt_at,
          lease_owner, lease_expires_at, last_error_code, last_error_message, occurred_at,
          received_at, updated_at, processed_at, dead_lettered_at)
       VALUES (?, ?, ?, ?, 'github', ?, ?, ?, ?, ?, 'pending', 0, 8, '[]', ?,
               NULL, NULL, NULL, NULL, ?, ?, ?, NULL, NULL)`,
    ).run(
      inboxEventId,
      input.auth.orgId,
      attestationProjectId(input),
      input.repository.repository_row_id,
      input.deliveryId,
      input.attestation.type,
      digest,
      JSON.stringify(input.attestation),
      input.attestation.provider_event_id,
      now,
      input.attestation.occurred_at,
      now,
      now,
    );
  });
  const stored = findScopedInbox(input.deliveryId, input)!;
  const replay = storedResponse(stored);
  if (replay) return replay;
  const processed = await runMemoryInboxPass({
    workerId: `github-submit:${input.deliveryId}`,
    maxEvents: 1,
    inboxEventIds: [stored.inbox_event_id],
  });
  return submissionFromResult(stored.inbox_event_id, processed[0]);
}

export async function reconcileUnmatchedGithubAttestations(input: {
  repositoryRowId: string;
  maxEvents?: number;
}): Promise<InboxProcessResult[]> {
  return runMemoryInboxPass({
    workerId: `candidate-reconcile:${input.repositoryRowId}`,
    maxEvents: input.maxEvents ?? 16,
    repositoryRowIds: [input.repositoryRowId],
    forceUnmatched: true,
  });
}
