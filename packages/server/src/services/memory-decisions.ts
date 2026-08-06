import { randomUUID } from "node:crypto";
import {
  canonicalJsonSha256,
  parseMemoryContract,
  type MemoryCandidateDecisionResultV1,
  type MemoryCandidateDecisionV1,
  type HarnessApplicabilityV1,
  type PimErrorV1,
} from "@pim/shared";
import db, { withImmediateTransaction } from "../db/connection.js";
import {
  getMemoryCandidateStatus,
  getStoredMemoryCandidate,
  MemoryCandidateTransitionError,
  rejectMemoryCandidateByReview,
} from "./memory-candidates.js";
import {
  activateReviewedMemoryCandidate,
  MemoryActivationError,
} from "./memory-activation.js";
import {
  activateReviewedHarnessMemoryCandidate,
  MemoryHarnessActivationError,
} from "./memory-harness-activation.js";
import { findActiveHarnessMemoryRecordByClaim } from "./memory-harness-records.js";

type DecisionErrorCode = PimErrorV1["code"];

interface DecisionRow {
  decision_id: string;
  decision_digest: string;
  response_json: string;
}

export class MemoryDecisionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: DecisionErrorCode,
  ) {
    super(message);
    this.name = "MemoryDecisionError";
  }
}

function findDecision(input: {
  orgId: string;
  projectId: string;
  candidateId: string;
  reviewerId: string;
  revision: number;
}): DecisionRow | null {
  return (db.prepare(
    `SELECT decision_id, decision_digest, response_json
     FROM memory_candidate_decisions
     WHERE org_id = ? AND project_id = ? AND candidate_id = ?
       AND reviewer_principal_id = ? AND decision_revision = ?`,
  ).get(
    input.orgId,
    input.projectId,
    input.candidateId,
    input.reviewerId,
    input.revision,
  ) as DecisionRow | undefined) ?? null;
}

function replayResult(row: DecisionRow, digest: string): MemoryCandidateDecisionResultV1 {
  if (row.decision_digest !== digest) {
    throw new MemoryDecisionError(
      "Decision revision was reused with different content",
      409,
      "idempotency_conflict",
    );
  }
  return parseMemoryContract(
    "MemoryCandidateDecisionResultV1",
    JSON.parse(row.response_json) as unknown,
  );
}

export function decideMemoryCandidate(input: {
  orgId: string;
  projectId: string;
  candidateId: string;
  reviewerId: string;
  decision: MemoryCandidateDecisionV1;
  now?: string;
}): MemoryCandidateDecisionResultV1 | null {
  const storedCandidate = getStoredMemoryCandidate(input.orgId, input.projectId, input.candidateId);
  if (!storedCandidate) return null;
  const digest = canonicalJsonSha256(input.decision);
  const identity = {
    orgId: input.orgId,
    projectId: input.projectId,
    candidateId: input.candidateId,
    reviewerId: input.reviewerId,
    revision: input.decision.decision_revision,
  };
  const replay = findDecision(identity);
  if (replay) return replayResult(replay, digest);
  const now = input.now ?? new Date().toISOString();

  try {
    return withImmediateTransaction(() => {
      const concurrent = findDecision(identity);
      if (concurrent) return replayResult(concurrent, digest);
      const current = getStoredMemoryCandidate(input.orgId, input.projectId, input.candidateId);
      if (!current || current.row.current_status !== "pending_review"
          || current.row.activation_requirement !== "authorized_review") {
        throw new MemoryDecisionError(
          "Candidate is not eligible for authorized review",
          409,
          "activation_requirement_unsatisfied",
        );
      }
      const decisionId = `decision_${randomUUID()}`;
      const defaultRecordId = `mem_${input.candidateId.slice("candidate_".length)}`;
      const activeRecordId = current.candidate.plane === "harness"
        ? findActiveHarnessMemoryRecordByClaim({
          orgId: input.orgId,
          projectId: input.projectId,
          kind: current.candidate.kind,
          content: current.candidate.content,
          applicability: current.candidate.applicability as HarnessApplicabilityV1,
          extractorVersion: current.candidate.extraction.extractor_version,
        })?.recordId ?? defaultRecordId
        : defaultRecordId;
      const result = input.decision.decision === "approve"
        ? parseMemoryContract("MemoryCandidateDecisionResultV1", {
          schema_version: "pim.memory-candidate-decision-result.v1",
          decision_id: decisionId,
          candidate_id: input.candidateId,
          decision_revision: input.decision.decision_revision,
          decision: "approve",
          candidate_status: "active",
          active_record: {
            record_id: activeRecordId,
            record_version: 1,
          },
          duplicate: false,
        })
        : parseMemoryContract("MemoryCandidateDecisionResultV1", {
          schema_version: "pim.memory-candidate-decision-result.v1",
          decision_id: decisionId,
          candidate_id: input.candidateId,
          decision_revision: input.decision.decision_revision,
          decision: "reject",
          candidate_status: "rejected",
          duplicate: false,
        });
      // Persist the immutable decision first so the immutable activation origin
      // can reference it. The surrounding transaction rolls this row back if
      // activation or rejection fails.
      db.prepare(
        `INSERT INTO memory_candidate_decisions
           (decision_id, org_id, project_id, candidate_id, reviewer_principal_id,
            decision_revision, decision, reason_code, explanation, decision_digest,
            decision_json, response_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        decisionId,
        input.orgId,
        input.projectId,
        input.candidateId,
        input.reviewerId,
        input.decision.decision_revision,
        input.decision.decision,
        input.decision.reason_code,
        input.decision.explanation ?? null,
        digest,
        JSON.stringify(input.decision),
        JSON.stringify(result),
        now,
      );
      if (input.decision.decision === "approve") {
        const record = current.candidate.plane === "harness"
          ? activateReviewedHarnessMemoryCandidate({
            orgId: input.orgId,
            projectId: input.projectId,
            candidateId: input.candidateId,
            reviewerId: input.reviewerId,
            decisionId,
            decision: input.decision,
            now,
          })
          : activateReviewedMemoryCandidate({
            orgId: input.orgId,
            projectId: input.projectId,
            candidateId: input.candidateId,
            reviewerId: input.reviewerId,
            decisionId,
            decision: input.decision,
            now,
          });
        const recordId = "recordId" in record ? record.recordId : record.record_id;
        const recordVersion = "recordVersion" in record ? record.recordVersion : record.record_version;
        if (recordId !== result.active_record?.record_id
            || recordVersion !== result.active_record.record_version) {
          throw new MemoryDecisionError(
            "Candidate review projection is inconsistent",
            409,
            "transition_invalid",
          );
        }
      } else {
        rejectMemoryCandidateByReview({
          candidateId: input.candidateId,
          expectedVersion: current.row.aggregate_version,
          reviewerId: input.reviewerId,
          decisionId,
          reasonCode: input.decision.reason_code,
          explanation: input.decision.explanation ?? "Authorized reviewer rejected the candidate.",
          now,
        });
        const status = getMemoryCandidateStatus(input.orgId, input.projectId, input.candidateId);
        if (status?.status !== "rejected") {
          throw new MemoryDecisionError("Candidate review projection is inconsistent", 409, "transition_invalid");
        }
      }
      return result;
    });
  } catch (error) {
    if (error instanceof MemoryDecisionError) throw error;
    if (error instanceof MemoryActivationError) {
      throw new MemoryDecisionError(error.message, error.statusCode, error.code);
    }
    if (error instanceof MemoryHarnessActivationError) {
      throw new MemoryDecisionError(error.message, error.statusCode, error.code);
    }
    if (error instanceof MemoryCandidateTransitionError) {
      throw new MemoryDecisionError(error.message, error.statusCode, error.code);
    }
    throw error;
  }
}
