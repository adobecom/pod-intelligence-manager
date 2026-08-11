import {
  canonicalJsonSha256,
  MEMORY_CONTRACT_FIXTURES_V2,
  parseMemoryContractV2,
  type HarnessRunReceiptV2,
  type ResourceBindingV2,
} from "@pim/shared";
import type { MemoryV2HarnessSubtype } from "../../services/memory-v2-canonical-writes.js";

const SUBTYPE_KIND = {
  workflow_strategy: "decision",
  failure_pattern: "anti_pattern",
  verification_sequence: "test_strategy",
  tool_constraint: "constraint",
  escalation_requirement: "constraint",
} as const;

export interface HarnessWriteFixture {
  receipt: HarnessRunReceiptV2;
  producerRunId: string;
  idempotencyKey: string;
  clientCandidateId: string;
  evidenceRefIds: string[];
  configurationDigest: string;
}

export function harnessWriteFixture(input: {
  marker: string;
  /** Stable semantic marker; defaults to marker while receipt identities remain marker-specific. */
  claimMarker?: string;
  producerRunId: string;
  projectId: string;
  resourceBinding: ResourceBindingV2;
  subtype?: MemoryV2HarnessSubtype;
  validationStrategy?:
    | "stable_failure_fingerprint"
    | "runtime_attestation"
    | "authorized_review";
  activationRequirement?: "authorized_review" | "independently_verified_runtime";
  configurationDigests?: "empty" | "exact";
  includeDerivation?: boolean;
  includeEvidence?: boolean;
  includeCandidate?: boolean;
}): HarnessWriteFixture {
  const source = structuredClone(MEMORY_CONTRACT_FIXTURES_V2.HarnessRunReceiptV2);
  const sourceCandidate = source.candidates[0]!;
  const rootSource = source.evidence_handles[0]!;
  const derivedSource = source.evidence_handles[1]!;
  const subtype = input.subtype ?? "failure_pattern";
  const validationStrategy = input.validationStrategy ?? "stable_failure_fingerprint";
  const claimMarker = input.claimMarker ?? input.marker;
  const includeCandidate = input.includeCandidate ?? true;
  const includeEvidence = includeCandidate
    && (input.includeEvidence ?? validationStrategy !== "authorized_review");
  const rootRef = `runtime-root-${input.marker}`;
  const derivedRef = `runtime-summary-${input.marker}`;
  const evidenceRefIds = !includeEvidence
    ? []
    : input.includeDerivation ? [rootRef, derivedRef] : [rootRef];
  const clientCandidateId = `harness-candidate-${input.marker}`;
  const failureFingerprint = validationStrategy === "stable_failure_fingerprint"
    ? `failure:harness:${claimMarker}`
    : null;
  const configurationDigest = canonicalJsonSha256({
    configuration_id: "routing-default-v2",
    fixture: claimMarker,
  });
  const snapshotBody = {
    schema_version: "pim.memory-scope-snapshot.harness.v2" as const,
    plane: "harness" as const,
    resource_binding: input.resourceBinding,
    harness_id: input.resourceBinding.canonical_resource_id,
    harness_version: "7b6e858",
    workflow_version: "code-change.v3",
    adapter_version: `${input.resourceBinding.canonical_resource_id}-pim-adapter.v2`,
    configuration_id: "routing-default-v2",
    configuration_digest: configurationDigest,
  };
  const scopeSnapshotDigest = canonicalJsonSha256(snapshotBody);
  const outcome = {
    status: "completed" as const,
    terminal_stage: "verify",
    reason_code: "recovery_verified",
    verification_status: "passed" as const,
    failure_fingerprint: failureFingerprint,
  };
  const root = {
    ...rootSource,
    evidence_ref_id: rootRef,
    provider_event_id: `runtime-event-root-${input.marker}`,
    immutable_digest: canonicalJsonSha256({ runtime_event: input.marker, kind: "root" }),
    outcome: {
      ...rootSource.outcome,
      status: "completed" as const,
      reason_code: outcome.reason_code,
      verification_status: "passed" as const,
      failure_fingerprint: failureFingerprint,
    },
    occurred_at: "2026-08-09T20:00:00.000Z",
  };
  const evidenceHandles = !includeEvidence
    ? []
    : input.includeDerivation
    ? [root, {
        ...derivedSource,
        evidence_ref_id: derivedRef,
        provider_event_id: `runtime-event-summary-${input.marker}`,
        immutable_digest: canonicalJsonSha256({ runtime_event: input.marker, kind: "summary" }),
        outcome: {
          ...derivedSource.outcome,
          status: "completed" as const,
          reason_code: outcome.reason_code,
          verification_status: "passed" as const,
          failure_fingerprint: failureFingerprint,
        },
        occurred_at: "2026-08-09T20:00:30.000Z",
        derivation_parent_refs: [rootRef],
      }]
    : [root];
  const receipt = parseMemoryContractV2("HarnessRunReceiptV2", {
    schema_version: "pim.run-receipt.v2",
    external_session_id: `harness-session-${input.marker}`,
    producer: {
      ...source.producer,
      harness_id: input.resourceBinding.canonical_resource_id,
      consumer_run_id: input.producerRunId,
    },
    tenant: { project_id: input.projectId },
    plane: "harness",
    resource_selector: { resource_row_id: input.resourceBinding.resource_row_id },
    scope_snapshot: {
      ...snapshotBody,
      scope_snapshot_digest: scopeSnapshotDigest,
    },
    task: {
      task_class: "recovery",
      summary: "Resolve an ambiguous harness tool outcome safely.",
    },
    outcome,
    retrieval_feedback: [],
    evidence_handles: evidenceHandles,
    candidates: includeCandidate ? [{
      ...sourceCandidate,
      client_candidate_id: clientCandidateId,
      resource_row_id: input.resourceBinding.resource_row_id,
      scope_snapshot_digest: scopeSnapshotDigest,
      kind: SUBTYPE_KIND[subtype],
      subkind: subtype,
      content: {
        summary: subtype === "failure_pattern"
          ? "A harness timeout can hide a completed side effect."
          : `Apply the reviewed ${subtype.replaceAll("_", " ")} before retrying.`,
        details: subtype === "failure_pattern"
          ? "Resolve the exact runtime provider event before retrying so an already completed side effect is never repeated blindly."
          : `The native ${subtype} has its own immutable claim and must remain distinct from other constraint subtypes.`,
        rationale: "The origin-bound runtime outcome makes an unverified retry unsafe.",
      },
      applicability: {
        ...sourceCandidate.applicability,
        harness_id: input.resourceBinding.canonical_resource_id,
        harness_version_range: "7b6e858",
        workflow_version_range: "code-change.v3",
        adapter_version_range: "example-harness-a-pim-adapter.v2",
        configuration_ids: ["routing-default-v2"],
        configuration_digests: input.configurationDigests === "empty"
          ? []
          : [configurationDigest],
      },
      validation: {
        strategy: validationStrategy,
        anchor_refs: [],
        failure_fingerprint: failureFingerprint,
      },
      source_run_ids: [input.producerRunId],
      evidence_refs: evidenceRefIds,
      activation_requirement_requested: input.activationRequirement
        ?? (validationStrategy === "authorized_review"
          ? "authorized_review"
          : "independently_verified_runtime"),
    }] : [],
  });
  return {
    receipt,
    producerRunId: input.producerRunId,
    idempotencyKey: `harness-key-${input.marker}`,
    clientCandidateId,
    evidenceRefIds,
    configurationDigest,
  };
}
