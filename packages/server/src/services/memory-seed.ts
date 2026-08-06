import { createHash } from "node:crypto";
import type { MemoryRecordV1 } from "@pim/shared";
import { getMemoryRecord, importActiveMemoryRecord } from "./memory-records.js";
import { registerMemoryRepository } from "./memory-repository-registry.js";

function stableSuffix(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

export function seedMemoryReadFixture(input: {
  orgId: string;
  projectId: string;
  repositoryId: string;
  displaySlug: string;
  providerRepositoryId: string;
  now?: string;
}): { record: MemoryRecordV1; repositoryId: string } {
  const now = input.now ?? new Date().toISOString();
  const repository = registerMemoryRepository({
    orgId: input.orgId,
    projectId: input.projectId,
    providerRepositoryId: input.providerRepositoryId,
    repositoryId: input.repositoryId,
    displaySlug: input.displaySlug,
    now,
  });
  const suffix = stableSuffix(input.orgId, input.projectId, input.repositoryId);
  const recordId = `mem_seed_${suffix}`;
  const existing = getMemoryRecord(input.orgId, input.projectId, recordId, 1);
  if (existing) return { record: existing, repositoryId: repository.repository_id };
  const record = importActiveMemoryRecord({
    orgId: input.orgId,
    projectId: input.projectId,
    repositoryRowId: repository.repository_row_id,
    recordId,
    kind: "constraint",
    content: {
      summary: "Payment retries must reuse the original idempotency key.",
      details: "Every retry for one logical payment must retain the first provider idempotency key across ambiguous responses.",
      rationale: "Changing the key can create a second charge after the provider accepted the original request.",
    },
    applicability: {
      repository_id: repository.repository_id,
      components: ["payments"],
      paths: ["src/payments/retry.ts"],
      symbols: ["retryCharge"],
      task_classes: ["bug_fix"],
    },
    exceptions: [],
    compatibility: {
      harness_version_range: "*",
      workflow_version_range: "*",
      adapter_version_range: "*",
    },
    validation: {
      strategy: "repository_anchors",
      anchor_refs: [{
        type: "symbol",
        path: "src/payments/retry.ts",
        value: "retryCharge",
        digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      }],
    },
    evidence: [{
      evidence_ref_id: `seed_evidence_${suffix}`,
      type: "git_diff",
      digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      origin_id: `${repository.repository_id}:seed-fixture:verified-merge`,
      source_authority: "verified",
    }],
    evidenceSummary: { strength: "verified_merge_and_test", ref_count: 1 },
    freshness: { last_confirmed_at: now, expires_at: null },
    provenance: {
      producer: "pim-server-seed",
      extractor_version: "memory-seed-v1",
      allowlisted: true,
      provider_repository_id: input.providerRepositoryId,
    },
    validFrom: now,
    actorId: "memory-seed-import",
    reasonCode: "seed_fixture_imported",
    now,
  });
  return { record, repositoryId: repository.repository_id };
}
