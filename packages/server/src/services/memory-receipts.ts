import { randomUUID } from "node:crypto";
import {
  canonicalJsonSha256,
  parseMemoryContract,
  type FiestaCodeEvidenceV2,
  type MemoryCandidateV1,
  type PimErrorV1,
  type RunReceiptResultV1,
  type RunReceiptV1,
} from "@pim/shared";
import db, { withImmediateTransaction } from "../db/connection.js";
import type { MemoryRepositoryBinding } from "./memory-repository-registry.js";
import {
  insertMemoryCandidate,
  MemoryCandidateIdempotencyError,
} from "./memory-candidates.js";

const RECEIPT_SCHEMA_MAJOR = "pim.run-receipt.v1";
const RECEIPT_IDEMPOTENCY_OPERATION = "memory.run-receipt.v1";

type MemoryReceiptErrorCode = PimErrorV1["code"];

export class MemoryReceiptError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: MemoryReceiptErrorCode,
    readonly details?: PimErrorV1["details"],
  ) {
    super(message);
    this.name = "MemoryReceiptError";
  }
}

export interface AcceptMemoryRunReceiptInput {
  orgId: string;
  projectId: string;
  principalId: string;
  producerRunId: string;
  idempotencyKey?: string;
  repository: MemoryRepositoryBinding | null;
  receipt: RunReceiptV1;
  now?: string;
}

export interface AcceptedMemoryRunReceipt {
  result: RunReceiptResultV1;
  created: boolean;
}

interface ReceiptRow {
  receipt_id: string;
  org_id: string;
  project_id: string;
  producer_run_id: string;
  request_digest: string;
  response_json: string;
}

interface EvidenceManifestRow {
  evidence_manifest_row_id: string;
  manifest_digest: string;
}

interface CandidateResultRow {
  client_candidate_id: string;
  candidate_id: string;
  current_status: RunReceiptResultV1["candidate_results"][number]["status"];
  blockers_json: string;
}

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function idempotencyKey(producerRunId: string): string {
  return `${RECEIPT_SCHEMA_MAJOR}:${producerRunId}`;
}

function allowedEvidenceHosts(): Set<string> {
  const configured = (process.env.MEMORY_IMMUTABLE_EVIDENCE_HOSTS ?? "github.com")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return new Set(configured);
}

function isImmutableHttpsUri(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (!allowedEvidenceHosts().has(url.hostname.toLowerCase())) return false;
  if (/(?:^|\/)[0-9a-f]{40,64}(?:\/|\.|$)/i.test(url.pathname)) return true;
  const version = url.searchParams.get("versionId") ?? url.searchParams.get("sha") ?? url.searchParams.get("ref");
  return Boolean(version && /^[0-9a-f]{40,64}$/i.test(version));
}

export function canonicalEvidenceManifestDigest(
  manifest: Omit<FiestaCodeEvidenceV2, "digest"> | FiestaCodeEvidenceV2,
): string {
  return canonicalJsonSha256({
    schema_version: manifest.schema_version,
    manifest_id: manifest.manifest_id,
    refs: manifest.refs,
  });
}

export function validateReceiptEvidenceManifest(manifest: FiestaCodeEvidenceV2 | undefined): void {
  if (!manifest) return;
  if (canonicalEvidenceManifestDigest(manifest) !== manifest.digest) {
    throw new MemoryReceiptError(
      "Evidence manifest digest does not match its canonical contents",
      422,
      "evidence_mismatch",
    );
  }
  const seen = new Set<string>();
  for (const ref of manifest.refs) {
    if (seen.has(ref.id)) {
      throw new MemoryReceiptError(
        "Evidence manifest contains a duplicate reference identity",
        422,
        "evidence_mismatch",
      );
    }
    seen.add(ref.id);
    if (!isImmutableHttpsUri(ref.uri)) {
      throw new MemoryReceiptError(
        "Evidence references must use an allowlisted immutable HTTPS URI",
        422,
        "evidence_unresolvable",
      );
    }
  }
}

function validateReceiptRelationships(receipt: RunReceiptV1): void {
  const feedback = receipt.retrieval_feedback ?? [];
  if (!receipt.repository && (feedback.length > 0 || receipt.candidates.some((candidate) => candidate.plane === "codebase"))) {
    throw new MemoryReceiptError(
      "Repository binding is required for codebase candidates and retrieval feedback",
      400,
      "schema_invalid",
    );
  }
  if (receipt.repository && receipt.candidates.some((candidate) => candidate.plane === "harness")) {
    throw new MemoryReceiptError(
      "Harness candidates must use a repository-free harness receipt",
      400,
      "schema_invalid",
    );
  }
  const manifestIds = new Set(receipt.evidence_manifest?.refs.map((ref) => ref.id) ?? []);
  for (const candidate of receipt.candidates) {
    if (candidate.evidence_refs.length > 0 && !receipt.evidence_manifest) {
      throw new MemoryReceiptError(
        "A candidate that cites evidence requires an evidence manifest",
        422,
        "evidence_unresolvable",
      );
    }
    const missing = candidate.evidence_refs.find((ref) => !manifestIds.has(ref));
    if (missing) {
      throw new MemoryReceiptError(
        "Candidate evidence does not resolve within the receipt manifest",
        422,
        "evidence_unresolvable",
      );
    }
  }
  const feedbackKeys = new Set<string>();
  for (const pack of feedback) {
    for (const item of pack.items) {
      const key = `${pack.retrieval_pack_id}\0${item.record_id}\0${item.record_version}`;
      if (feedbackKeys.has(key)) {
        throw new MemoryReceiptError(
          "Receipt feedback contains a duplicate pack and record version",
          400,
          "schema_invalid",
        );
      }
      feedbackKeys.add(key);
    }
  }
}

function assertFeedbackTargets(
  orgId: string,
  projectId: string,
  producerRunId: string,
  repository: MemoryRepositoryBinding | null,
  receipt: RunReceiptV1,
): void {
  for (const pack of receipt.retrieval_feedback ?? []) {
    const storedPack = db.prepare(
      `SELECT repository_row_id, consumer_run_id, request_base_sha
       FROM memory_retrieval_packs
       WHERE org_id = ? AND project_id = ? AND retrieval_pack_id = ?`,
    ).get(orgId, projectId, pack.retrieval_pack_id) as {
      repository_row_id: string;
      consumer_run_id: string | null;
      request_base_sha: string | null;
    } | undefined;
    if (!storedPack || !repository || storedPack.repository_row_id !== repository.repository_row_id) {
      throw new MemoryReceiptError(
        "Receipt feedback references an unavailable retrieval pack",
        422,
        "evidence_mismatch",
      );
    }
    if (storedPack.consumer_run_id !== producerRunId
        || storedPack.request_base_sha !== receipt.repository?.base_sha) {
      throw new MemoryReceiptError(
        "Receipt feedback must match the pack consumer run and pinned base SHA",
        422,
        "evidence_mismatch",
      );
    }
    for (const item of pack.items) {
      const storedItem = db.prepare(
        `SELECT 1
         FROM memory_retrieval_pack_items
         WHERE retrieval_pack_id = ? AND record_id = ? AND record_version = ?`,
      ).get(pack.retrieval_pack_id, item.record_id, item.record_version);
      if (!storedItem) {
        throw new MemoryReceiptError(
          "Receipt feedback must name an exact record version from its retrieval pack",
          422,
          "evidence_mismatch",
        );
      }
    }
  }
}

function persistEvidenceManifest(input: {
  orgId: string;
  projectId: string;
  receiptId: string;
  manifest: FiestaCodeEvidenceV2 | undefined;
  now: string;
}): { manifestRowId: string | null; evidenceRowsByProducerRef: Map<string, string> } {
  if (!input.manifest) return { manifestRowId: null, evidenceRowsByProducerRef: new Map() };
  const existing = db.prepare(
    `SELECT evidence_manifest_row_id, manifest_digest
     FROM memory_evidence_manifests
     WHERE org_id = ? AND project_id = ? AND producer_manifest_id = ?`,
  ).get(input.orgId, input.projectId, input.manifest.manifest_id) as EvidenceManifestRow | undefined;
  if (existing && existing.manifest_digest !== input.manifest.digest) {
    throw new MemoryReceiptError(
      "Evidence manifest identity was reused with different content",
      409,
      "idempotency_conflict",
    );
  }
  const manifestRowId = existing?.evidence_manifest_row_id ?? `manifest_${randomUUID()}`;
  if (!existing) {
    db.prepare(
      `INSERT INTO memory_evidence_manifests
         (evidence_manifest_row_id, org_id, project_id, receipt_id, producer_manifest_id,
          manifest_digest, manifest_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      manifestRowId,
      input.orgId,
      input.projectId,
      input.receiptId,
      input.manifest.manifest_id,
      input.manifest.digest,
      JSON.stringify(input.manifest),
      input.now,
    );
    const insertRef = db.prepare(
      `INSERT INTO memory_evidence_refs
         (evidence_row_id, evidence_manifest_row_id, producer_ref_id, type, uri, digest,
          origin_id, source_authority, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const ref of input.manifest.refs) {
      insertRef.run(
        `evidence_${randomUUID()}`,
        manifestRowId,
        ref.id,
        ref.type,
        ref.uri,
        ref.digest,
        ref.origin_id,
        ref.source_authority,
        ref.occurred_at,
        input.now,
      );
    }
  }
  const rows = db.prepare(
    `SELECT producer_ref_id, evidence_row_id
     FROM memory_evidence_refs WHERE evidence_manifest_row_id = ?`,
  ).all(manifestRowId) as unknown as Array<{ producer_ref_id: string; evidence_row_id: string }>;
  return {
    manifestRowId,
    evidenceRowsByProducerRef: new Map(rows.map((row) => [row.producer_ref_id, row.evidence_row_id])),
  };
}

function persistReceiptFeedback(input: {
  orgId: string;
  projectId: string;
  receiptId: string;
  producerRunId: string;
  receipt: RunReceiptV1;
  now: string;
}): void {
  const insert = db.prepare(
    `INSERT INTO memory_feedback
       (feedback_id, org_id, project_id, receipt_id, producer_run_id, retrieval_pack_id,
        record_id, record_version, feedback_stage, feedback_revision, feedback_json,
        feedback_digest, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'receipt', 0, ?, ?, ?)`,
  );
  for (const pack of input.receipt.retrieval_feedback ?? []) {
    for (const item of pack.items) {
      insert.run(
        `feedback_${randomUUID()}`,
        input.orgId,
        input.projectId,
        input.receiptId,
        input.producerRunId,
        pack.retrieval_pack_id,
        item.record_id,
        item.record_version,
        JSON.stringify(item),
        canonicalJsonSha256(item),
        input.now,
      );
    }
  }
}

function candidateResults(receiptId: string): RunReceiptResultV1["candidate_results"] {
  const rows = db.prepare(
    `SELECT link.client_candidate_id, candidate.candidate_id, candidate.current_status,
            candidate.blockers_json
     FROM memory_receipt_candidates link
     INNER JOIN memory_candidates_v1 candidate ON candidate.candidate_id = link.candidate_id
     WHERE link.receipt_id = ?
     ORDER BY link.rowid`,
  ).all(receiptId) as unknown as CandidateResultRow[];
  return rows.map((row) => ({
    client_candidate_id: row.client_candidate_id,
    candidate_id: row.candidate_id,
    status: row.current_status,
    blockers: parseJson<string[]>(row.blockers_json),
  }));
}

function buildReceiptResult(row: Pick<ReceiptRow, "receipt_id" | "producer_run_id" | "request_digest">): RunReceiptResultV1 {
  return parseMemoryContract("RunReceiptResultV1", {
    schema_version: "pim.run-receipt-result.v1",
    receipt_id: row.receipt_id,
    producer_run_id: row.producer_run_id,
    request_digest: row.request_digest,
    status: "accepted",
    candidate_results: candidateResults(row.receipt_id),
  });
}

function findReceipt(orgId: string, projectId: string, producerRunId: string): ReceiptRow | null {
  return (db.prepare(
    `SELECT receipt_id, org_id, project_id, producer_run_id, request_digest, response_json
     FROM memory_run_receipts
     WHERE org_id = ? AND project_id = ? AND schema_major = ? AND producer_run_id = ?`,
  ).get(orgId, projectId, RECEIPT_SCHEMA_MAJOR, producerRunId) as ReceiptRow | undefined) ?? null;
}

function replayOrConflict(existing: ReceiptRow, requestDigest: string): AcceptedMemoryRunReceipt {
  if (existing.request_digest !== requestDigest) {
    throw new MemoryReceiptError(
      "Producer run is already finalized with different receipt content",
      409,
      "idempotency_conflict",
    );
  }
  return {
    result: parseMemoryContract("RunReceiptResultV1", parseJson(existing.response_json)),
    created: false,
  };
}

export function acceptMemoryRunReceipt(input: AcceptMemoryRunReceiptInput): AcceptedMemoryRunReceipt {
  validateReceiptRelationships(input.receipt);
  if (input.receipt.candidates.some((candidate) => candidate.plane === "harness")
      && input.repository !== null) {
    throw new MemoryReceiptError(
      "Harness candidates cannot inherit a repository binding",
      400,
      "schema_invalid",
    );
  }
  validateReceiptEvidenceManifest(input.receipt.evidence_manifest);
  const requestDigest = canonicalJsonSha256(input.receipt);
  const existing = findReceipt(input.orgId, input.projectId, input.producerRunId);
  if (existing) return replayOrConflict(existing, requestDigest);
  const now = input.now ?? new Date().toISOString();

  try {
    return withImmediateTransaction(() => {
      const concurrent = findReceipt(input.orgId, input.projectId, input.producerRunId);
      if (concurrent) return replayOrConflict(concurrent, requestDigest);
      assertFeedbackTargets(
        input.orgId,
        input.projectId,
        input.producerRunId,
        input.repository,
        input.receipt,
      );
      const receiptId = `receipt_${randomUUID()}`;
      db.prepare(
        `INSERT INTO memory_run_receipts
           (receipt_id, org_id, project_id, producer_run_id, schema_major, idempotency_key,
            request_digest, receipt_json, response_json, producer_harness_id,
            repository_row_id, repository_id, base_sha, outcome_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?)`,
      ).run(
        receiptId,
        input.orgId,
        input.projectId,
        input.producerRunId,
        RECEIPT_SCHEMA_MAJOR,
        input.idempotencyKey?.trim() || null,
        requestDigest,
        JSON.stringify(input.receipt),
        input.receipt.producer.harness_id,
        input.repository?.repository_row_id ?? null,
        input.receipt.repository?.repository_id ?? null,
        input.receipt.repository?.base_sha ?? null,
        input.receipt.outcome.status,
        now,
      );
      const evidence = persistEvidenceManifest({
        orgId: input.orgId,
        projectId: input.projectId,
        receiptId,
        manifest: input.receipt.evidence_manifest,
        now,
      });
      persistReceiptFeedback({
        orgId: input.orgId,
        projectId: input.projectId,
        receiptId,
        producerRunId: input.producerRunId,
        receipt: input.receipt,
        now,
      });
      for (const candidate of input.receipt.candidates) {
        insertMemoryCandidate({
          orgId: input.orgId,
          projectId: input.projectId,
          receiptId,
          repositoryRowId: input.repository?.repository_row_id ?? null,
          producerHarnessId: input.receipt.producer.harness_id,
          producerRunId: input.producerRunId,
          evidenceManifestRowId: evidence.manifestRowId,
          evidenceRowsByProducerRef: evidence.evidenceRowsByProducerRef,
          candidate,
          now,
        });
      }
      const row = {
        receipt_id: receiptId,
        producer_run_id: input.producerRunId,
        request_digest: requestDigest,
      };
      const result = buildReceiptResult(row);
      const responseJson = JSON.stringify(result);
      db.prepare("UPDATE memory_run_receipts SET response_json = ? WHERE receipt_id = ?")
        .run(responseJson, receiptId);
      const expiresAt = new Date(Date.parse(now) + 365 * 86_400_000).toISOString();
      db.prepare(
        `INSERT INTO memory_idempotency_keys
           (org_id, project_id, operation, idempotency_key, request_digest,
            response_resource_type, response_resource_id, response_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'receipt', ?, ?, ?, ?)`,
      ).run(
        input.orgId,
        input.projectId,
        RECEIPT_IDEMPOTENCY_OPERATION,
        idempotencyKey(input.producerRunId),
        requestDigest,
        receiptId,
        responseJson,
        now,
        expiresAt,
      );
      return { result, created: true };
    });
  } catch (error) {
    if (error instanceof MemoryCandidateIdempotencyError) {
      throw new MemoryReceiptError(error.message, 409, "idempotency_conflict");
    }
    throw error;
  }
}

export function refreshMemoryReceiptResult(receiptId: string): RunReceiptResultV1 | null {
  return withImmediateTransaction(() => {
    const row = db.prepare(
      `SELECT receipt_id, org_id, project_id, producer_run_id, request_digest, response_json
       FROM memory_run_receipts WHERE receipt_id = ?`,
    ).get(receiptId) as ReceiptRow | undefined;
    if (!row) return null;
    const result = buildReceiptResult(row);
    const responseJson = JSON.stringify(result);
    db.prepare("UPDATE memory_run_receipts SET response_json = ? WHERE receipt_id = ?")
      .run(responseJson, receiptId);
    db.prepare(
      `UPDATE memory_idempotency_keys SET response_json = ?
       WHERE org_id = ? AND project_id = ? AND operation = ? AND idempotency_key = ?`,
    ).run(
      responseJson,
      row.org_id,
      row.project_id,
      RECEIPT_IDEMPOTENCY_OPERATION,
      idempotencyKey(row.producer_run_id),
    );
    return result;
  });
}

export function storedMemoryReceipt(receiptId: string): RunReceiptV1 | null {
  const row = db.prepare("SELECT receipt_json FROM memory_run_receipts WHERE receipt_id = ?")
    .get(receiptId) as { receipt_json: string } | undefined;
  return row ? parseMemoryContract("RunReceiptV1", parseJson(row.receipt_json)) : null;
}

export type { MemoryCandidateV1 };
