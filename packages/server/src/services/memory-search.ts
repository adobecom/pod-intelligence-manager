import { randomUUID } from "node:crypto";
import {
  canonicalJsonSha256,
  parseMemoryContract,
  type CodebaseApplicabilityV1,
  type MemorySearchItemV1,
  type MemorySearchResultV1,
  type MemorySearchV1,
} from "@pim/shared";
import db, { withImmediateTransaction } from "../db/connection.js";
import { cosineSimilarity, generateEmbedding } from "./embeddings.js";
import {
  listAuthorizedCurrentMemoryRecords,
  type SearchableMemoryRecord,
} from "./memory-records.js";
import type { MemoryRepositoryBinding } from "./memory-repository-registry.js";

const SEARCH_POLICY_VERSION = "retrieval-codebase-v1";
const SEARCH_RANKER_VERSION = "hybrid-authorized-v1";
const PACK_TTL_MS = 15 * 60 * 1000;
const IDEMPOTENCY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class MemorySearchIdempotencyError extends Error {
  readonly statusCode = 409;
  readonly code = "idempotency_conflict";

  constructor() {
    super("Search request_id was already used with different content");
    this.name = "MemorySearchIdempotencyError";
  }
}

interface RankedRecord {
  source: SearchableMemoryRecord;
  score: number;
  matchReasons: string[];
}

export interface MemorySearchDependencies {
  now?: () => Date;
  generateQueryEmbedding?: (text: string) => Promise<number[] | null>;
}

export interface MemorySearchProjectionItem {
  record: SearchableMemoryRecord;
  tokenCount: number;
  rankScore: number;
  matchReasons: string[];
}

export interface MemorySearchProjectionContext {
  requestDigest: string;
  retrievalPackId: string;
  policyVersion: string;
  rankerVersion: string;
  createdAt: string;
  expiresAt: string;
  response: MemorySearchResultV1;
  items: MemorySearchProjectionItem[];
}

/**
 * Persistence seam for transport/version-specific immutable packs. Ranking,
 * hard filters, and token budgeting remain owned by this service and execute
 * exactly once before this callback runs in the same immediate transaction.
 */
export interface MemorySearchProjection<T> {
  requestDigest: string;
  replay(): T | null;
  filterAuthorizedRecords?(
    records: readonly SearchableMemoryRecord[],
  ): SearchableMemoryRecord[];
  assertAuthorizedRecords?(records: readonly SearchableMemoryRecord[]): void;
  assertCommitAuthorized?(): void;
  assertCommitRecords?(records: readonly SearchableMemoryRecord[]): void;
  commit(context: MemorySearchProjectionContext): T;
}

function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9_./:-]{2,}/g) ?? [])
    .filter((word) => !["the", "and", "for", "with", "from", "that", "this"].includes(word)));
}

function overlap<T>(left: readonly T[] | undefined, right: readonly T[] | undefined): T[] {
  if (!left?.length || !right?.length) return [];
  const rightSet = new Set(right);
  return [...new Set(left.filter((value) => rightSet.has(value)))];
}

function compatible(range: string | undefined, value: string): boolean {
  return !range || range === "*" || range === value;
}

function evidenceWeight(strength: string): number {
  return ({
    observed: 1,
    reviewed: 3,
    verified_merge: 5,
    verified_merge_and_test: 8,
    verified_runtime: 8,
  } as Record<string, number>)[strength] ?? 0;
}

function parseEmbedding(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "number" && Number.isFinite(item))
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function scoreRecord(
  source: SearchableMemoryRecord,
  request: MemorySearchV1,
  queryEmbedding: number[] | null,
): RankedRecord | null {
  const applicability = source.detail.applicability;
  const compatibility = source.detail.compatibility;
  if (!compatible(compatibility.harness_version_range, request.consumer.harness_version)
      || !compatible(compatibility.workflow_version_range, request.consumer.workflow_version)
      || !compatible(compatibility.adapter_version_range, request.consumer.adapter_version)) {
    return null;
  }
  const requested = request.applicability as CodebaseApplicabilityV1;
  const exactPaths = overlap(applicability.paths, requested.paths);
  const exactSymbols = overlap(applicability.symbols, requested.symbols);
  const exactComponents = overlap(applicability.components, requested.components);
  const exactTaskClasses = (applicability.task_classes ?? []).includes(request.task.task_class)
    ? [request.task.task_class]
    : [];
  const exactBase = Boolean(requested.base_sha && applicability.base_sha === requested.base_sha);
  const queryWords = words(request.task.query);
  const recordWords = words([
    source.detail.content.summary,
    source.detail.content.details,
    ...(applicability.paths ?? []),
    ...(applicability.symbols ?? []),
    ...(applicability.components ?? []),
  ].join(" "));
  const lexicalHits = [...queryWords].filter((word) => recordWords.has(word));
  const queryLower = request.task.query.toLowerCase();
  const queryIdentifierHits = [
    ...(applicability.paths ?? []),
    ...(applicability.symbols ?? []),
  ].filter((identifier) => queryLower.includes(identifier.toLowerCase()));
  const recordEmbedding = parseEmbedding(source.version.embedding_json);
  const semantic = queryEmbedding && recordEmbedding
    ? Math.max(0, cosineSimilarity(queryEmbedding, recordEmbedding))
    : 0;

  const matchReasons: string[] = [];
  let score = 0;
  if (exactBase) { score += 1500; matchReasons.push("exact_base_sha"); }
  if (exactSymbols.length > 0) { score += 1200 + (exactSymbols.length - 1) * 100; matchReasons.push("exact_symbol"); }
  if (exactPaths.length > 0) { score += 1000 + (exactPaths.length - 1) * 80; matchReasons.push("exact_path"); }
  if (queryIdentifierHits.length > 0) { score += 900 + (queryIdentifierHits.length - 1) * 60; matchReasons.push("exact_query_identifier"); }
  if (exactComponents.length > 0) { score += 250; matchReasons.push("component_match"); }
  if (exactTaskClasses.length > 0) { score += 200; matchReasons.push("task_class_match"); }
  if (lexicalHits.length > 0) {
    const coverage = lexicalHits.length / Math.max(1, queryWords.size);
    score += 25 + coverage * 125;
    matchReasons.push("task_lexical_match");
  }
  if (semantic >= 0.55) {
    score += semantic * 100;
    matchReasons.push("task_semantic_match");
  }
  if (matchReasons.length === 0) return null;
  score += evidenceWeight(source.detail.evidence_summary.strength);
  const confirmedMs = Date.parse(source.detail.freshness.last_confirmed_at);
  if (Number.isFinite(confirmedMs)) {
    const ageDays = Math.max(0, (Date.now() - confirmedMs) / 86_400_000);
    score += Math.max(0, 5 - Math.min(5, ageDays / 90));
  }
  return { source, score, matchReasons };
}

function normalizedSummary(value: string): Set<string> {
  return words(value.replace(/[^a-zA-Z0-9_]+/g, " "));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function diversify(records: RankedRecord[]): RankedRecord[] {
  const selected: RankedRecord[] = [];
  for (const candidate of records) {
    const candidateWords = normalizedSummary(candidate.source.detail.content.summary);
    const duplicate = selected.some((existing) =>
      existing.source.detail.kind === candidate.source.detail.kind
      && jaccard(normalizedSummary(existing.source.detail.content.summary), candidateWords) >= 0.9);
    if (!duplicate) selected.push(candidate);
  }
  return selected;
}

function toSearchItem(ranked: RankedRecord, includeExplanations: boolean): MemorySearchItemV1 {
  const detail = ranked.source.detail;
  return {
    record_id: detail.record_id,
    record_version: detail.record_version,
    plane: "codebase",
    kind: detail.kind,
    summary: detail.content.summary,
    lifecycle: detail.lifecycle,
    applicability: detail.applicability,
    exceptions: detail.exceptions,
    compatibility: detail.compatibility,
    validation: detail.validation,
    evidence_summary: detail.evidence_summary,
    freshness: detail.freshness,
    detail_href: `/api/v1/memory/records/${encodeURIComponent(detail.record_id)}?version=${detail.record_version}`,
    match_reasons: includeExplanations ? ranked.matchReasons : [],
  };
}

function estimateTokens(item: MemorySearchItemV1): number {
  return Math.max(1, Math.ceil(JSON.stringify(item).length / 4));
}

function existingReplay(
  orgId: string,
  projectId: string,
  requestId: string,
  requestDigest: string,
): MemorySearchResultV1 | null {
  const row = db.prepare(
    `SELECT request_digest, response_json
     FROM memory_idempotency_keys
     WHERE org_id = ? AND project_id = ? AND operation = 'memory_search' AND idempotency_key = ?`,
  ).get(orgId, projectId, requestId) as { request_digest: string; response_json: string } | undefined;
  if (!row) return null;
  if (row.request_digest !== requestDigest) throw new MemorySearchIdempotencyError();
  return parseMemoryContract("MemorySearchResultV1", JSON.parse(row.response_json));
}

export async function executeMemorySearchWithProjection<T>(input: {
  orgId: string;
  principalId: string;
  repository: MemoryRepositoryBinding;
  request: MemorySearchV1;
}, dependencies: MemorySearchDependencies, projection: MemorySearchProjection<T>): Promise<T> {
  const requestDigest = projection.requestDigest;
  const replay = projection.replay();
  if (replay) return replay;

  const nowDate = dependencies.now?.() ?? new Date();
  const now = nowDate.toISOString();
  const authorizedSource = listAuthorizedCurrentMemoryRecords({
    orgId: input.orgId,
    projectId: input.request.tenant.project_id,
    repositoryRowId: input.repository.repository_row_id,
    now,
  });
  const authorized = projection.filterAuthorizedRecords?.(authorizedSource) ?? authorizedSource;
  projection.assertAuthorizedRecords?.(authorized);
  const embed = dependencies.generateQueryEmbedding ?? generateEmbedding;
  const needsEmbedding = authorized.some((item) => item.version.embedding_json);
  const queryEmbedding = needsEmbedding ? await embed(input.request.task.query) : null;
  // Embedding generation is the only await between the initial hard filter and
  // pack commit. Re-read the authorized population afterwards so a concurrent
  // revocation can never be packed from a stale pre-await snapshot.
  const currentAuthorizedSource = needsEmbedding
    ? listAuthorizedCurrentMemoryRecords({
        orgId: input.orgId,
        projectId: input.request.tenant.project_id,
        repositoryRowId: input.repository.repository_row_id,
        now: (dependencies.now?.() ?? new Date()).toISOString(),
      })
    : authorized;
  const currentAuthorized = needsEmbedding
    ? projection.filterAuthorizedRecords?.(currentAuthorizedSource) ?? currentAuthorizedSource
    : currentAuthorizedSource;
  projection.assertAuthorizedRecords?.(currentAuthorized);
  const scored = currentAuthorized
    .map((record) => scoreRecord(record, input.request, queryEmbedding))
    .filter((record): record is RankedRecord => record !== null)
    .sort((left, right) => right.score - left.score || left.source.record.record_id.localeCompare(right.source.record.record_id));
  const ranked = diversify(scored);

  const selected: Array<{ ranked: RankedRecord; item: MemorySearchItemV1; tokens: number }> = [];
  let tokenCount = 0;
  for (const record of ranked) {
    if (selected.length >= input.request.budget.max_items) break;
    const item = toSearchItem(record, input.request.options.include_explanations);
    const tokens = estimateTokens(item);
    if (tokenCount + tokens > input.request.budget.max_tokens) continue;
    selected.push({ ranked: record, item, tokens });
    tokenCount += tokens;
  }

  const retrievalPackId = `pack_${randomUUID()}`;
  const expiresAt = new Date(nowDate.getTime() + PACK_TTL_MS).toISOString();

  return withImmediateTransaction((): unknown => {
    projection.assertCommitAuthorized?.();
    const concurrentReplay = projection.replay();
    if (concurrentReplay) return concurrentReplay;
    projection.assertCommitRecords?.(selected.map((entry) => entry.ranked.source));

    const response = parseMemoryContract("MemorySearchResultV1", {
      schema_version: "pim.memory-search-result.v1",
      request_id: input.request.request_id,
      retrieval_pack_id: retrievalPackId,
      policy_version: SEARCH_POLICY_VERSION,
      tenant: { project_id: input.request.tenant.project_id },
      plane: "codebase",
      repository_id: input.repository.repository_id,
      token_count: tokenCount,
      items: selected.map((entry) => entry.item),
      omitted_count: Math.max(0, scored.length - selected.length),
      expires_at: expiresAt,
    });
    return projection.commit({
      requestDigest,
      retrievalPackId,
      policyVersion: SEARCH_POLICY_VERSION,
      rankerVersion: SEARCH_RANKER_VERSION,
      createdAt: now,
      expiresAt,
      response,
      items: selected.map((entry) => ({
        record: entry.ranked.source,
        tokenCount: entry.tokens,
        rankScore: entry.ranked.score,
        matchReasons: [...entry.ranked.matchReasons],
      })),
    });
  }) as T;
}

export async function executeMemorySearch(input: {
  orgId: string;
  principalId: string;
  repository: MemoryRepositoryBinding;
  request: MemorySearchV1;
}, dependencies: MemorySearchDependencies = {}): Promise<MemorySearchResultV1> {
  const requestDigest = canonicalJsonSha256(input.request);
  return executeMemorySearchWithProjection(input, dependencies, {
    requestDigest,
    replay: () => existingReplay(
      input.orgId,
      input.request.tenant.project_id,
      input.request.request_id,
      requestDigest,
    ),
    commit: (context) => {
      const responseJson = JSON.stringify(context.response);
      db.prepare(
        `INSERT INTO memory_retrieval_packs
           (retrieval_pack_id, org_id, project_id, request_id, request_digest,
            repository_row_id, repository_id, plane, query, policy_version, ranker_version,
            authorized_scope_json, token_count, omitted_count, response_json, created_at,
            expires_at, consumer_run_id, request_base_sha)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'codebase', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        context.retrievalPackId,
        input.orgId,
        input.request.tenant.project_id,
        input.request.request_id,
        context.requestDigest,
        input.repository.repository_row_id,
        input.repository.repository_id,
        input.request.task.query,
        context.policyVersion,
        context.rankerVersion,
        JSON.stringify({
          org_id: input.orgId,
          project_id: input.request.tenant.project_id,
          repository_id: input.repository.repository_id,
          service_principal_id: input.principalId,
        }),
        context.response.token_count,
        context.response.omitted_count,
        responseJson,
        context.createdAt,
        context.expiresAt,
        input.request.consumer.consumer_run_id,
        (input.request.applicability as CodebaseApplicabilityV1).base_sha ?? null,
      );
      const insertItem = db.prepare(
        `INSERT INTO memory_retrieval_pack_items
           (retrieval_pack_id, item_order, record_id, record_version, token_count,
            rank_score, match_reasons_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      context.items.forEach((entry, index) => insertItem.run(
        context.retrievalPackId,
        index,
        entry.record.detail.record_id,
        entry.record.detail.record_version,
        entry.tokenCount,
        entry.rankScore,
        JSON.stringify(entry.matchReasons),
      ));
      db.prepare(
        `INSERT INTO memory_idempotency_keys
           (org_id, project_id, operation, idempotency_key, request_digest,
            response_resource_type, response_resource_id, response_json, created_at, expires_at)
         VALUES (?, ?, 'memory_search', ?, ?, 'retrieval_pack', ?, ?, ?, ?)`,
      ).run(
        input.orgId,
        input.request.tenant.project_id,
        input.request.request_id,
        context.requestDigest,
        context.retrievalPackId,
        responseJson,
        context.createdAt,
        new Date(Date.parse(context.createdAt) + IDEMPOTENCY_RETENTION_MS).toISOString(),
      );
      return context.response;
    },
  });
}

export function getStoredRetrievalPack(retrievalPackId: string): MemorySearchResultV1 | null {
  const row = db.prepare(
    "SELECT response_json FROM memory_retrieval_packs WHERE retrieval_pack_id = ?",
  ).get(retrievalPackId) as { response_json: string } | undefined;
  return row ? parseMemoryContract("MemorySearchResultV1", JSON.parse(row.response_json)) : null;
}
