import {
  EMPTY_PROJECT_ANATOMY,
  canonicalJsonSha256,
  parseMemoryContract,
  parseMemoryContractV2,
  type CodeEvidenceManifestV2,
  type EnhancedPodLearning,
  type EvidenceRefV2,
  type MemoryCandidateV1,
  type RunReceiptResultV1,
  type RunReceiptV1,
} from "@pim/shared";
import db from "../db/connection.js";
import { getMemoryAuthorityState } from "./memory-authority.js";
import {
  acceptMemoryRunReceipt,
  MemoryReceiptError,
  type AcceptedMemoryRunReceipt,
} from "./memory-receipts.js";

export type CanonicalLegacyProducerKind =
  | "pod_archival"
  | "agent_run_rollup"
  | "agent_session_rollup"
  | "ad_hoc";

export interface CanonicalLegacyLearningSource {
  kind: CanonicalLegacyProducerKind;
  sourceId: string;
  sourceLabel: string;
  projectId?: string | null;
  occurredAt: string;
  taskSummary?: string;
  evidence?: unknown;
}

export interface CanonicalLegacySelectionCounters {
  total: number;
  selected: number;
  dropped_low_confidence: number;
  dropped_unmappable: number;
  dropped_over_cap: number;
}

export interface CanonicalLegacyMappedCandidate {
  candidate: MemoryCandidateV1;
  evidenceManifest: CodeEvidenceManifestV2;
  contentDigest: string;
}

export interface CanonicalLegacyMapping {
  producerSourceHash: string;
  candidates: CanonicalLegacyMappedCandidate[];
  counters: CanonicalLegacySelectionCounters;
}

export interface CanonicalLegacyCandidateSubmission {
  candidate: MemoryCandidateV1;
  candidateId: string;
  status: RunReceiptResultV1["candidate_results"][number]["status"];
  blockers: string[];
  receiptId: string;
  receiptCreated: boolean;
  candidateCreated: boolean;
}

export interface CanonicalLegacyIntakeResult {
  projectId: string;
  usedSystemProject: boolean;
  candidatesSubmitted: number;
  candidatesCreated: number;
  counters: CanonicalLegacySelectionCounters;
  submissions: CanonicalLegacyCandidateSubmission[];
}

export type CanonicalLegacyIntakeErrorCode =
  | "canonical_authority_required"
  | "invalid_source"
  | "project_unavailable"
  | "system_project_conflict";

export class CanonicalLegacyIntakeError extends Error {
  readonly statusCode = 409;

  constructor(
    readonly code: CanonicalLegacyIntakeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CanonicalLegacyIntakeError";
  }
}

export class CanonicalLegacyIntakeConflictError extends Error {
  readonly statusCode = 409;
  readonly code = "canonical_legacy_intake_content_conflict";

  constructor(readonly producerRunId: string) {
    super("Canonical legacy intake source was retried with different immutable content");
    this.name = "CanonicalLegacyIntakeConflictError";
  }
}

const INTERNAL_PRODUCER_ID = "pim-internal";
const DEFAULT_MIN_CONFIDENCE = 0.6;
const DEFAULT_MAX_CANDIDATES = 25;
const SYSTEM_PROJECT_NAME = "[System] Organization Memory";
const SYSTEM_PROJECT_DESCRIPTION =
  "Reserved per-organization project for auditable internal canonical memory intake.";

function digestHex(value: unknown): string {
  return canonicalJsonSha256(value).slice("sha256:".length);
}

function jsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function normalizedIdentityValue(value: unknown): unknown {
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
  if (Array.isArray(value)) {
    return value
      .map(normalizedIdentityValue)
      .sort((left, right) => canonicalJsonSha256(left).localeCompare(canonicalJsonSha256(right)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizedIdentityValue(item)]),
    );
  }
  return value ?? null;
}

function boundedSourceId(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new CanonicalLegacyIntakeError("invalid_source", "Canonical intake source id is required");
  }
  return normalized.slice(0, 512);
}

function producerSourceHash(input: {
  orgId: string;
  source: Pick<CanonicalLegacyLearningSource, "kind" | "sourceId">;
}): string {
  return digestHex({
    organization_id: input.orgId,
    producer_kind: input.source.kind,
    source_id: boundedSourceId(input.source.sourceId),
  }).slice(0, 32);
}

function occurredAt(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new CanonicalLegacyIntakeError(
      "invalid_source",
      "Canonical intake source requires a valid immutable occurrence time",
    );
  }
  return new Date(parsed).toISOString();
}

export function canonicalLegacySystemProjectId(orgId: string): string {
  return `project_pim_org_memory_${digestHex({ org_id: orgId }).slice(0, 24)}`;
}

export function resolveCanonicalLegacyProject(input: {
  orgId: string;
  projectId?: string | null;
  now?: string;
}): { projectId: string; usedSystemProject: boolean } {
  const requested = input.projectId?.trim();
  if (requested) {
    const project = db.prepare(
      "SELECT project_id FROM projects WHERE org_id = ? AND project_id = ?",
    ).get(input.orgId, requested);
    if (!project) {
      throw new CanonicalLegacyIntakeError(
        "project_unavailable",
        "Canonical intake project is unavailable in the selected organization",
      );
    }
    return { projectId: requested, usedSystemProject: false };
  }

  const projectId = canonicalLegacySystemProjectId(input.orgId);
  const existing = db.prepare(
    "SELECT project_id, org_id, name, description FROM projects WHERE project_id = ?",
  ).get(projectId) as {
    project_id: string;
    org_id: string;
    name: string;
    description: string | null;
  } | undefined;
  if (existing) {
    if (existing.org_id !== input.orgId
        || existing.name !== SYSTEM_PROJECT_NAME
        || existing.description !== SYSTEM_PROJECT_DESCRIPTION) {
      throw new CanonicalLegacyIntakeError(
        "system_project_conflict",
        "Reserved canonical intake project identity is already in use",
      );
    }
    return { projectId, usedSystemProject: true };
  }

  const org = db.prepare(
    "SELECT created_by_user_id FROM orgs WHERE org_id = ?",
  ).get(input.orgId) as { created_by_user_id: string } | undefined;
  if (!org) {
    throw new CanonicalLegacyIntakeError(
      "project_unavailable",
      "Canonical intake organization is unavailable",
    );
  }
  const now = occurredAt(input.now ?? new Date().toISOString());
  db.prepare(
    `INSERT INTO projects
       (project_id, name, description, created_at, anatomy_json, resources_json,
        org_id, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO NOTHING`,
  ).run(
    projectId,
    SYSTEM_PROJECT_NAME,
    SYSTEM_PROJECT_DESCRIPTION,
    now,
    JSON.stringify(EMPTY_PROJECT_ANATOMY),
    JSON.stringify({}),
    input.orgId,
    org.created_by_user_id,
  );
  const created = db.prepare(
    "SELECT org_id, name, description FROM projects WHERE project_id = ?",
  ).get(projectId) as { org_id: string; name: string; description: string | null } | undefined;
  if (!created
      || created.org_id !== input.orgId
      || created.name !== SYSTEM_PROJECT_NAME
      || created.description !== SYSTEM_PROJECT_DESCRIPTION) {
    throw new CanonicalLegacyIntakeError(
      "system_project_conflict",
      "Reserved canonical intake project could not be created idempotently",
    );
  }
  return { projectId, usedSystemProject: true };
}

function mappedKind(type: EnhancedPodLearning["type"]): MemoryCandidateV1["kind"] | null {
  if (type === "decision" || type === "resolved_conflict") return "decision";
  if (type === "pattern" || type === "scope_insight") return "constraint";
  if (type === "anti_pattern") return "anti_pattern";
  return null;
}

function evidenceType(type: EnhancedPodLearning["type"]): EvidenceRefV2["type"] {
  if (type === "decision" || type === "resolved_conflict") return "policy_decision";
  if (type === "anti_pattern") return "incident";
  return "review";
}

function audience(learning: EnhancedPodLearning): string[] {
  const values = [...(learning.scopes ?? []), ...learning.domains]
    .map((value) => value.trim().slice(0, 160))
    .filter(Boolean);
  return [...new Set(values.length > 0 ? values : ["organization"])].slice(0, 32);
}

function evidenceManifest(input: {
  manifestId: string;
  refId: string;
  refType: EvidenceRefV2["type"];
  sourceKind: CanonicalLegacyProducerKind;
  sourceHash: string;
  contentDigest: string;
  occurredAt: string;
  sourceAuthority: EvidenceRefV2["source_authority"];
}): CodeEvidenceManifestV2 {
  const ref: EvidenceRefV2 = {
    id: input.refId,
    type: input.refType,
    uri: `pim://memory-source/${input.sourceKind}/${input.sourceHash}/${input.contentDigest}`,
    digest: `sha256:${input.contentDigest}`,
    origin_id: `pim:${input.sourceKind}:${input.sourceHash}:${input.contentDigest}`,
    occurred_at: input.occurredAt,
    source_authority: input.sourceAuthority,
  };
  const withoutDigest = {
    schema_version: "pim.memory-code-evidence.v2" as const,
    manifest_id: input.manifestId,
    refs: [ref],
  };
  return parseMemoryContractV2("CodeEvidenceManifestV2", {
    ...withoutDigest,
    digest: canonicalJsonSha256(withoutDigest),
  });
}

export function mapCanonicalLegacyLearnings(input: {
  orgId: string;
  projectId: string;
  usedSystemProject: boolean;
  source: CanonicalLegacyLearningSource;
  learnings: readonly EnhancedPodLearning[];
  minConfidence?: number;
  maxCandidates?: number;
}): CanonicalLegacyMapping {
  const sourceId = boundedSourceId(input.source.sourceId);
  const sourceTime = occurredAt(input.source.occurredAt);
  const sourceHash = producerSourceHash({ orgId: input.orgId, source: input.source });
  const minConfidence = input.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const maxCandidates = input.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const counters: CanonicalLegacySelectionCounters = {
    total: input.learnings.length,
    selected: 0,
    dropped_low_confidence: 0,
    dropped_unmappable: 0,
    dropped_over_cap: 0,
  };
  const eligible: Array<{
    learning: EnhancedPodLearning;
    kind: MemoryCandidateV1["kind"];
    payload: unknown;
    digest: string;
    identityDigest: string;
  }> = [];
  for (const learning of input.learnings) {
    const kind = mappedKind(learning.type);
    if (!kind) {
      counters.dropped_unmappable += 1;
      continue;
    }
    if (!Number.isFinite(learning.confidence_score)
        || learning.confidence_score < minConfidence) {
      counters.dropped_low_confidence += 1;
      continue;
    }
    const payload = jsonValue({
      schema_version: "pim.canonical-legacy-learning-source.v1",
      organization_id: input.orgId,
      project_id: input.projectId,
      producer_kind: input.source.kind,
      source_id: sourceId,
      source_label: input.source.sourceLabel,
      occurred_at: sourceTime,
      source_evidence: input.source.evidence,
      learning,
    });
    const identityDigest = digestHex(normalizedIdentityValue({
      organization_id: input.orgId,
      project_id: input.projectId,
      producer_kind: input.source.kind,
      source_id: sourceId,
      occurred_at: sourceTime,
      learning,
    }));
    eligible.push({
      learning,
      kind,
      payload,
      digest: digestHex(payload),
      identityDigest,
    });
  }
  eligible.sort((left, right) => (
    right.learning.confidence_score - left.learning.confidence_score
    || left.identityDigest.localeCompare(right.identityDigest)
    || left.digest.localeCompare(right.digest)
  ));
  if (eligible.length > maxCandidates) {
    counters.dropped_over_cap = eligible.length - maxCandidates;
    eligible.length = maxCandidates;
  }
  counters.selected = eligible.length;

  const candidates = eligible.map(({ learning, kind, payload, digest, identityDigest }, index) => {
    const refId = `pim-${input.source.kind}-${digest.slice(0, 24)}`;
    const candidate = parseMemoryContract("MemoryCandidateV1", {
      schema_version: "pim.memory-candidate.v1",
      client_candidate_id: `legacy-${input.source.kind}-${sourceHash.slice(0, 12)}-${String(index).padStart(3, "0")}-${identityDigest.slice(0, 16)}`,
      plane: "org",
      kind,
      content: {
        summary: learning.summary,
        details: learning.details,
        rationale: "Preserve this organizational learning for explicit policy-owner validation and review.",
      },
      applicability: {
        audience: audience(learning),
        policy_owner: (input.source.sourceLabel.trim() || input.source.kind).slice(0, 160),
        effective_from: sourceTime,
        ...(!input.usedSystemProject ? { project_ids: [input.projectId] } : {}),
      },
      validation: { strategy: "policy_owner_review" },
      exceptions: [],
      source_run_ids: [
        `legacy-intake:${input.source.kind}:${sourceHash}:candidate:${String(index).padStart(3, "0")}`,
      ],
      evidence_refs: [refId],
      extraction: {
        method: input.source.kind === "ad_hoc"
          ? "authorized_review"
          : "model_then_deterministic_validation",
        extractor_version: "pim-canonical-legacy-intake.v1",
        confidence: learning.confidence_score,
      },
      activation_requirement_requested: "manual_policy_owner",
      extensions: {
        legacy_producer_kind: input.source.kind,
        legacy_source_id: sourceId,
        source_learning_type: learning.type,
        source_retrieval_text: learning.retrieval_text ?? null,
        source_entity_refs_json: JSON.stringify(learning.entity_refs ?? []),
        source_scopes_json: JSON.stringify(learning.scopes ?? []),
        source_topics_json: JSON.stringify(learning.topics ?? []),
        source_domains_json: JSON.stringify(learning.domains),
        source_confidence_label: learning.confidence,
        source_confidence_score: learning.confidence_score,
        source_audience: learning.audience ?? null,
        source_provenance_json: JSON.stringify(learning.provenance ?? []),
        source_ingestion_provenance_json: JSON.stringify(learning.ingestion_provenance ?? null),
        source_payload_digest: `sha256:${digest}`,
      },
    }) as MemoryCandidateV1;
    const manifest = evidenceManifest({
      manifestId: `legacy-manifest-${sourceHash.slice(0, 20)}-${digest.slice(0, 20)}`,
      refId,
      refType: evidenceType(learning.type),
      sourceKind: input.source.kind,
      sourceHash,
      contentDigest: digest,
      occurredAt: sourceTime,
      sourceAuthority: input.source.kind === "ad_hoc" ? "authorized_review" : "observed",
    });
    void payload;
    return { candidate, evidenceManifest: manifest, contentDigest: digest };
  });
  return { producerSourceHash: sourceHash, candidates, counters };
}

function receipt(input: {
  source: CanonicalLegacyLearningSource;
  projectId: string;
  producerRunId: string;
  manifest: CodeEvidenceManifestV2;
  candidates: MemoryCandidateV1[];
}): RunReceiptV1 {
  return parseMemoryContract("RunReceiptV1", {
    schema_version: "pim.run-receipt.v1",
    external_session_id: `pim-internal:${input.source.kind}:${input.producerRunId}`,
    producer: {
      harness_id: INTERNAL_PRODUCER_ID,
      harness_version: "canonical-legacy-intake.v1",
      workflow_version: input.source.kind,
      adapter_version: "pim-in-process.v1",
    },
    tenant: { project_id: input.projectId },
    task: {
      task_class: input.source.kind,
      summary: (input.source.taskSummary?.trim()
        || `Submit ${input.source.kind.replaceAll("_", " ")} learning candidates for validation`).slice(0, 1000),
    },
    outcome: {
      status: "completed",
      terminal_stage: "canonical_intake",
      reason_code: "legacy_producer_submitted",
      verification_status: "not_run",
      publication_status: "none",
      gate_attestation_ids: [],
      failure_fingerprint: null,
    },
    retrieval_feedback: [],
    evidence_manifest: input.manifest,
    candidates: input.candidates,
  }) as RunReceiptV1;
}

// Keep the receipt-core dependency at this single call site so the authorized
// context signature can change without touching any legacy producer.
function acceptCanonicalLegacyReceipt(input: {
  orgId: string;
  projectId: string;
  source: CanonicalLegacyLearningSource;
  producerRunId: string;
  receipt: RunReceiptV1;
  now: string;
}): AcceptedMemoryRunReceipt {
  try {
    return acceptMemoryRunReceipt({
      orgId: input.orgId,
      projectId: input.projectId,
      principalId: `pim-internal:${input.source.kind}`,
      producerRunId: input.producerRunId,
      idempotencyKey: `canonical-legacy-intake:${input.producerRunId}`,
      repository: null,
      receipt: input.receipt,
      now: input.now,
    });
  } catch (error) {
    if (error instanceof MemoryReceiptError && error.code === "idempotency_conflict") {
      throw new CanonicalLegacyIntakeConflictError(input.producerRunId);
    }
    throw error;
  }
}

function priorAdHocOccurrence(input: {
  orgId: string;
  projectId: string;
  source: CanonicalLegacyLearningSource;
}): string | null {
  if (input.source.kind !== "ad_hoc") return null;
  const sourceHash = producerSourceHash({ orgId: input.orgId, source: input.source });
  const row = db.prepare(
    `SELECT receipt_json
     FROM memory_run_receipts
     WHERE org_id = ? AND project_id = ? AND schema_major = ?
       AND producer_harness_id = ? AND producer_run_id GLOB ?
     ORDER BY created_at ASC, receipt_id ASC
     LIMIT 1`,
  ).get(
    input.orgId,
    input.projectId,
    "pim.run-receipt.v1",
    INTERNAL_PRODUCER_ID,
    `legacy-intake:ad_hoc:${sourceHash}:candidate:*`,
  ) as { receipt_json: string } | undefined;
  if (!row) return null;
  try {
    const stored = JSON.parse(row.receipt_json) as {
      candidates?: Array<{ applicability?: { effective_from?: unknown } }>;
    };
    const storedOccurrence = stored.candidates?.[0]?.applicability?.effective_from;
    return typeof storedOccurrence === "string" ? occurredAt(storedOccurrence) : null;
  } catch {
    return null;
  }
}

export function submitCanonicalLegacyLearnings(input: {
  orgId: string;
  source: CanonicalLegacyLearningSource;
  learnings: readonly EnhancedPodLearning[];
  minConfidence?: number;
  maxCandidates?: number;
  now?: string;
}): CanonicalLegacyIntakeResult {
  const authority = getMemoryAuthorityState();
  if (!authority.legacyWritesFrozen || authority.authority !== "canonical") {
    throw new CanonicalLegacyIntakeError(
      "canonical_authority_required",
      "Canonical legacy intake is available only after legacy memory writes are frozen",
    );
  }
  const now = occurredAt(input.now ?? new Date().toISOString());
  const requestedProjectId = input.source.projectId?.trim();
  let project = requestedProjectId
    ? resolveCanonicalLegacyProject({
        orgId: input.orgId,
        projectId: requestedProjectId,
        now,
      })
    : {
        projectId: canonicalLegacySystemProjectId(input.orgId),
        usedSystemProject: true,
      };
  const replayOccurrence = priorAdHocOccurrence({
    orgId: input.orgId,
    projectId: project.projectId,
    source: input.source,
  });
  const effectiveSource = replayOccurrence
    ? { ...input.source, occurredAt: replayOccurrence }
    : input.source;
  const mapping = mapCanonicalLegacyLearnings({
    orgId: input.orgId,
    projectId: project.projectId,
    usedSystemProject: project.usedSystemProject,
    source: effectiveSource,
    learnings: input.learnings,
    minConfidence: input.minConfidence,
    maxCandidates: input.maxCandidates,
  });
  if (mapping.candidates.length === 0) {
    return {
      projectId: project.projectId,
      usedSystemProject: project.usedSystemProject,
      candidatesSubmitted: 0,
      candidatesCreated: 0,
      counters: mapping.counters,
      submissions: [],
    };
  }
  if (!requestedProjectId) {
    project = resolveCanonicalLegacyProject({ orgId: input.orgId, now });
  }
  const submissions = mapping.candidates.map((mapped) => {
    const producerRunId = mapped.candidate.source_run_ids[0]!;
    const accepted = acceptCanonicalLegacyReceipt({
      orgId: input.orgId,
      projectId: project.projectId,
      source: effectiveSource,
      producerRunId,
      receipt: receipt({
        source: effectiveSource,
        projectId: project.projectId,
        producerRunId,
        manifest: mapped.evidenceManifest,
        candidates: [mapped.candidate],
      }),
      now,
    });
    const candidateResult = accepted.result.candidate_results[0]!;
    const owner = db.prepare(
      "SELECT receipt_id FROM memory_candidates_v1 WHERE candidate_id = ?",
    ).get(candidateResult.candidate_id) as { receipt_id: string };
    return {
      candidate: mapped.candidate,
      candidateId: candidateResult.candidate_id,
      status: candidateResult.status,
      blockers: candidateResult.blockers,
      receiptId: accepted.result.receipt_id,
      receiptCreated: accepted.created,
      candidateCreated: accepted.created && owner.receipt_id === accepted.result.receipt_id,
    };
  });
  return {
    projectId: project.projectId,
    usedSystemProject: project.usedSystemProject,
    candidatesSubmitted: submissions.length,
    candidatesCreated: submissions.filter((item) => item.candidateCreated).length,
    counters: mapping.counters,
    submissions,
  };
}
