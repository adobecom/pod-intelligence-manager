import { randomUUID } from "node:crypto";
import {
  canonicalJsonSha256,
  parseMemoryContract,
  type MemoryHarnessSearchItemV1,
  type MemoryHarnessSearchResultV1,
  type MemoryHarnessSearchV1,
} from "@pim/shared";
import db, { withImmediateTransaction } from "../db/connection.js";
import type { MemoryHarnessPrincipalBinding } from "./memory-harness-bindings.js";
import {
  listCurrentHarnessMemoryRecords,
  type HarnessMemoryRecord,
} from "./memory-harness-records.js";

const POLICY_VERSION = "retrieval-harness-v1";
const RANKER_VERSION = "lexical-harness-v1";
const PACK_TTL_MS = 15 * 60 * 1000;
const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class MemoryHarnessSearchError extends Error {
  constructor(
    message: string,
    readonly statusCode: 403 | 409,
    readonly code: "resource_binding_mismatch" | "idempotency_conflict",
  ) {
    super(message);
    this.name = "MemoryHarnessSearchError";
  }
}

interface RankedHarnessRecord {
  record: HarnessMemoryRecord;
  score: number;
  matchReasons: string[];
}

export interface HarnessMemorySearchDependencies {
  now?: () => Date;
}

export interface HarnessMemorySearchProjectionItem {
  record: HarnessMemoryRecord;
  tokenCount: number;
  rankScore: number;
  matchReasons: string[];
}

export interface HarnessMemorySearchProjectionContext {
  requestDigest: string;
  retrievalPackId: string;
  policyVersion: string;
  rankerVersion: string;
  createdAt: string;
  expiresAt: string;
  response: MemoryHarnessSearchResultV1;
  items: HarnessMemorySearchProjectionItem[];
}

/**
 * Persistence/version seam for harness retrieval. Exact applicability,
 * ranking, explanations, token budgeting, and omission accounting remain in
 * this service and run once before the selected immutable pack is committed.
 */
export interface HarnessMemorySearchProjection<T> {
  requestDigest: string;
  replay(): T | null;
  assertCommitAuthorized?(): void;
  filterAuthorizedRecords?(
    records: readonly HarnessMemoryRecord[],
  ): readonly HarnessMemoryRecord[];
  assertCommitRecords?(records: readonly HarnessMemoryRecord[]): void;
  commit(context: HarnessMemorySearchProjectionContext): T;
}

function words(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[a-z0-9_.:/-]{2,}/g) ?? [])
    .filter((word) => !["the", "and", "for", "with", "from", "that", "this"].includes(word)));
}

function overlap(left: string[] | undefined, right: string[] | undefined): string[] {
  if (!left?.length || !right?.length) return [];
  const rightSet = new Set(right);
  return [...new Set(left.filter((value) => rightSet.has(value)))];
}

function compatible(range: string | undefined, version: string): boolean {
  return !range || range === "*" || range === version;
}

function evidenceWeight(strength: string): number {
  return ({ observed: 1, reviewed: 5, verified_runtime: 8 } as Record<string, number>)[strength] ?? 0;
}

function rankRecord(
  record: HarnessMemoryRecord,
  request: MemoryHarnessSearchV1,
): RankedHarnessRecord | null {
  const applicability = record.applicability;
  if (record.harnessId !== request.consumer.harness_id
      || applicability.harness_id !== request.applicability.harness_id
      || !compatible(applicability.harness_version_range, request.consumer.harness_version)
      || !compatible(applicability.workflow_version_range, request.consumer.workflow_version)
      || !compatible(applicability.adapter_version_range, request.consumer.adapter_version)) {
    return null;
  }

  const configurations = overlap(applicability.configuration_ids, request.applicability.configuration_ids);
  const models = overlap(applicability.model_ids, request.applicability.model_ids);
  const tools = overlap(applicability.tool_ids, request.applicability.tool_ids);
  if ((applicability.configuration_ids?.length && configurations.length === 0)
      || (applicability.model_ids?.length && models.length === 0)
      || (applicability.tool_ids?.length && tools.length === 0)) {
    return null;
  }
  const requestedWords = words(`${request.task.query} ${request.task.task_class}`);
  const recordWords = words([
    record.content.summary,
    record.content.details,
    ...(applicability.configuration_ids ?? []),
    ...(applicability.model_ids ?? []),
    ...(applicability.tool_ids ?? []),
  ].join(" "));
  const lexicalHits = [...requestedWords].filter((word) => recordWords.has(word));
  if (configurations.length === 0 && models.length === 0 && tools.length === 0 && lexicalHits.length === 0) {
    return null;
  }

  const matchReasons: string[] = [];
  let score = evidenceWeight(record.evidenceSummary.strength);
  if (configurations.length > 0) { score += 1000; matchReasons.push("exact_configuration"); }
  if (tools.length > 0) { score += 900; matchReasons.push("exact_tool"); }
  if (models.length > 0) { score += 800; matchReasons.push("exact_model"); }
  if (lexicalHits.length > 0) {
    score += 100 + (lexicalHits.length / Math.max(1, requestedWords.size)) * 200;
    matchReasons.push("task_lexical_match");
  }
  return { record, score, matchReasons };
}

function toSearchItem(ranked: RankedHarnessRecord, includeExplanations: boolean): MemoryHarnessSearchItemV1 {
  const record = ranked.record;
  return parseMemoryContract("MemoryHarnessSearchItemV1", {
    record_id: record.recordId,
    record_version: record.recordVersion,
    plane: "harness",
    kind: record.kind,
    summary: record.content.summary,
    lifecycle: { status: record.status },
    applicability: record.applicability,
    exceptions: record.exceptions,
    compatibility: record.compatibility,
    validation: record.validation,
    evidence_summary: record.evidenceSummary,
    freshness: record.freshness,
    match_reasons: includeExplanations ? ranked.matchReasons : [],
  });
}

function tokens(item: MemoryHarnessSearchItemV1): number {
  return Math.max(1, Math.ceil(JSON.stringify(item).length / 4));
}

function existingReplay(input: {
  orgId: string;
  projectId: string;
  requestId: string;
  digest: string;
}): MemoryHarnessSearchResultV1 | null {
  const row = db.prepare(
    `SELECT request_digest, response_json
     FROM memory_idempotency_keys
     WHERE org_id = ? AND project_id = ?
       AND operation = 'memory_harness_search' AND idempotency_key = ?`,
  ).get(input.orgId, input.projectId, input.requestId) as {
    request_digest: string;
    response_json: string;
  } | undefined;
  if (!row) return null;
  if (row.request_digest !== input.digest) {
    throw new MemoryHarnessSearchError(
      "Harness search request_id was reused with different content",
      409,
      "idempotency_conflict",
    );
  }
  return parseMemoryContract("MemoryHarnessSearchResultV1", JSON.parse(row.response_json));
}

function assertExactBinding(input: {
  orgId: string;
  projectId: string;
  principalId: string;
  binding: MemoryHarnessPrincipalBinding;
  request: MemoryHarnessSearchV1;
}): void {
  if (input.binding.orgId !== input.orgId
      || input.binding.projectId !== input.projectId
      || input.binding.servicePrincipalId !== input.principalId
      || input.binding.harnessId !== input.request.consumer.harness_id
      || input.binding.harnessId !== input.request.applicability.harness_id
      || input.request.tenant.project_id !== input.projectId) {
    throw new MemoryHarnessSearchError(
      "Harness search does not match the authenticated principal binding",
      403,
      "resource_binding_mismatch",
    );
  }
}

export function executeHarnessMemorySearch(input: {
  orgId: string;
  projectId: string;
  principalId: string;
  binding: MemoryHarnessPrincipalBinding;
  request: MemoryHarnessSearchV1;
  now?: Date;
}): MemoryHarnessSearchResultV1 {
  const digest = canonicalJsonSha256(input.request);
  return executeHarnessMemorySearchWithProjection(
    input,
    input.now ? { now: () => input.now! } : {},
    {
      requestDigest: digest,
      replay: () => existingReplay({
        orgId: input.orgId,
        projectId: input.projectId,
        requestId: input.request.request_id,
        digest,
      }),
      assertCommitAuthorized: () => {
        const conflictingPack = db.prepare(
          `SELECT 1 FROM memory_retrieval_packs
           WHERE org_id = ? AND project_id = ? AND request_id = ?`,
        ).get(input.orgId, input.projectId, input.request.request_id);
        if (conflictingPack) {
          throw new MemoryHarnessSearchError(
            "Harness search request_id conflicts with another retrieval pack",
            409,
            "idempotency_conflict",
          );
        }
      },
      commit: (context) => {
        const responseJson = JSON.stringify(context.response);
        db.prepare(
          `INSERT INTO memory_retrieval_packs
             (retrieval_pack_id, org_id, project_id, request_id, request_digest,
              repository_row_id, repository_id, harness_id, plane, query, policy_version,
              ranker_version, authorized_scope_json, token_count, omitted_count, response_json,
              created_at, expires_at, consumer_run_id, request_base_sha)
           VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 'harness', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   NULL)`,
        ).run(
          context.retrievalPackId,
          input.orgId,
          input.projectId,
          input.request.request_id,
          context.requestDigest,
          input.binding.harnessId,
          input.request.task.query,
          context.policyVersion,
          context.rankerVersion,
          JSON.stringify({
            org_id: input.orgId,
            project_id: input.projectId,
            service_principal_id: input.principalId,
            harness_binding_id: input.binding.bindingId,
            harness_id: input.binding.harnessId,
          }),
          context.response.token_count,
          context.response.omitted_count,
          responseJson,
          context.createdAt,
          context.expiresAt,
          input.request.consumer.consumer_run_id,
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
          entry.record.recordId,
          entry.record.recordVersion,
          entry.tokenCount,
          entry.rankScore,
          JSON.stringify(entry.matchReasons),
        ));
        db.prepare(
          `INSERT INTO memory_idempotency_keys
             (org_id, project_id, operation, idempotency_key, request_digest,
              response_resource_type, response_resource_id, response_json, created_at, expires_at)
           VALUES (?, ?, 'memory_harness_search', ?, ?, 'retrieval_pack', ?, ?, ?, ?)`,
        ).run(
          input.orgId,
          input.projectId,
          input.request.request_id,
          context.requestDigest,
          context.retrievalPackId,
          responseJson,
          context.createdAt,
          new Date(Date.parse(context.createdAt) + IDEMPOTENCY_TTL_MS).toISOString(),
        );
        return context.response;
      },
    },
  );
}

export function executeHarnessMemorySearchWithProjection<T>(input: {
  orgId: string;
  projectId: string;
  principalId: string;
  binding: MemoryHarnessPrincipalBinding;
  request: MemoryHarnessSearchV1;
}, dependencies: HarnessMemorySearchDependencies, projection: HarnessMemorySearchProjection<T>): T {
  assertExactBinding(input);
  const existing = projection.replay();
  if (existing) return existing;

  return withImmediateTransaction((): unknown => {
    const concurrent = projection.replay();
    if (concurrent) return concurrent;
    projection.assertCommitAuthorized?.();

    const nowDate = dependencies.now?.() ?? new Date();
    const now = nowDate.toISOString();
    const authorized = listCurrentHarnessMemoryRecords({
      orgId: input.orgId,
      projectId: input.projectId,
      harnessId: input.binding.harnessId,
      now,
    });
    const eligible = projection.filterAuthorizedRecords
      ? projection.filterAuthorizedRecords(authorized)
      : authorized;
    const ranked = eligible.map((record) => rankRecord(record, input.request))
      .filter((record): record is RankedHarnessRecord => record !== null)
      .sort((left, right) => right.score - left.score || left.record.recordId.localeCompare(right.record.recordId));

    const selected: Array<{ ranked: RankedHarnessRecord; item: MemoryHarnessSearchItemV1; tokenCount: number }> = [];
    let tokenCount = 0;
    for (const candidate of ranked) {
      if (selected.length >= input.request.budget.max_items) break;
      const item = toSearchItem(candidate, input.request.options.include_explanations);
      const itemTokens = tokens(item);
      if (tokenCount + itemTokens > input.request.budget.max_tokens) continue;
      selected.push({ ranked: candidate, item, tokenCount: itemTokens });
      tokenCount += itemTokens;
    }

    const packId = `pack_${randomUUID()}`;
    const expiresAt = new Date(nowDate.getTime() + PACK_TTL_MS).toISOString();
    const response = parseMemoryContract("MemoryHarnessSearchResultV1", {
      schema_version: "pim.memory-harness-search-result.v1",
      request_id: input.request.request_id,
      retrieval_pack_id: packId,
      policy_version: POLICY_VERSION,
      tenant: { project_id: input.projectId },
      plane: "harness",
      harness_id: input.binding.harnessId,
      token_count: tokenCount,
      items: selected.map((item) => item.item),
      omitted_count: Math.max(0, ranked.length - selected.length),
      expires_at: expiresAt,
    });
    projection.assertCommitRecords?.(selected.map((entry) => entry.ranked.record));
    return projection.commit({
      requestDigest: projection.requestDigest,
      retrievalPackId: packId,
      policyVersion: POLICY_VERSION,
      rankerVersion: RANKER_VERSION,
      createdAt: now,
      expiresAt,
      response,
      items: selected.map((entry) => ({
        record: entry.ranked.record,
        tokenCount: entry.tokenCount,
        rankScore: entry.ranked.score,
        matchReasons: [...entry.item.match_reasons],
      })),
    });
  }) as T;
}
