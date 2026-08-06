import {
  canonicalJsonSha256,
  parseMemoryContract,
  type MemoryEvaluationArmV1,
  type MemoryPromptPolicyUpdateV1,
  type MemoryPromptPolicyV1,
} from "@pim/shared";
import db, { withImmediateTransaction } from "../db/connection.js";
import { resolveMemoryRepository } from "./memory-repository-registry.js";
import type { ThinV1MemoryKind } from "./memory-structural-validator.js";

const DEFAULT_MAX_PROMPT_ITEMS = 3;
const DEFAULT_MAX_PROMPT_TOKENS = 800;

interface PromptPolicyRow {
  org_id: string;
  project_id: string;
  policy_revision: number;
  enabled: number;
  kill_switch: number;
  automatic_activation_enabled: number;
  canary_percentage: number;
  allowed_repository_ids_json: string;
  allowed_kinds_json: string;
  max_prompt_items: number;
  max_prompt_tokens: number;
  updated_at: string;
}

export class MemoryPromptPolicyError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: "idempotency_conflict" | "resource_binding_mismatch" | "resource_not_found" | "activation_requirement_unsatisfied",
  ) {
    super(message);
    this.name = "MemoryPromptPolicyError";
  }
}

export function memoryPromptExposureGloballyEnabled(): boolean {
  return process.env.PIM_MEMORY_PROMPT_EXPOSURE_ENABLED?.trim() === "1";
}

function defaultPolicy(projectId: string): MemoryPromptPolicyV1 {
  const globalEnabled = memoryPromptExposureGloballyEnabled();
  return parseMemoryContract("MemoryPromptPolicyV1", {
    schema_version: "pim.memory-prompt-policy.v1",
    project_id: projectId,
    policy_revision: 0,
    enabled: false,
    kill_switch: true,
    automatic_activation_enabled: false,
    canary_percentage: 0,
    allowed_repository_ids: [],
    allowed_kinds: [],
    max_prompt_items: DEFAULT_MAX_PROMPT_ITEMS,
    max_prompt_tokens: DEFAULT_MAX_PROMPT_TOKENS,
    global_enabled: globalEnabled,
    effective_enabled: false,
    updated_at: null,
  });
}

function rowToPolicy(row: PromptPolicyRow): MemoryPromptPolicyV1 {
  const globalEnabled = memoryPromptExposureGloballyEnabled();
  const preCanaryApproved = latestReleaseGateAllows(row.org_id, row.project_id, "pre_canary");
  return parseMemoryContract("MemoryPromptPolicyV1", {
    schema_version: "pim.memory-prompt-policy.v1",
    project_id: row.project_id,
    policy_revision: row.policy_revision,
    enabled: row.enabled === 1,
    kill_switch: row.kill_switch === 1,
    automatic_activation_enabled: row.automatic_activation_enabled === 1,
    canary_percentage: row.canary_percentage,
    allowed_repository_ids: JSON.parse(row.allowed_repository_ids_json) as unknown,
    allowed_kinds: JSON.parse(row.allowed_kinds_json) as unknown,
    max_prompt_items: row.max_prompt_items,
    max_prompt_tokens: row.max_prompt_tokens,
    global_enabled: globalEnabled,
    effective_enabled: globalEnabled
      && row.enabled === 1
      && row.kill_switch === 0
      && preCanaryApproved,
    updated_at: row.updated_at,
  });
}

function findPolicyRow(orgId: string, projectId: string): PromptPolicyRow | null {
  return (db.prepare(
    "SELECT * FROM memory_prompt_policies WHERE org_id = ? AND project_id = ?",
  ).get(orgId, projectId) as unknown as PromptPolicyRow | undefined) ?? null;
}

function latestReleaseGateAllows(
  orgId: string,
  projectId: string,
  stage: "pre_canary" | "expansion",
): boolean {
  const decision = db.prepare(
    `SELECT status, decision
     FROM memory_release_gate_decisions
     WHERE org_id = ? AND project_id = ? AND stage = ?
     ORDER BY created_at DESC, rowid DESC
     LIMIT 1`,
  ).get(orgId, projectId, stage) as { status: string; decision: string } | undefined;
  return decision?.status === "pass" && decision.decision === "continue";
}

export function automaticVerifiedMergePromptEligibilityEnabled(
  orgId: string,
  projectId: string,
): boolean {
  const row = findPolicyRow(orgId, projectId);
  return row?.automatic_activation_enabled === 1
    && latestReleaseGateAllows(orgId, projectId, "expansion");
}

function projectExists(orgId: string, projectId: string): boolean {
  return Boolean(db.prepare(
    "SELECT project_id FROM projects WHERE org_id = ? AND project_id = ?",
  ).get(orgId, projectId));
}

export function getMemoryPromptPolicy(orgId: string, projectId: string): MemoryPromptPolicyV1 {
  if (!projectExists(orgId, projectId)) {
    throw new MemoryPromptPolicyError("Memory prompt policy project is unavailable", 404, "resource_not_found");
  }
  const row = findPolicyRow(orgId, projectId);
  if (!row) return defaultPolicy(projectId);
  try {
    return rowToPolicy(row);
  } catch {
    // A corrupt policy must disable prompt exposure without breaking shadow search.
    return defaultPolicy(projectId);
  }
}

function assertRepositoryAllowlist(
  orgId: string,
  projectId: string,
  repositoryIds: string[],
): void {
  for (const repositoryId of repositoryIds) {
    const resolved = resolveMemoryRepository(orgId, projectId, repositoryId);
    if (!resolved || resolved.repository_id !== repositoryId) {
      throw new MemoryPromptPolicyError(
        "Prompt policy repositories must be exact canonical project bindings",
        403,
        "resource_binding_mismatch",
      );
    }
  }
}

export function updateMemoryPromptPolicy(input: {
  orgId: string;
  projectId: string;
  principalId: string;
  update: MemoryPromptPolicyUpdateV1;
  now?: string;
}): MemoryPromptPolicyV1 {
  if (!projectExists(input.orgId, input.projectId)) {
    throw new MemoryPromptPolicyError("Memory prompt policy project is unavailable", 404, "resource_not_found");
  }
  assertRepositoryAllowlist(
    input.orgId,
    input.projectId,
    input.update.allowed_repository_ids,
  );
  const now = input.now ?? new Date().toISOString();

  return withImmediateTransaction(() => {
    if (input.update.automatic_activation_enabled
        && !latestReleaseGateAllows(input.orgId, input.projectId, "expansion")) {
      throw new MemoryPromptPolicyError(
        "Automatic verified-merge prompt eligibility requires a passing expansion gate decision",
        409,
        "activation_requirement_unsatisfied",
      );
    }
    const existing = findPolicyRow(input.orgId, input.projectId);
    const currentRevision = existing?.policy_revision ?? 0;
    if (currentRevision !== input.update.expected_revision) {
      throw new MemoryPromptPolicyError(
        "Prompt policy revision changed concurrently",
        409,
        "idempotency_conflict",
      );
    }
    const nextRevision = currentRevision + 1;
    if (existing) {
      const result = db.prepare(
        `UPDATE memory_prompt_policies
         SET policy_revision = ?, enabled = ?, kill_switch = ?, automatic_activation_enabled = ?,
             canary_percentage = ?,
             allowed_repository_ids_json = ?, allowed_kinds_json = ?,
             max_prompt_items = ?, max_prompt_tokens = ?,
             updated_by_principal_id = ?, updated_at = ?
         WHERE org_id = ? AND project_id = ? AND policy_revision = ?`,
      ).run(
        nextRevision,
        input.update.enabled ? 1 : 0,
        input.update.kill_switch ? 1 : 0,
        input.update.automatic_activation_enabled ? 1 : 0,
        input.update.canary_percentage,
        JSON.stringify(input.update.allowed_repository_ids),
        JSON.stringify(input.update.allowed_kinds),
        input.update.max_prompt_items,
        input.update.max_prompt_tokens,
        input.principalId,
        now,
        input.orgId,
        input.projectId,
        currentRevision,
      );
      if (result.changes !== 1) {
        throw new MemoryPromptPolicyError(
          "Prompt policy revision changed concurrently",
          409,
          "idempotency_conflict",
        );
      }
    } else {
      db.prepare(
        `INSERT INTO memory_prompt_policies
           (org_id, project_id, policy_revision, enabled, kill_switch,
            automatic_activation_enabled,
            canary_percentage, allowed_repository_ids_json, allowed_kinds_json,
            max_prompt_items, max_prompt_tokens, updated_by_principal_id,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.orgId,
        input.projectId,
        nextRevision,
        input.update.enabled ? 1 : 0,
        input.update.kill_switch ? 1 : 0,
        input.update.automatic_activation_enabled ? 1 : 0,
        input.update.canary_percentage,
        JSON.stringify(input.update.allowed_repository_ids),
        JSON.stringify(input.update.allowed_kinds),
        input.update.max_prompt_items,
        input.update.max_prompt_tokens,
        input.principalId,
        now,
        now,
      );
    }
    return rowToPolicy(findPolicyRow(input.orgId, input.projectId)!);
  });
}

export function memoryPromptBucket(
  projectId: string,
  policyRevision: number,
  consumerRunId: string,
): number {
  const digest = canonicalJsonSha256({
    project_id: projectId,
    policy_revision: policyRevision,
    consumer_run_id: consumerRunId,
  });
  return Number.parseInt(digest.slice("sha256:".length, "sha256:".length + 8), 16) % 100;
}

export function assignMemoryPromptArm(input: {
  policy: MemoryPromptPolicyV1;
  repositoryId: string;
  consumerRunId: string;
}): MemoryEvaluationArmV1 {
  if (!input.policy.effective_enabled
      || !input.policy.allowed_repository_ids.includes(input.repositoryId)
      || input.policy.allowed_kinds.length === 0) {
    return "shadow";
  }
  return memoryPromptBucket(
    input.policy.project_id,
    input.policy.policy_revision,
    input.consumerRunId,
  )
    < input.policy.canary_percentage
    ? "memory_on"
    : "memory_off";
}

export function promptPolicyAllowsRecord(input: {
  policy: MemoryPromptPolicyV1;
  arm: MemoryEvaluationArmV1;
  repositoryId: string;
  kind: ThinV1MemoryKind;
}): boolean {
  return input.arm === "memory_on"
    && input.policy.effective_enabled
    && input.policy.allowed_repository_ids.includes(input.repositoryId)
    && input.policy.allowed_kinds.includes(input.kind);
}
