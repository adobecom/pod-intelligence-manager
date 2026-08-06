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

const POLICY_VERSION = "retrieval-harness-shadow-v1";
const RANKER_VERSION = "lexical-harness-shadow-v1";
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
    prompt_eligible: false,
    match_reasons: includeExplanations ? ranked.matchReasons : [],
  });
}

function tokens(item: MemoryHarnessSearchItemV1): number {
  return Math.max(1, Math.ceil(JSON.stringify(item).length / 4));
}

function replay(input: {
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
  assertExactBinding(input);
  const digest = canonicalJsonSha256(input.request);
  const identity = {
    orgId: input.orgId,
    projectId: input.projectId,
    requestId: input.request.request_id,
    digest,
  };
  const existing = replay(identity);
  if (existing) return existing;

  return withImmediateTransaction(() => {
    const concurrent = replay(identity);
    if (concurrent) return concurrent;
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

    const nowDate = input.now ?? new Date();
    const now = nowDate.toISOString();
    const ranked = listCurrentHarnessMemoryRecords({
      orgId: input.orgId,
      projectId: input.projectId,
      harnessId: input.binding.harnessId,
      now,
    }).map((record) => rankRecord(record, input.request))
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
      shadow_only: true,
      routing_influence: false,
      prompt_eligible: false,
      evaluation_arm: "shadow",
      token_count: tokenCount,
      items: selected.map((item) => item.item),
      omitted_count: Math.max(0, ranked.length - selected.length),
      expires_at: expiresAt,
    });
    const responseJson = JSON.stringify(response);

    db.prepare(
      `INSERT INTO memory_retrieval_packs
         (retrieval_pack_id, org_id, project_id, request_id, request_digest,
          repository_row_id, repository_id, harness_id, plane, query, policy_version,
          ranker_version, authorized_scope_json, token_count, omitted_count, response_json,
          created_at, expires_at, consumer_run_id, request_base_sha, prompt_eligible,
          evaluation_arm, prompt_policy_revision, prompt_policy_snapshot_json,
          prompt_item_count, prompt_token_count)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 'harness', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               NULL, 0, 'shadow', 0, ?, 0, 0)`,
    ).run(
      packId,
      input.orgId,
      input.projectId,
      input.request.request_id,
      digest,
      input.binding.harnessId,
      input.request.task.query,
      POLICY_VERSION,
      RANKER_VERSION,
      JSON.stringify({
        org_id: input.orgId,
        project_id: input.projectId,
        service_principal_id: input.principalId,
        harness_binding_id: input.binding.bindingId,
        harness_id: input.binding.harnessId,
      }),
      tokenCount,
      response.omitted_count,
      responseJson,
      now,
      expiresAt,
      input.request.consumer.consumer_run_id,
      JSON.stringify({ mode: "permanent_shadow", routing_influence: false }),
    );
    const insertItem = db.prepare(
      `INSERT INTO memory_retrieval_pack_items
         (retrieval_pack_id, item_order, record_id, record_version, token_count,
          rank_score, match_reasons_json, prompt_eligible)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    );
    selected.forEach((entry, index) => insertItem.run(
      packId,
      index,
      entry.ranked.record.recordId,
      entry.ranked.record.recordVersion,
      entry.tokenCount,
      entry.ranked.score,
      JSON.stringify(entry.item.match_reasons),
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
      digest,
      packId,
      responseJson,
      now,
      new Date(nowDate.getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
    );
    return response;
  });
}
