import { Writable } from "node:stream";
import rateLimit from "@fastify/rate-limit";
import Fastify, {
  type FastifyContextConfig,
  type FastifyInstance,
} from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  canonicalJsonSha256,
  MEMORY_CONTRACT_FIXTURES,
  MEMORY_CONTRACT_FIXTURES_V2,
  parseMemoryContractV2,
  type HarnessRunReceiptV2,
  type MemoryBindingV2,
  type ResourceBindingV2,
} from "@pim/shared";
import { PimMemoryV2Client } from "../../../../sdk/src/memory-v2-client.js";

const { testDb } = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  return { testDb: database };
});

let transactionSequence = 0;

function transaction<T>(begin: "BEGIN" | "BEGIN IMMEDIATE", fn: () => T): T {
  const nested = testDb.isTransaction;
  const savepoint = nested ? `memory_mcp_test_${++transactionSequence}` : "";
  testDb.exec(nested ? `SAVEPOINT ${savepoint}` : begin);
  try {
    const value = fn();
    testDb.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
    return value;
  } catch (error) {
    if (nested) {
      testDb.exec(`ROLLBACK TO ${savepoint}`);
      testDb.exec(`RELEASE ${savepoint}`);
    } else {
      testDb.exec("ROLLBACK");
    }
    throw error;
  }
}

vi.mock("../../db/connection.js", () => ({
  default: testDb,
  withTransaction: <T>(fn: () => T) => transaction("BEGIN", fn),
  withImmediateTransaction: <T>(fn: () => T) => transaction("BEGIN IMMEDIATE", fn),
}));

import { createTables } from "../../db/schema.js";
import { createAuthHook } from "../../middleware/auth.js";
import { resolveRequestOrg } from "../../middleware/org-context.js";
import { authorizeMemoryV2Resource } from "../../middleware/service-authz.js";
import { registerJsonBodyParser } from "../../middleware/validation.js";
import {
  setMemoryMetricSink,
  type MemoryMetric,
} from "../../services/memory-metrics.js";
import { seedMemoryReadFixture } from "../../services/memory-seed.js";
import { importActiveHarnessMemoryRecord } from "../../services/memory-harness-records.js";
import { createOrg } from "../../services/orgs.js";
import {
  registerMemoryRepository,
  renameMemoryRepository,
} from "../../services/memory-repository-registry.js";
import { resolveMemoryV2Resource } from "../../services/memory-v2-resources.js";
import { setMemoryRuntimeAttestationVerifier } from "../../services/memory-v2-runtime-attestations.js";
import { ensureMemoryV2EvidenceVerifiedTrust } from "../../services/memory-v2-trust.js";
import {
  createPrivateMemoryMcpServiceToken,
  createServiceToken,
  PRIVATE_MEMORY_MCP_AUDIENCE,
  PRIVATE_MEMORY_MCP_AUTHENTICATION_PROFILE,
  PRIVATE_MEMORY_MCP_ENDPOINT_PATH,
  PRIVATE_MEMORY_MCP_RESOURCE_INDICATOR,
  revokeServiceToken,
  verifyPrivateMemoryMcpServiceToken,
  verifyServiceToken,
  type CreatedPrivateMemoryMcpServiceToken,
  type CreatedServiceToken,
} from "../../services/service-tokens.js";
import { upsertUserByIms } from "../../services/users.js";
import memoryMcpRoutes, {
  MEMORY_MCP_BODY_LIMIT,
  MEMORY_MCP_RATE_LIMIT,
} from "../memory-mcp.js";
import memoryV2BindingRoutes from "../memory-v2-binding.js";
import memoryV2ReadinessRoutes from "../memory-v2-readiness.js";
import memoryV2SearchRoutes from "../memory-v2-search.js";
import memoryV2WriteRoutes from "../memory-v2-write.js";

const logChunks: string[] = [];
const metrics: MemoryMetric[] = [];
let app: FastifyInstance;
let ownerUserId = "";
let orgId = "";
let valid: CreatedPrivateMemoryMcpServiceToken;
let legacy: CreatedServiceToken;
let unsafe: CreatedServiceToken;
let missingBinding: CreatedPrivateMemoryMcpServiceToken;
let missingMembership: CreatedPrivateMemoryMcpServiceToken;
let withoutCodeSearch: CreatedPrivateMemoryMcpServiceToken;
let harnessSearchOnly: CreatedPrivateMemoryMcpServiceToken;
let postRouteConfig: FastifyContextConfig | undefined;
let seededRecordId = "";
let liveBaseUrl: string | null = null;

const clientMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "memory-mcp-route-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function futureExpiry(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
}

function insertProject(): void {
  testDb.prepare(
    `INSERT INTO projects
       (project_id, name, description, created_at, anatomy_json, resources_json,
        org_id, created_by_user_id)
     VALUES ('project-mcp', 'Memory MCP', NULL, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    JSON.stringify({ internal: [], external: [] }),
    JSON.stringify({ github: { repos: ["acme/memory"] } }),
    orgId,
    ownerUserId,
  );
}

function insertProfile(tokenId: string): void {
  testDb.prepare(
    `INSERT INTO memory_v2_service_token_mcp_profiles
       (token_id, authentication_profile, audience, resource_indicator,
        endpoint_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    tokenId,
    PRIVATE_MEMORY_MCP_AUTHENTICATION_PROFILE,
    PRIVATE_MEMORY_MCP_AUDIENCE,
    PRIVATE_MEMORY_MCP_RESOURCE_INDICATOR,
    PRIVATE_MEMORY_MCP_ENDPOINT_PATH,
    new Date().toISOString(),
  );
}

function createPrivate(name: string): CreatedPrivateMemoryMcpServiceToken {
  return createPrivateMemoryMcpServiceToken({
    orgId,
    name,
    scopes: ["memory:search", "memory:receipt:write"],
    createdByUserId: ownerUserId,
    projectId: "project-mcp",
    repositoryIds: ["github.com/acme/memory"],
    expiresAt: futureExpiry(),
  });
}

function createSlice3Private(name: string): CreatedPrivateMemoryMcpServiceToken {
  return createPrivateMemoryMcpServiceToken({
    orgId,
    name,
    scopes: [
      "memory:search",
      "memory:receipt:write",
      "memory:candidate:read",
      "memory:feedback:write",
    ],
    createdByUserId: ownerUserId,
    projectId: "project-mcp",
    repositoryIds: ["github.com/acme/memory"],
    expiresAt: futureExpiry(),
  });
}

function createHarnessSearchPrivate(name: string): CreatedPrivateMemoryMcpServiceToken {
  return createPrivateMemoryMcpServiceToken({
    orgId,
    name,
    scopes: ["memory:harness:search"],
    createdByUserId: ownerUserId,
    projectId: "project-mcp",
    harnessIds: ["example-harness-a"],
    expiresAt: futureExpiry(),
  });
}

function createSlice5HarnessPrivate(
  name: string,
  harnessId = "example-harness-a",
): CreatedPrivateMemoryMcpServiceToken {
  return createPrivateMemoryMcpServiceToken({
    orgId,
    name,
    scopes: [
      "memory:harness:receipt:write",
      "memory:harness:candidate:read",
    ],
    createdByUserId: ownerUserId,
    projectId: "project-mcp",
    harnessIds: [harnessId],
    expiresAt: futureExpiry(),
  });
}

function createSlice5HarnessHttpToken(
  name: string,
  harnessId = "example-harness-a",
): CreatedServiceToken {
  return createServiceToken({
    orgId,
    name,
    scopes: [
      "memory:harness:receipt:write",
      "memory:harness:candidate:read",
    ],
    createdByUserId: ownerUserId,
    projectId: "project-mcp",
    harnessIds: [harnessId],
    expiresAt: futureExpiry(),
  });
}

function mcpHeaders(
  method: string,
  name: string,
  token?: string,
): Record<string, string> {
  return {
    "content-type": "application/json",
    "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": method,
    "Mcp-Name": name,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function mcpPayload(
  method: string,
  name: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: `${method}:${name}`,
    method,
    params,
  };
}

async function callMcpTool(
  token: string,
  name: "pim_memory_capabilities" | "pim_memory_binding",
): Promise<ReturnType<FastifyInstance["inject"]> extends Promise<infer T> ? T : never> {
  return app.inject({
    method: "POST",
    url: "/mcp/memory",
    headers: mcpHeaders("tools/call", name, token),
    payload: mcpPayload("tools/call", name, {
      name,
      arguments: {},
      _meta: clientMeta,
    }),
  });
}

async function invokeMcpTool(
  token: string,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<ReturnType<FastifyInstance["inject"]> extends Promise<infer T> ? T : never> {
  return app.inject({
    method: "POST",
    url: "/mcp/memory",
    headers: mcpHeaders("tools/call", name, token),
    payload: mcpPayload("tools/call", name, {
      name,
      arguments: argumentsValue,
      _meta: clientMeta,
    }),
  });
}

async function directHttpBinding(token: string): Promise<MemoryBindingV2> {
  const response = await app.inject({
    method: "GET",
    url: "/api/v2/memory/binding",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode, response.body).toBe(200);
  return parseMemoryContractV2("MemoryBindingV2", response.json());
}

async function memoryMcpLiveBaseUrl(): Promise<string> {
  liveBaseUrl ??= await app.listen({ host: "127.0.0.1", port: 0 });
  return liveBaseUrl;
}

function slice3ReceiptInput(input: {
  suffix: string;
  producerRunId: string;
  resourceBinding: ResourceBindingV2;
  baseSha: string;
  scopeSnapshotDigest: string;
}): Record<string, unknown> {
  const source = structuredClone(MEMORY_CONTRACT_FIXTURES_V2.RunReceiptV2);
  const sourceCandidate = source.candidates[0]!;
  const manifest = {
    schema_version: "pim.memory-code-evidence.v2",
    manifest_id: `manifest-mcp-slice3-${input.suffix}`,
    refs: [],
  } as const;
  return {
    idempotency_key: `mcp-receipt-slice3-${input.suffix}`,
    producer_run_id: input.producerRunId,
    receipt: {
      schema_version: "pim.run-receipt.v2",
      external_session_id: `mcp-slice3-session-${input.suffix}`,
      producer: {
        ...source.producer,
        consumer_run_id: input.producerRunId,
      },
      plane: "codebase",
      resource_selector: {
        canonical_resource_id: input.resourceBinding.canonical_resource_id,
      },
      scope_snapshot: {
        schema_version: "pim.memory-scope-snapshot.codebase.v2",
        plane: "codebase",
        repository_id: input.resourceBinding.canonical_resource_id,
        base_sha: input.baseSha,
        scope_snapshot_digest: input.scopeSnapshotDigest,
      },
      task: source.task,
      outcome: source.outcome,
      retrieval_feedback: [],
      evidence_manifest: {
        ...manifest,
        digest: canonicalJsonSha256(manifest),
      },
      candidates: [{
        ...sourceCandidate,
        client_candidate_id: `candidate-mcp-slice3-${input.suffix}`,
        resource_row_id: input.resourceBinding.resource_row_id,
        scope_snapshot_digest: input.scopeSnapshotDigest,
        applicability: {
          ...sourceCandidate.applicability,
          repository_id: input.resourceBinding.canonical_resource_id,
          base_sha: input.baseSha,
        },
        source_run_ids: [input.producerRunId],
        evidence_refs: [],
      }],
    },
  };
}

function slice5HarnessReceiptInput(input: {
  suffix: string;
  producerRunId: string;
  resourceBinding: ResourceBindingV2;
}): Record<string, unknown> {
  const source = structuredClone(MEMORY_CONTRACT_FIXTURES_V2.HarnessRunReceiptV2);
  const sourceCandidate = source.candidates[0]!;
  const sourceEvidence = source.evidence_handles[0]!;
  const configurationDigest = canonicalJsonSha256({
    configuration_id: "routing-default-v2",
    fixture: input.suffix,
  });
  const snapshot = {
    schema_version: "pim.memory-scope-snapshot.harness.v2" as const,
    plane: "harness" as const,
    resource_binding: input.resourceBinding,
    harness_id: "example-harness-a",
    harness_version: "7b6e858",
    workflow_version: "code-change.v3",
    adapter_version: "example-harness-a-pim-adapter.v2",
    configuration_id: "routing-default-v2",
    configuration_digest: configurationDigest,
  };
  const scopeSnapshotDigest = canonicalJsonSha256(snapshot);
  const { resource_binding: _resourceBinding, ...mcpSnapshot } = snapshot;
  const evidenceRefId = `runtime-root-${input.suffix}`;
  const failureFingerprint = `failure:harness:${input.suffix}`;
  return {
    idempotency_key: `mcp-harness-receipt-${input.suffix}`,
    producer_run_id: input.producerRunId,
    receipt: {
      schema_version: "pim.run-receipt.v2",
      external_session_id: `mcp-harness-session-${input.suffix}`,
      producer: {
        ...source.producer,
        consumer_run_id: input.producerRunId,
      },
      plane: "harness",
      resource_selector: {
        canonical_resource_id: input.resourceBinding.canonical_resource_id,
      },
      scope_snapshot: {
        ...mcpSnapshot,
        scope_snapshot_digest: scopeSnapshotDigest,
      },
      task: {
        task_class: "recovery",
        summary: "Resolve an ambiguous harness tool outcome safely.",
      },
      outcome: {
        status: "completed",
        terminal_stage: "verify",
        reason_code: "recovery_verified",
        verification_status: "passed",
        failure_fingerprint: failureFingerprint,
      },
      retrieval_feedback: [],
      evidence_handles: [{
        ...sourceEvidence,
        evidence_ref_id: evidenceRefId,
        provider_event_id: `runtime-event-${input.suffix}`,
        immutable_digest: canonicalJsonSha256({ runtime_event: input.suffix }),
        outcome: {
          ...sourceEvidence.outcome,
          failure_fingerprint: failureFingerprint,
        },
        occurred_at: "2026-08-09T20:00:00.000Z",
      }],
      candidates: [{
        ...sourceCandidate,
        client_candidate_id: `harness-candidate-${input.suffix}`,
        resource_row_id: input.resourceBinding.resource_row_id,
        scope_snapshot_digest: scopeSnapshotDigest,
        content: {
          summary: "A harness timeout can hide a completed side effect.",
          details: "Resolve the exact runtime provider event before retrying so an already completed side effect is never repeated blindly.",
          rationale: "The origin-bound runtime outcome makes an unverified retry unsafe.",
        },
        applicability: {
          ...sourceCandidate.applicability,
          harness_id: "example-harness-a",
          harness_version_range: "7b6e858",
          workflow_version_range: "code-change.v3",
          adapter_version_range: "example-harness-a-pim-adapter.v2",
          configuration_ids: ["routing-default-v2"],
          configuration_digests: [configurationDigest],
        },
        validation: {
          ...sourceCandidate.validation,
          failure_fingerprint: failureFingerprint,
        },
        source_run_ids: [input.producerRunId],
        evidence_refs: [evidenceRefId],
      }],
    },
  };
}

function slice5HarnessHttpReceipt(input: {
  suffix: string;
  producerRunId: string;
  resourceBinding: ResourceBindingV2;
  projectId?: string;
}): {
  idempotencyKey: string;
  producerRunId: string;
  receipt: HarnessRunReceiptV2;
} {
  const mcpInput = slice5HarnessReceiptInput(input) as {
    idempotency_key: string;
    producer_run_id: string;
    receipt: HarnessRunReceiptV2 & {
      scope_snapshot: Omit<HarnessRunReceiptV2["scope_snapshot"], "resource_binding">;
    };
  };
  return {
    idempotencyKey: mcpInput.idempotency_key,
    producerRunId: mcpInput.producer_run_id,
    receipt: parseMemoryContractV2("HarnessRunReceiptV2", {
      ...mcpInput.receipt,
      tenant: { project_id: input.projectId ?? "project-mcp" },
      scope_snapshot: {
        ...mcpInput.receipt.scope_snapshot,
        resource_binding: input.resourceBinding,
      },
    }),
  };
}

function seedSlice4HarnessRecord(
  recordId: string,
  options: { harnessId?: string; now?: string } = {},
): void {
  const source = structuredClone(MEMORY_CONTRACT_FIXTURES.MemoryRecordV1);
  const harnessId = options.harnessId ?? "example-harness-a";
  const now = options.now ?? "2026-08-07T17:00:00.000Z";
  const record = importActiveHarnessMemoryRecord({
    orgId,
    projectId: "project-mcp",
    recordId,
    kind: "anti_pattern",
    content: {
      summary: "Inspect terminal tool state before retrying a timeout.",
      details: "An ambiguous timeout may hide a completed side effect, so resolve the exact terminal state first.",
      rationale: "Blind retries can duplicate a side effect that already completed.",
    },
    applicability: {
      harness_id: harnessId,
      harness_version_range: "7b6e858",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "example-harness-a-pim-adapter.v2",
      configuration_ids: ["routing-default-v2"],
      model_ids: ["claude-sonnet"],
      tool_ids: ["github"],
    },
    exceptions: ["Do not retry when terminal state cannot be resolved."],
    compatibility: {
      harness_version_range: "7b6e858",
      workflow_version_range: "code-change.v3",
      adapter_version_range: "example-harness-a-pim-adapter.v2",
    },
    validation: {
      strategy: "stable_failure_fingerprint",
      failure_fingerprint: "fixture:harness:tool-timeout:v2",
    },
    evidence: [{
      ...source.evidence[0]!,
      evidence_ref_id: `evidence-${recordId}`,
      origin_id: `${harnessId}:${recordId}:authorized-review`,
      source_authority: "authorized_review",
    }],
    evidenceSummary: { strength: "reviewed", ref_count: 1 },
    freshness: { last_confirmed_at: "2026-08-07T17:00:00.000Z", expires_at: null },
    provenance: {
      source: "slice4_mcp_acceptance",
      extractor_version: "slice4-mcp-test-v1",
    },
    actorId: "slice4-mcp-reviewer",
    decisionRefs: [`decision-${recordId}`],
    reasonCode: "authorized_harness_failure_reviewed",
    explanation: "The bounded timeout failure behavior was reviewed.",
    now,
  });
  ensureMemoryV2EvidenceVerifiedTrust({
    recordId: record.recordId,
    recordVersion: record.recordVersion,
    orgId,
    projectId: "project-mcp",
    evidenceVerifiedAt: record.freshness.last_confirmed_at,
    now,
  });
}

beforeAll(async () => {
  createTables();
  const owner = upsertUserByIms({
    ims_user_id: "memory-mcp-owner",
    email: "memory-mcp-owner@example.com",
    display_name: "Memory MCP Owner",
  });
  ownerUserId = owner.user_id;
  const org = createOrg({
    orgId: "org-mcp",
    slug: "memory-mcp",
    name: "Memory MCP",
    creatorUserId: ownerUserId,
  });
  orgId = org.org_id;
  insertProject();
  const seeded = seedMemoryReadFixture({
    orgId,
    projectId: "project-mcp",
    providerRepositoryId: "provider-memory-mcp",
    repositoryId: "github.com/acme/memory",
    displaySlug: "Acme/Memory",
    now: "2026-08-07T17:00:00.000Z",
  });
  seededRecordId = seeded.record.record_id;
  ensureMemoryV2EvidenceVerifiedTrust({
    recordId: seeded.record.record_id,
    recordVersion: seeded.record.record_version,
    orgId,
    projectId: "project-mcp",
    evidenceVerifiedAt: seeded.record.freshness.last_confirmed_at,
  });

  valid = createPrivate("valid-private-memory-mcp");
  legacy = createServiceToken({
    orgId,
    name: "legacy-memory-token",
    scopes: ["memory:search"],
    createdByUserId: ownerUserId,
    projectId: "project-mcp",
    repositoryIds: ["github.com/acme/memory"],
    expiresAt: futureExpiry(),
  });
  unsafe = createServiceToken({
    orgId,
    name: "unsafe-private-memory-mcp",
    scopes: ["memory:review"],
    createdByUserId: ownerUserId,
    projectId: "project-mcp",
    repositoryIds: ["github.com/acme/memory"],
    expiresAt: futureExpiry(),
  });
  insertProfile(unsafe.token_id);
  missingBinding = createPrivate("missing-binding-private-memory-mcp");
  testDb.prepare(
    "DELETE FROM memory_v2_service_token_resource_bindings WHERE token_id = ?",
  ).run(missingBinding.token_id);
  missingMembership = createPrivate("missing-membership-private-memory-mcp");
  const missingMembershipUser = testDb.prepare(
    "SELECT user_id FROM service_principals WHERE service_principal_id = ?",
  ).get(missingMembership.service_principal_id) as { user_id: string };
  testDb.prepare(
    "DELETE FROM memberships WHERE org_id = ? AND user_id = ?",
  ).run(orgId, missingMembershipUser.user_id);
  withoutCodeSearch = createPrivateMemoryMcpServiceToken({
    orgId,
    name: "receipt-only-private-memory-mcp",
    scopes: ["memory:receipt:write"],
    createdByUserId: ownerUserId,
    projectId: "project-mcp",
    repositoryIds: ["github.com/acme/memory"],
    expiresAt: futureExpiry(),
  });
  harnessSearchOnly = createHarnessSearchPrivate("harness-search-private-memory-mcp");

  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logChunks.push(chunk.toString());
      callback();
    },
  });
  app = Fastify({ logger: { level: "info", stream } });
  registerJsonBodyParser(app);
  app.addHook("onRoute", (options) => {
    if (options.method === "POST" && options.url === "/mcp/memory") {
      postRouteConfig = options.config;
    }
  });
  const authenticate = createAuthHook("ims");
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/v2/memory")) return;
    await authenticate(req, reply);
    if (!reply.sent) await resolveRequestOrg(req, reply);
  });
  setMemoryMetricSink((metric) => metrics.push(metric));
  await app.register(memoryV2BindingRoutes);
  await app.register(memoryV2ReadinessRoutes);
  await app.register(memoryV2SearchRoutes);
  await app.register(memoryV2WriteRoutes);
  await app.register(memoryMcpRoutes);
  await app.ready();
});

afterAll(async () => {
  setMemoryMetricSink(null);
  await app.close();
  testDb.close();
});

describe("private PIM memory MCP token profile", () => {
  it("keeps ordinary tokens ineligible and validates the fixed target and expiry", () => {
    const verified = verifyPrivateMemoryMcpServiceToken(valid.token, {
      audience: PRIVATE_MEMORY_MCP_AUDIENCE,
      resourceIndicator: PRIVATE_MEMORY_MCP_RESOURCE_INDICATOR,
      endpointPath: PRIVATE_MEMORY_MCP_ENDPOINT_PATH,
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.verified.profile).toMatchObject({
        authenticationProfile: PRIVATE_MEMORY_MCP_AUTHENTICATION_PROFILE,
        audience: PRIVATE_MEMORY_MCP_AUDIENCE,
        resourceIndicator: PRIVATE_MEMORY_MCP_RESOURCE_INDICATOR,
        endpointPath: PRIVATE_MEMORY_MCP_ENDPOINT_PATH,
      });
      expect(verified.verified.auth.expiresAt).toBe(valid.expires_at);
    }

    expect(verifyPrivateMemoryMcpServiceToken(legacy.token, {
      audience: PRIVATE_MEMORY_MCP_AUDIENCE,
      resourceIndicator: PRIVATE_MEMORY_MCP_RESOURCE_INDICATOR,
      endpointPath: PRIVATE_MEMORY_MCP_ENDPOINT_PATH,
    })).toEqual({ ok: false, reason: "profile_required" });
    expect(verifyPrivateMemoryMcpServiceToken(valid.token, {
      audience: "urn:pim:audience:wrong",
      resourceIndicator: PRIVATE_MEMORY_MCP_RESOURCE_INDICATOR,
      endpointPath: PRIVATE_MEMORY_MCP_ENDPOINT_PATH,
    })).toEqual({ ok: false, reason: "profile_mismatch" });
    expect(verifyPrivateMemoryMcpServiceToken(unsafe.token, {
      audience: PRIVATE_MEMORY_MCP_AUDIENCE,
      resourceIndicator: PRIVATE_MEMORY_MCP_RESOURCE_INDICATOR,
      endpointPath: PRIVATE_MEMORY_MCP_ENDPOINT_PATH,
    })).toEqual({ ok: false, reason: "unsafe_scope" });
  });

  it("issues the explicit private profile in production and keeps profile rows immutable", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const productionToken = createPrivate("production-private-profile");
      expect(verifyPrivateMemoryMcpServiceToken(productionToken.token, {
        audience: PRIVATE_MEMORY_MCP_AUDIENCE,
        resourceIndicator: PRIVATE_MEMORY_MCP_RESOURCE_INDICATOR,
        endpointPath: PRIVATE_MEMORY_MCP_ENDPOINT_PATH,
      }).ok).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
    expect(() => testDb.prepare(
      "UPDATE memory_v2_service_token_mcp_profiles SET audience = audience WHERE token_id = ?",
    ).run(valid.token_id)).toThrow(/immutable/);
  });

  it("rolls back token, bindings, and profile atomically when profile persistence fails", () => {
    const tables = [
      "users",
      "memberships",
      "service_principals",
      "service_tokens",
      "memory_service_token_repository_bindings",
      "memory_v2_service_token_resource_bindings",
      "memory_v2_service_token_mcp_profiles",
    ];
    const counts = () => tables.map((table) => (
      testDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
    ).count);
    const before = counts();
    testDb.exec(`
      CREATE TRIGGER test_reject_mcp_profile
      BEFORE INSERT ON memory_v2_service_token_mcp_profiles
      BEGIN SELECT RAISE(ABORT, 'injected MCP profile failure'); END
    `);
    try {
      expect(() => createPrivate("must-rollback-profile"))
        .toThrow(/profile store is unavailable/);
    } finally {
      testDb.exec("DROP TRIGGER test_reject_mcp_profile");
    }
    expect(counts()).toEqual(before);
  });

  it("rolls the whole token write back when its v2 binding companion fails", () => {
    const tables = [
      "users",
      "memberships",
      "service_principals",
      "service_tokens",
      "memory_service_token_repository_bindings",
      "memory_v2_service_token_resource_bindings",
    ];
    const counts = () => tables.map((table) => (
      testDb.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }
    ).count);
    const before = counts();
    testDb.exec(`
      CREATE TRIGGER test_reject_v2_token_binding
      BEFORE INSERT ON memory_v2_service_token_resource_bindings
      BEGIN SELECT RAISE(ABORT, 'injected v2 token-binding failure'); END
    `);
    try {
      expect(() => createServiceToken({
        orgId,
        name: "must-rollback",
        scopes: ["memory:search"],
        createdByUserId: ownerUserId,
        projectId: "project-mcp",
        repositoryIds: ["github.com/acme/memory"],
        expiresAt: futureExpiry(),
      })).toThrow(/injected v2 token-binding failure/);
    } finally {
      testDb.exec("DROP TRIGGER test_reject_v2_token_binding");
    }
    expect(counts()).toEqual(before);
  });

  it("denies every cross-org, cross-principal, cross-project, cross-plane, cross-resource, and missing-scope tuple", () => {
    const dualPlane = createPrivateMemoryMcpServiceToken({
      orgId,
      name: "dual-plane-authorization-matrix",
      scopes: ["memory:search", "memory:harness:search"],
      createdByUserId: ownerUserId,
      projectId: "project-mcp",
      repositoryIds: ["github.com/acme/memory"],
      harnessIds: ["example-harness-a"],
      expiresAt: futureExpiry(),
    });
    const verification = verifyPrivateMemoryMcpServiceToken(dualPlane.token, {
      audience: PRIVATE_MEMORY_MCP_AUDIENCE,
      resourceIndicator: PRIVATE_MEMORY_MCP_RESOURCE_INDICATOR,
      endpointPath: PRIVATE_MEMORY_MCP_ENDPOINT_PATH,
    });
    expect(verification.ok).toBe(true);
    if (!verification.ok) throw new Error("Expected dual-plane test token to verify");

    const code = resolveMemoryV2Resource({
      orgId,
      projectId: "project-mcp",
      plane: "codebase",
      canonicalResourceId: "github.com/acme/memory",
    });
    const harness = resolveMemoryV2Resource({
      orgId,
      projectId: "project-mcp",
      plane: "harness",
      canonicalResourceId: "example-harness-a",
    });
    expect(code).not.toBeNull();
    expect(harness).not.toBeNull();

    testDb.prepare(
      "UPDATE projects SET resources_json = ? WHERE project_id = 'project-mcp' AND org_id = ?",
    ).run(JSON.stringify({
      github: { repos: ["acme/memory", "acme/other-principal"] },
    }), orgId);
    const otherPrincipalRepository = registerMemoryRepository({
      orgId,
      projectId: "project-mcp",
      providerRepositoryId: "provider-other-principal",
      repositoryId: "github.com/acme/other-principal",
      displaySlug: "Acme/Other-Principal",
    });
    const otherPrincipalToken = createPrivateMemoryMcpServiceToken({
      orgId,
      name: "other-principal-authorization-matrix",
      scopes: ["memory:search"],
      createdByUserId: ownerUserId,
      projectId: "project-mcp",
      repositoryIds: [otherPrincipalRepository.repository_id],
      expiresAt: futureExpiry(),
    });
    const otherPrincipalVerification = verifyPrivateMemoryMcpServiceToken(
      otherPrincipalToken.token,
      {
        audience: PRIVATE_MEMORY_MCP_AUDIENCE,
        resourceIndicator: PRIVATE_MEMORY_MCP_RESOURCE_INDICATOR,
        endpointPath: PRIVATE_MEMORY_MCP_ENDPOINT_PATH,
      },
    );
    expect(otherPrincipalVerification.ok).toBe(true);
    if (!otherPrincipalVerification.ok) throw new Error("Expected other-principal token to verify");
    const otherPrincipalResource = resolveMemoryV2Resource({
      orgId,
      projectId: "project-mcp",
      plane: "codebase",
      canonicalResourceId: otherPrincipalRepository.repository_id,
    });
    expect(otherPrincipalResource).not.toBeNull();

    const otherOrg = createOrg({
      orgId: "org-mcp-other",
      slug: "memory-mcp-other",
      name: "Memory MCP Other",
      creatorUserId: ownerUserId,
    });
    testDb.prepare(
      `INSERT INTO projects
         (project_id, name, description, created_at, anatomy_json, resources_json,
          org_id, created_by_user_id)
       VALUES ('project-mcp-other-org', 'Memory MCP Other', NULL, ?, ?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(),
      JSON.stringify({ internal: [], external: [] }),
      JSON.stringify({ github: { repos: ["other/memory"] } }),
      otherOrg.org_id,
      ownerUserId,
    );
    const otherOrgRepository = registerMemoryRepository({
      orgId: otherOrg.org_id,
      projectId: "project-mcp-other-org",
      providerRepositoryId: "provider-other-org-memory",
      repositoryId: "github.com/other/memory",
      displaySlug: "Other/Memory",
    });
    const otherOrgToken = createPrivateMemoryMcpServiceToken({
      orgId: otherOrg.org_id,
      name: "other-org-authorization-matrix",
      scopes: ["memory:search"],
      createdByUserId: ownerUserId,
      projectId: "project-mcp-other-org",
      repositoryIds: [otherOrgRepository.repository_id],
      expiresAt: futureExpiry(),
    });
    const otherOrgVerification = verifyPrivateMemoryMcpServiceToken(otherOrgToken.token, {
      audience: PRIVATE_MEMORY_MCP_AUDIENCE,
      resourceIndicator: PRIVATE_MEMORY_MCP_RESOURCE_INDICATOR,
      endpointPath: PRIVATE_MEMORY_MCP_ENDPOINT_PATH,
    });
    expect(otherOrgVerification.ok).toBe(true);
    if (!otherOrgVerification.ok) throw new Error("Expected other-org token to verify");
    const otherOrgResource = resolveMemoryV2Resource({
      orgId: otherOrg.org_id,
      projectId: "project-mcp-other-org",
      plane: "codebase",
      canonicalResourceId: otherOrgRepository.repository_id,
    });
    expect(otherOrgResource).not.toBeNull();

    expect(authorizeMemoryV2Resource({
      principal: verification.verified.authorization,
      operation: "search",
      plane: "codebase",
      projectId: "project-mcp",
      resourceRowId: code!.resourceRowId,
    }).decision).toBe("allow");
    expect(authorizeMemoryV2Resource({
      principal: verification.verified.authorization,
      operation: "search",
      plane: "harness",
      projectId: "project-mcp",
      resourceRowId: harness!.resourceRowId,
    }).decision).toBe("allow");

    expect(authorizeMemoryV2Resource({
      principal: verification.verified.authorization,
      operation: "search",
      plane: "harness",
      projectId: "project-mcp",
      resourceRowId: code!.resourceRowId,
    })).toEqual({ decision: "deny", reason: "resource_binding_mismatch" });
    expect(authorizeMemoryV2Resource({
      principal: verification.verified.authorization,
      operation: "search",
      plane: "codebase",
      projectId: "project-mcp",
      resourceRowId: harness!.resourceRowId,
    })).toEqual({ decision: "deny", reason: "resource_binding_mismatch" });
    expect(authorizeMemoryV2Resource({
      principal: verification.verified.authorization,
      operation: "search",
      plane: "codebase",
      projectId: "project-mcp-other-org",
      resourceRowId: otherOrgResource!.resourceRowId,
    })).toEqual({ decision: "deny", reason: "project_binding_mismatch" });
    expect(authorizeMemoryV2Resource({
      principal: verification.verified.authorization,
      operation: "search",
      plane: "codebase",
      projectId: "project-mcp",
      resourceRowId: otherPrincipalResource!.resourceRowId,
    })).toEqual({ decision: "deny", reason: "resource_binding_mismatch" });
    expect(authorizeMemoryV2Resource({
      principal: otherPrincipalVerification.verified.authorization,
      operation: "search",
      plane: "codebase",
      projectId: "project-mcp",
      resourceRowId: code!.resourceRowId,
    })).toEqual({ decision: "deny", reason: "resource_binding_mismatch" });
    expect(authorizeMemoryV2Resource({
      principal: verification.verified.authorization,
      operation: "search",
      plane: "codebase",
      projectId: "project-mcp",
      resourceRowId: otherOrgResource!.resourceRowId,
    })).toEqual({ decision: "deny", reason: "resource_binding_mismatch" });
    expect(authorizeMemoryV2Resource({
      principal: otherOrgVerification.verified.authorization,
      operation: "search",
      plane: "codebase",
      projectId: "project-mcp-other-org",
      resourceRowId: code!.resourceRowId,
    })).toEqual({ decision: "deny", reason: "resource_binding_mismatch" });
    expect(authorizeMemoryV2Resource({
      principal: verification.verified.authorization,
      operation: "candidate_read",
      plane: "codebase",
      projectId: "project-mcp",
      resourceRowId: code!.resourceRowId,
    })).toEqual({ decision: "deny", reason: "scope_missing" });
    expect(authorizeMemoryV2Resource({
      principal: verification.verified.authorization,
      operation: "search",
      plane: "codebase",
      projectId: "project-mcp",
      resourceRowId: "v2res_repository:not-bound",
    })).toEqual({ decision: "deny", reason: "resource_binding_mismatch" });
  });

  it("fails closed if a v2 binding outlives its v1 source-authority row", () => {
    const stale = createPrivate("stale-source-authority");
    const deleteGuard = testDb.prepare(
      `SELECT sql FROM sqlite_schema
       WHERE type = 'trigger' AND name = 'memory_service_repository_bindings_no_delete'`,
    ).get() as { sql: string };
    testDb.exec("DROP TRIGGER memory_service_repository_bindings_no_delete");
    try {
      testDb.prepare(
        "DELETE FROM memory_service_token_repository_bindings WHERE token_id = ?",
      ).run(stale.token_id);
    } finally {
      testDb.exec(deleteGuard.sql);
    }
    expect(testDb.prepare(
      `SELECT COUNT(*) AS count FROM memory_v2_service_token_resource_bindings
       WHERE token_id = ?`,
    ).get(stale.token_id)).toEqual({ count: 1 });
    expect(verifyPrivateMemoryMcpServiceToken(stale.token, {
      audience: PRIVATE_MEMORY_MCP_AUDIENCE,
      resourceIndicator: PRIVATE_MEMORY_MCP_RESOURCE_INDICATOR,
      endpointPath: PRIVATE_MEMORY_MCP_ENDPOINT_PATH,
    })).toEqual({ ok: false, reason: "resource_binding_required" });
  });
});

describe("Slice-1 HTTP and MCP binding parity", () => {
  it("reports the existing code attestation scope and its effective operation", async () => {
    const attestationToken = createServiceToken({
      orgId,
      name: "code-attestation-binding-introspection",
      scopes: ["memory:attest"],
      createdByUserId: ownerUserId,
      projectId: "project-mcp",
      repositoryIds: ["github.com/acme/memory"],
      expiresAt: futureExpiry(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v2/memory/binding",
      headers: { authorization: `Bearer ${attestationToken.token}` },
    });

    expect(response.statusCode, response.body).toBe(200);
    const binding = parseMemoryContractV2("MemoryBindingV2", response.json());
    expect(binding.scopes).toEqual(["memory:attest"]);
    expect(binding.resources).toHaveLength(1);
    expect(binding.resources[0]?.permitted_operations).toEqual([
      "runtime_attestation_write",
    ]);
  });

  it("returns the same non-secret exact binding through both transports", async () => {
    const http = await app.inject({
      method: "GET",
      url: "/api/v2/memory/binding",
      headers: { authorization: `Bearer ${valid.token}` },
    });
    expect(http.statusCode, http.body).toBe(200);
    expect(http.headers["cache-control"]).toBe("private, no-store");
    expect(http.headers.vary).toBe("Authorization");
    const httpBinding = parseMemoryContractV2("MemoryBindingV2", http.json());

    const mcp = await callMcpTool(valid.token, "pim_memory_binding");
    expect(mcp.statusCode, mcp.body).toBe(200);
    expect(mcp.headers["cache-control"]).toBe("private, no-store");
    expect(mcp.headers.vary).toBe("Authorization");
    expect(mcp.headers["mcp-session-id"]).toBeUndefined();
    const mcpBinding = parseMemoryContractV2(
      "MemoryBindingV2",
      mcp.json().result.structuredContent,
    );
    expect(mcpBinding).toEqual(httpBinding);
    expect(mcpBinding).toMatchObject({
      service_principal_id: valid.service_principal_id,
      tenant: { organization_id: orgId, project_id: "project-mcp" },
      scopes: ["memory:search", "memory:receipt:write"],
    } satisfies Partial<MemoryBindingV2>);
    expect(mcpBinding.resources).toHaveLength(1);
    expect(mcpBinding.resources[0]).toMatchObject({
      plane: "codebase",
      canonical_resource_id: "github.com/acme/memory",
    });
    expect(JSON.stringify({ http: http.json(), mcp: mcp.json() })).not.toContain(valid.token);
    expect(JSON.stringify(mcpBinding)).not.toContain(valid.token_id);

    const spoofedOrg = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: {
        ...mcpHeaders("tools/call", "pim_memory_binding", valid.token),
        "x-pim-org": "attacker-org",
      },
      payload: mcpPayload("tools/call", "pim_memory_binding", {
        name: "pim_memory_binding",
        arguments: {},
        _meta: clientMeta,
      }),
    });
    expect(spoofedOrg.statusCode, spoofedOrg.body).toBe(200);
    expect(spoofedOrg.json().result.structuredContent.tenant).toEqual({
      organization_id: orgId,
      project_id: "project-mcp",
    });

    const callerSelectedTenant = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("tools/call", "pim_memory_binding", valid.token),
      payload: mcpPayload("tools/call", "pim_memory_binding", {
        name: "pim_memory_binding",
        arguments: {
          organization_id: "attacker-org",
          project_id: "attacker-project",
        },
        _meta: clientMeta,
      }),
    });
    expect(callerSelectedTenant.statusCode).toBe(200);
    expect(callerSelectedTenant.json().result.isError).toBe(true);
    expect(callerSelectedTenant.body).not.toContain("attacker-org");
  });

  it("preserves exact token bindings across a repository rename", async () => {
    const repositoryIdBefore = "github.com/acme/memory-before-rename";
    const repositoryIdAfter = "github.com/acme/memory-after-rename";
    const providerRepositoryId = "provider-memory-mcp-rename";
    testDb.prepare(
      "UPDATE projects SET resources_json = ? WHERE org_id = ? AND project_id = ?",
    ).run(JSON.stringify({
      github: {
        repos: [
          "acme/memory",
          "acme/memory-before-rename",
          "acme/memory-after-rename",
        ],
      },
    }), orgId, "project-mcp");

    const repository = registerMemoryRepository({
      orgId,
      projectId: "project-mcp",
      providerRepositoryId,
      repositoryId: repositoryIdBefore,
      displaySlug: "Acme/Memory-Before-Rename",
    });
    const token = createPrivateMemoryMcpServiceToken({
      orgId,
      name: "repository-rename-binding-parity",
      scopes: ["memory:search"],
      createdByUserId: ownerUserId,
      projectId: "project-mcp",
      repositoryIds: [repositoryIdBefore],
      expiresAt: futureExpiry(),
    });
    const legacyBindingBefore = testDb.prepare(
      `SELECT binding_id, repository_row_id, repository_id
       FROM memory_service_token_repository_bindings WHERE token_id = ?`,
    ).get(token.token_id) as {
      binding_id: string;
      repository_row_id: string;
      repository_id: string;
    };
    const v2BindingBefore = testDb.prepare(
      `SELECT binding_id, resource_row_id, source_binding_id
       FROM memory_v2_service_token_resource_bindings WHERE token_id = ?`,
    ).get(token.token_id) as {
      binding_id: string;
      resource_row_id: string;
      source_binding_id: string;
    };

    expect(legacyBindingBefore).toMatchObject({
      repository_row_id: repository.repository_row_id,
      repository_id: repositoryIdBefore,
    });
    expect(v2BindingBefore.source_binding_id).toBe(legacyBindingBefore.binding_id);
    expect(verifyServiceToken(token.token)?.auth.repositoryBindings).toEqual([{
      repositoryRowId: repository.repository_row_id,
      repositoryId: repositoryIdBefore,
    }]);
    const verificationBefore = verifyPrivateMemoryMcpServiceToken(token.token, {
      audience: PRIVATE_MEMORY_MCP_AUDIENCE,
      resourceIndicator: PRIVATE_MEMORY_MCP_RESOURCE_INDICATOR,
      endpointPath: PRIVATE_MEMORY_MCP_ENDPOINT_PATH,
    });
    expect(verificationBefore.ok).toBe(true);
    if (!verificationBefore.ok) throw new Error("Expected rename test token to verify");
    expect(authorizeMemoryV2Resource({
      principal: verificationBefore.verified.authorization,
      operation: "search",
      plane: "codebase",
      projectId: "project-mcp",
      resourceRowId: v2BindingBefore.resource_row_id,
    }).decision).toBe("allow");

    const httpBefore = await app.inject({
      method: "GET",
      url: "/api/v2/memory/binding",
      headers: { authorization: `Bearer ${token.token}` },
    });
    const mcpBefore = await callMcpTool(token.token, "pim_memory_binding");
    expect(httpBefore.statusCode, httpBefore.body).toBe(200);
    expect(mcpBefore.statusCode, mcpBefore.body).toBe(200);
    const httpBindingBefore = parseMemoryContractV2("MemoryBindingV2", httpBefore.json());
    const mcpBindingBefore = parseMemoryContractV2(
      "MemoryBindingV2",
      mcpBefore.json().result.structuredContent,
    );
    expect(mcpBindingBefore).toEqual(httpBindingBefore);
    expect(httpBindingBefore.resources[0]).toMatchObject({
      resource_row_id: v2BindingBefore.resource_row_id,
      canonical_resource_id: repositoryIdBefore,
    });

    const renamed = renameMemoryRepository({
      orgId,
      providerRepositoryId,
      repositoryId: repositoryIdAfter,
      displaySlug: "Acme/Memory-After-Rename",
    });
    expect(renamed.repository_row_id).toBe(repository.repository_row_id);
    expect(testDb.prepare(
      `SELECT binding_id, repository_row_id, repository_id
       FROM memory_service_token_repository_bindings WHERE token_id = ?`,
    ).get(token.token_id)).toEqual(legacyBindingBefore);
    expect(testDb.prepare(
      `SELECT binding_id, resource_row_id, source_binding_id
       FROM memory_v2_service_token_resource_bindings WHERE token_id = ?`,
    ).get(token.token_id)).toEqual(v2BindingBefore);
    expect(verifyServiceToken(token.token)?.auth.repositoryBindings).toEqual([{
      repositoryRowId: repository.repository_row_id,
      repositoryId: repositoryIdAfter,
    }]);
    const verificationAfter = verifyPrivateMemoryMcpServiceToken(token.token, {
      audience: PRIVATE_MEMORY_MCP_AUDIENCE,
      resourceIndicator: PRIVATE_MEMORY_MCP_RESOURCE_INDICATOR,
      endpointPath: PRIVATE_MEMORY_MCP_ENDPOINT_PATH,
    });
    expect(verificationAfter.ok).toBe(true);
    if (!verificationAfter.ok) throw new Error("Expected renamed test token to verify");
    expect(authorizeMemoryV2Resource({
      principal: verificationAfter.verified.authorization,
      operation: "search",
      plane: "codebase",
      projectId: "project-mcp",
      resourceRowId: v2BindingBefore.resource_row_id,
    }).decision).toBe("allow");

    const httpAfter = await app.inject({
      method: "GET",
      url: "/api/v2/memory/binding",
      headers: { authorization: `Bearer ${token.token}` },
    });
    const mcpAfter = await callMcpTool(token.token, "pim_memory_binding");
    expect(httpAfter.statusCode, httpAfter.body).toBe(200);
    expect(mcpAfter.statusCode, mcpAfter.body).toBe(200);
    const httpBindingAfter = parseMemoryContractV2("MemoryBindingV2", httpAfter.json());
    const mcpBindingAfter = parseMemoryContractV2(
      "MemoryBindingV2",
      mcpAfter.json().result.structuredContent,
    );
    expect(mcpBindingAfter).toEqual(httpBindingAfter);
    expect(httpBindingAfter.resources[0]).toMatchObject({
      resource_row_id: v2BindingBefore.resource_row_id,
      canonical_resource_id: repositoryIdAfter,
    });
  });

  it("keeps bounded readiness private, non-enumerating, and equivalent across HTTP and MCP", async () => {
    const metricStart = metrics.length;
    const logStart = logChunks.length;
    const selector = {
      plane: "codebase" as const,
      resource_selector: { canonical_resource_id: "github.com/acme/memory" },
    };
    const readinessUrl = "/api/v2/memory/readiness"
      + "?plane=codebase&canonical_resource_id=github.com%2Facme%2Fmemory";
    const unauthenticated = await app.inject({
      method: "GET",
      url: readinessUrl,
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers["cache-control"]).toBe("private, no-store");
    expect(unauthenticated.headers.vary).toBe("Authorization");
    const wrongOrg = await app.inject({
      method: "GET",
      url: readinessUrl,
      headers: {
        authorization: `Bearer ${valid.token}`,
        "x-pim-org": "attacker-org",
      },
    });
    expect(wrongOrg.statusCode).toBe(403);
    expect(wrongOrg.headers["cache-control"]).toBe("private, no-store");
    expect(wrongOrg.headers.vary).toBe("Authorization");
    const http = await app.inject({
      method: "GET",
      url: readinessUrl,
      headers: { authorization: `Bearer ${valid.token}` },
    });
    const mcp = await invokeMcpTool(valid.token, "pim_memory_readiness", selector);

    expect(http.statusCode, http.body).toBe(200);
    expect(mcp.statusCode, mcp.body).toBe(200);
    expect(http.headers["cache-control"]).toBe("private, no-store");
    expect(http.headers.vary).toBe("Authorization");
    expect(mcp.headers["cache-control"]).toBe("private, no-store");
    expect(mcp.headers.vary).toBe("Authorization");
    expect(mcp.headers["mcp-session-id"]).toBeUndefined();

    const httpReadiness = parseMemoryContractV2("MemoryReadinessV2", http.json());
    const mcpReadiness = parseMemoryContractV2(
      "MemoryMcpReadinessOutputV2",
      mcp.json().result.structuredContent,
    );
    const withoutCheckTime = ({ checked_at: _checkedAt, ...value }: typeof httpReadiness) => value;
    expect(withoutCheckTime(mcpReadiness)).toEqual(withoutCheckTime(httpReadiness));
    expect(httpReadiness).toMatchObject({
      schema_version: "pim.memory-readiness.v2",
      tenant: { organization_id: orgId, project_id: "project-mcp" },
      plane: "codebase",
      resource_binding: {
        canonical_resource_id: "github.com/acme/memory",
        permitted_operations: expect.arrayContaining(["readiness"]),
      },
      reverification_supported: true,
      status: "healthy",
      worker_status: "disabled",
      fresh_count: 1,
      due_count: 0,
      pending_count: 0,
      dead_letter_count: 0,
    });
    expect(Object.keys(httpReadiness).sort()).toEqual([
      "checked_at",
      "dead_letter_count",
      "due_count",
      "fresh_count",
      "last_success_at",
      "oldest_dead_letter_at",
      "oldest_due_at",
      "pending_count",
      "plane",
      "resource_binding",
      "reverification_supported",
      "schema_version",
      "status",
      "tenant",
      "worker_status",
    ]);
    expect(JSON.stringify({ http: http.json(), mcp: mcp.json() }))
      .not.toMatch(/raw_jobs|job_attempt|evidence_bod|admin_control|mutation|scheduler_control/i);
    expect(JSON.stringify({ http: http.json(), mcp: mcp.json() })).not.toContain(valid.token);
    expect(JSON.stringify({ http: http.json(), mcp: mcp.json() })).not.toContain(valid.token_id);

    const previousEnabled = process.env.MEMORY_V2_REVERIFICATION_ENABLED;
    process.env.MEMORY_V2_REVERIFICATION_ENABLED = "1";
    try {
      const enabledHttp = await app.inject({
        method: "GET",
        url: readinessUrl,
        headers: { authorization: `Bearer ${valid.token}` },
      });
      const enabledMcp = await invokeMcpTool(valid.token, "pim_memory_readiness", selector);
      expect(enabledHttp.json()).toMatchObject({
        status: "degraded",
        worker_status: "running",
      });
      expect(enabledMcp.json().result.structuredContent).toMatchObject({
        status: "degraded",
        worker_status: "running",
      });
    } finally {
      if (previousEnabled === undefined) {
        delete process.env.MEMORY_V2_REVERIFICATION_ENABLED;
      } else {
        process.env.MEMORY_V2_REVERIFICATION_ENABLED = previousEnabled;
      }
    }

    const deniedUrl = (canonicalResourceId: string) => (
      "/api/v2/memory/readiness?plane=codebase&canonical_resource_id="
      + encodeURIComponent(canonicalResourceId)
    );
    const deniedHttp = await app.inject({
      method: "GET",
      url: deniedUrl("github.com/other/private"),
      headers: { authorization: `Bearer ${valid.token}` },
    });
    const missingHttp = await app.inject({
      method: "GET",
      url: deniedUrl("github.com/missing/random"),
      headers: { authorization: `Bearer ${valid.token}` },
    });
    const deniedMcp = await invokeMcpTool(valid.token, "pim_memory_readiness", {
      ...selector,
      resource_selector: { canonical_resource_id: "github.com/other/private" },
    });
    const missingMcp = await invokeMcpTool(valid.token, "pim_memory_readiness", {
      ...selector,
      resource_selector: { canonical_resource_id: "github.com/missing/random" },
    });
    expect(deniedHttp.statusCode).toBe(403);
    expect(missingHttp.statusCode).toBe(403);
    expect(deniedHttp.json()).toEqual(missingHttp.json());
    expect(deniedMcp.json().result.structuredContent)
      .toEqual(missingMcp.json().result.structuredContent);
    const boundedError = (value: {
      code: string;
      plane: string | null;
      retryable: boolean;
      details: unknown[];
    }) => ({
      code: value.code,
      plane: value.plane,
      retryable: value.retryable,
      details: value.details,
    });
    expect(boundedError(deniedMcp.json().result.structuredContent)).toEqual(
      boundedError(deniedHttp.json()),
    );
    expect(boundedError(deniedHttp.json())).toMatchObject({
      code: "resource_binding_mismatch",
      plane: "codebase",
      retryable: false,
    });

    const scopeDenied = await app.inject({
      method: "GET",
      url: deniedUrl("github.com/acme/memory"),
      headers: { authorization: `Bearer ${withoutCodeSearch.token}` },
    });
    expect(scopeDenied.statusCode).toBe(403);
    expect(scopeDenied.json()).toMatchObject({
      code: "scope_required",
      plane: "codebase",
      retryable: false,
    });
    const receiptOnlyTools = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("tools/list", "pim-memory", withoutCodeSearch.token),
      payload: mcpPayload("tools/list", "pim-memory", { _meta: clientMeta }),
    });
    expect(receiptOnlyTools.json().result.tools.map((tool: { name: string }) => tool.name))
      .not.toContain("pim_memory_readiness");

    const malformedSecret = "readiness-query-secret-must-not-leak";
    const malformedHttp = await app.inject({
      method: "GET",
      url: deniedUrl("github.com/acme/memory")
        + `&unexpected=${encodeURIComponent(malformedSecret)}`,
      headers: { authorization: `Bearer ${valid.token}` },
    });
    const malformedMcp = await invokeMcpTool(valid.token, "pim_memory_readiness", {
      ...selector,
      unexpected: malformedSecret,
    });
    expect(malformedHttp.statusCode).toBe(400);
    expect(malformedHttp.json()).toMatchObject({ code: "schema_invalid", retryable: false });
    expect(malformedMcp.json().result.structuredContent)
      .toMatchObject({ code: "schema_invalid", plane: "codebase", retryable: false });
    expect(JSON.stringify({ malformedHttp: malformedHttp.json(), malformedMcp: malformedMcp.json() }))
      .not.toContain(malformedSecret);

    const readinessOutcomes = metrics.slice(metricStart)
      .filter((metric) => metric.name === "MemoryOperationOutcome"
        && metric.dimensions?.operation === "readiness")
      .map((metric) => metric.dimensions);
    expect(readinessOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        transport: "direct_http",
        operation: "readiness",
        plane: "codebase",
        outcome: "success",
        reason: "completed",
      }),
      expect.objectContaining({
        transport: "direct_http",
        operation: "readiness",
        plane: "codebase",
        outcome: "deny",
        reason: "resource_binding_mismatch",
      }),
      expect.objectContaining({
        transport: "mcp",
        operation: "readiness",
        plane: "codebase",
        outcome: "success",
        reason: "completed",
      }),
      expect.objectContaining({
        transport: "mcp",
        operation: "readiness",
        outcome: "deny",
        reason: "resource_binding_mismatch",
      }),
    ]));
    const audit = logChunks.slice(logStart).join("");
    expect(audit).toContain('"operation":"readiness"');
    expect(audit).not.toContain(valid.token);
    expect(audit).not.toContain(malformedSecret);
    expect(audit).not.toContain("FST_ERR_REP_ALREADY_SENT");
  });

  it("authorization-filters discovery to current code operations without enumerable resources", async () => {
    const tools = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("tools/list", "pim-memory", valid.token),
      payload: mcpPayload("tools/list", "pim-memory", { _meta: clientMeta }),
    });
    expect(tools.statusCode, tools.body).toBe(200);
    const toolNames = tools.json().result.tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toEqual([
      "pim_memory_capabilities",
      "pim_memory_binding",
      "pim_code_memory_search",
      "pim_run_receipt_submit",
      "pim_memory_readiness",
    ]);
    expect(toolNames.some((name: string) => (
      /exposure|policy|gate|canary|kill_switch/.test(name)
    ))).toBe(false);

    const resources = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("resources/list", "pim-memory", valid.token),
      payload: mcpPayload("resources/list", "pim-memory", { _meta: clientMeta }),
    });
    expect(resources.statusCode, resources.body).toBe(200);
    expect(resources.json().result.resources).toEqual([]);
    expect(resources.json().result).toMatchObject({ ttlMs: 0, cacheScope: "private" });

    const templates = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("resources/templates/list", "pim-memory", valid.token),
      payload: mcpPayload("resources/templates/list", "pim-memory", { _meta: clientMeta }),
    });
    expect(templates.statusCode, templates.body).toBe(200);
    expect(templates.json().result.resourceTemplates.map((template: { uriTemplate: string }) => (
      template.uriTemplate
    ))).toEqual([
      "pim-memory://records/{record_id}/versions/{version}",
      "pim-memory://packs/{pack_id}",
    ]);
    expect(templates.json().result).toMatchObject({ ttlMs: 0, cacheScope: "private" });

    const receiptOnlyTools = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("tools/list", "pim-memory", withoutCodeSearch.token),
      payload: mcpPayload("tools/list", "pim-memory", { _meta: clientMeta }),
    });
    expect(receiptOnlyTools.statusCode, receiptOnlyTools.body).toBe(200);
    expect(receiptOnlyTools.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "pim_memory_capabilities",
      "pim_memory_binding",
      "pim_run_receipt_submit",
    ]);

    const receiptOnlyTemplates = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("resources/templates/list", "pim-memory", withoutCodeSearch.token),
      payload: mcpPayload("resources/templates/list", "pim-memory", { _meta: clientMeta }),
    });
    expect(receiptOnlyTemplates.statusCode, receiptOnlyTemplates.body).toBe(200);
    expect(receiptOnlyTemplates.json().result.resourceTemplates).toEqual([]);
  });

  it("authorization-filters exact-harness search and immutable detail without crossing code selectors", async () => {
    const metricStart = metrics.length;
    const logStart = logChunks.length;
    const recordId = "memory-mcp-slice4-harness-record";
    seedSlice4HarnessRecord(recordId);

    const tools = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("tools/list", "pim-memory", harnessSearchOnly.token),
      payload: mcpPayload("tools/list", "pim-memory", { _meta: clientMeta }),
    });
    expect(tools.statusCode, tools.body).toBe(200);
    expect(tools.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "pim_memory_capabilities",
      "pim_memory_binding",
      "pim_harness_memory_search",
      "pim_memory_readiness",
    ]);

    const templates = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("resources/templates/list", "pim-memory", harnessSearchOnly.token),
      payload: mcpPayload("resources/templates/list", "pim-memory", { _meta: clientMeta }),
    });
    expect(templates.statusCode, templates.body).toBe(200);
    expect(templates.json().result.resourceTemplates.map(
      (template: { uriTemplate: string }) => template.uriTemplate,
    )).toEqual([
      "pim-memory://records/{record_id}/versions/{version}",
      "pim-memory://packs/{pack_id}",
    ]);

    const searchInput = {
      ...structuredClone(MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpHarnessSearchInputV2),
      request_id: "slice4-mcp-harness-search-1",
      consumer: {
        ...MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpHarnessSearchInputV2.consumer,
        harness_id: "example-harness-a",
        adapter_version: "example-harness-a-pim-adapter.v2",
      },
      resource_selector: { canonical_resource_id: "example-harness-a" },
      applicability: {
        ...MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpHarnessSearchInputV2.applicability,
        harness_id: "example-harness-a",
        adapter_version_range: "example-harness-a-pim-adapter.v2",
        configuration_digests: [],
      },
    };
    const searched = await invokeMcpTool(
      harnessSearchOnly.token,
      "pim_harness_memory_search",
      searchInput,
    );
    expect(searched.statusCode, searched.body).toBe(200);
    const searchResult = parseMemoryContractV2(
      "MemorySearchResultV2",
      searched.json().result.structuredContent,
    );
    expect(searchResult).toMatchObject({
      request_id: searchInput.request_id,
      plane: "harness",
      resource_binding: {
        plane: "harness",
        resource_type: "harness",
        canonical_resource_id: "example-harness-a",
      },
    });
    expect(searchResult.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        record_id: recordId,
        record_version: 1,
        plane: "harness",
      }),
    ]));

    const recordUri = `pim-memory://records/${encodeURIComponent(recordId)}/versions/1`;
    const recordRead = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("resources/read", recordUri, harnessSearchOnly.token),
      payload: mcpPayload("resources/read", recordUri, {
        uri: recordUri,
        _meta: clientMeta,
      }),
    });
    expect(recordRead.statusCode, recordRead.body).toBe(200);
    const record = JSON.parse(recordRead.json().result.contents[0].text);
    expect(record).toMatchObject({
      schema_version: "pim.memory-record.v2",
      record_id: recordId,
      record_version: 1,
      plane: "harness",
      subkind: "failure_pattern",
    });

    const packUri = `pim-memory://packs/${encodeURIComponent(searchResult.retrieval_pack_id)}`;
    const packRead = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("resources/read", packUri, harnessSearchOnly.token),
      payload: mcpPayload("resources/read", packUri, {
        uri: packUri,
        _meta: clientMeta,
      }),
    });
    expect(packRead.statusCode, packRead.body).toBe(200);
    const pack = JSON.parse(packRead.json().result.contents[0].text);
    expect(pack).toMatchObject({
      schema_version: "pim.memory-retrieval-pack.v2",
      retrieval_pack_id: searchResult.retrieval_pack_id,
      plane: "harness",
      resource_binding: { canonical_resource_id: "example-harness-a" },
    });

    const dualPlane = createPrivateMemoryMcpServiceToken({
      orgId,
      name: "dual-plane-read-dispatch-private-memory-mcp",
      scopes: ["memory:search", "memory:harness:search"],
      createdByUserId: ownerUserId,
      projectId: "project-mcp",
      repositoryIds: ["github.com/acme/memory"],
      harnessIds: ["example-harness-a"],
      expiresAt: futureExpiry(),
    });
    const dualHarnessRecord = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("resources/read", recordUri, dualPlane.token),
      payload: mcpPayload("resources/read", recordUri, { uri: recordUri, _meta: clientMeta }),
    });
    const dualHarnessPack = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("resources/read", packUri, dualPlane.token),
      payload: mcpPayload("resources/read", packUri, { uri: packUri, _meta: clientMeta }),
    });
    expect(JSON.parse(dualHarnessRecord.json().result.contents[0].text).plane).toBe("harness");
    expect(JSON.parse(dualHarnessPack.json().result.contents[0].text).plane).toBe("harness");

    const dualCodeInput = {
      ...structuredClone(MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2),
      request_id: "slice4-mcp-dual-plane-code-search-1",
      resource_selector: { canonical_resource_id: "github.com/acme/memory" },
      applicability: {
        ...MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2.applicability,
        repository_id: "github.com/acme/memory",
      },
    };
    const dualCodeSearch = await invokeMcpTool(
      dualPlane.token,
      "pim_code_memory_search",
      dualCodeInput,
    );
    expect(dualCodeSearch.statusCode, dualCodeSearch.body).toBe(200);
    const dualCodeResult = parseMemoryContractV2(
      "MemorySearchResultV2",
      dualCodeSearch.json().result.structuredContent,
    );
    expect(dualCodeResult.plane).toBe("codebase");
    const dualCodeRecordUri = `pim-memory://records/${encodeURIComponent(seededRecordId)}/versions/1`;
    const dualCodePackUri = `pim-memory://packs/${encodeURIComponent(dualCodeResult.retrieval_pack_id)}`;
    const [dualCodeRecord, dualCodePack] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/mcp/memory",
        headers: mcpHeaders("resources/read", dualCodeRecordUri, dualPlane.token),
        payload: mcpPayload("resources/read", dualCodeRecordUri, {
          uri: dualCodeRecordUri,
          _meta: clientMeta,
        }),
      }),
      app.inject({
        method: "POST",
        url: "/mcp/memory",
        headers: mcpHeaders("resources/read", dualCodePackUri, dualPlane.token),
        payload: mcpPayload("resources/read", dualCodePackUri, {
          uri: dualCodePackUri,
          _meta: clientMeta,
        }),
      }),
    ]);
    expect(JSON.parse(dualCodeRecord.json().result.contents[0].text).plane).toBe("codebase");
    expect(JSON.parse(dualCodePack.json().result.contents[0].text).plane).toBe("codebase");

    const deniedHarnessRecord = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("resources/read", recordUri, valid.token),
      payload: mcpPayload("resources/read", recordUri, { uri: recordUri, _meta: clientMeta }),
    });
    const missingRecordUri = "pim-memory://records/memory-mcp-slice4-missing/versions/1";
    const missingHarnessRecord = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("resources/read", missingRecordUri, valid.token),
      payload: mcpPayload("resources/read", missingRecordUri, {
        uri: missingRecordUri,
        _meta: clientMeta,
      }),
    });
    expect(deniedHarnessRecord.json().error).toMatchObject({
      code: -32602,
      data: {
        code: "resource_not_found",
        plane: null,
      },
    });
    expect(missingHarnessRecord.json().error).toEqual(deniedHarnessRecord.json().error);

    const deniedHarnessPack = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("resources/read", packUri, valid.token),
      payload: mcpPayload("resources/read", packUri, { uri: packUri, _meta: clientMeta }),
    });
    const missingPackUri = "pim-memory://packs/memory-mcp-slice4-missing-pack";
    const missingHarnessPack = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("resources/read", missingPackUri, valid.token),
      payload: mcpPayload("resources/read", missingPackUri, {
        uri: missingPackUri,
        _meta: clientMeta,
      }),
    });
    expect(deniedHarnessPack.json().error).toMatchObject({
      code: -32602,
      data: {
        code: "resource_not_found",
        plane: null,
      },
    });
    expect(missingHarnessPack.json().error).toEqual(deniedHarnessPack.json().error);
    expect(deniedHarnessPack.json().result).toBeUndefined();
    expect(missingHarnessPack.json().result).toBeUndefined();

    const codeTool = await invokeMcpTool(
      harnessSearchOnly.token,
      "pim_code_memory_search",
      MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2,
    );
    expect(codeTool.json().error.code).toBe(-32602);

    const wrongVersion = await invokeMcpTool(
      harnessSearchOnly.token,
      "pim_harness_memory_search",
      { ...searchInput, schema_version: "pim.memory-search.v1" },
    );
    expect(wrongVersion.json().result).toMatchObject({
      isError: true,
      structuredContent: {
        code: "contract_version_unsupported",
        request_id: searchInput.request_id,
        plane: "harness",
      },
    });

    const codeResource = resolveMemoryV2Resource({
      orgId,
      projectId: "project-mcp",
      plane: "codebase",
      canonicalResourceId: "github.com/acme/memory",
    })!;
    const crossing = await invokeMcpTool(
      harnessSearchOnly.token,
      "pim_harness_memory_search",
      {
        ...searchInput,
        request_id: "slice4-mcp-harness-crossing-1",
        resource_selector: { resource_row_id: codeResource.resourceRowId },
      },
    );
    expect(crossing.json().result).toMatchObject({
      isError: true,
      structuredContent: {
        code: "resource_not_found",
        plane: "harness",
      },
    });

    const outcomes = metrics.slice(metricStart)
      .filter((metric) => metric.name === "SearchOutcome")
      .map((metric) => metric.dimensions);
    expect(outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        transport: "mcp",
        operation: "harness_search",
        plane: "harness",
        resource_type: "harness",
        contract_version: "pim.memory.v2",
        outcome: "success",
        reason: "completed",
      }),
      expect.objectContaining({
        transport: "mcp",
        operation: "record_read",
        plane: "harness",
        outcome: "success",
      }),
      expect.objectContaining({
        transport: "mcp",
        operation: "pack_read",
        plane: "harness",
        outcome: "success",
      }),
      expect.objectContaining({
        transport: "mcp",
        operation: "harness_search",
        plane: "harness",
        outcome: "deny",
        reason: "contract_version_unsupported",
      }),
      expect.objectContaining({
        transport: "mcp",
        operation: "harness_search",
        plane: "harness",
        outcome: "deny",
        reason: "resource_not_found",
      }),
    ]));
    for (const latency of metrics.slice(metricStart).filter((metric) => (
      metric.name === "SearchLatency"
    ))) {
      expect(latency.unit).toBe("Milliseconds");
      expect(Number.isFinite(latency.value)).toBe(true);
      expect(latency.value).toBeGreaterThanOrEqual(0);
      expect(latency.value).toBeLessThan(5_000);
    }
    const audit = logChunks.slice(logStart).join("");
    expect(audit).toContain('"operation":"harness_search"');
    expect(audit).toContain('"plane":"harness"');
    expect(audit).not.toContain(harnessSearchOnly.token);
  });

  it("keeps real HTTP and MCP code-search results aligned and reauthorizes immutable MCP reads", async () => {
    const token = createPrivate("slice-2-transport-acceptance");
    const metricStart = metrics.length;
    const requestId = "slice-2-transport-acceptance-1";
    const mcpInput = {
      ...structuredClone(MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2),
      request_id: requestId,
      resource_selector: { canonical_resource_id: "github.com/acme/memory" },
      applicability: {
        ...MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2.applicability,
        repository_id: "github.com/acme/memory",
      },
    };

    try {
      const http = await app.inject({
        method: "POST",
        url: "/api/v2/memory/search",
        headers: { authorization: `Bearer ${token.token}` },
        payload: {
          ...mcpInput,
          tenant: { project_id: "project-mcp" },
        },
      });
      expect(http.statusCode, http.body).toBe(200);
      expect(http.headers["cache-control"]).toBe("private, no-store");
      expect(http.headers.vary).toBe("Authorization");
      const httpResult = parseMemoryContractV2("MemorySearchResultV2", http.json());

      const mcp = await app.inject({
        method: "POST",
        url: "/mcp/memory",
        headers: mcpHeaders("tools/call", "pim_code_memory_search", token.token),
        payload: mcpPayload("tools/call", "pim_code_memory_search", {
          name: "pim_code_memory_search",
          arguments: mcpInput,
          _meta: clientMeta,
        }),
      });
      expect(mcp.statusCode, mcp.body).toBe(200);
      expect(mcp.headers["cache-control"]).toBe("private, no-store");
      expect(mcp.headers.vary).toBe("Authorization");
      expect(mcp.json().result.isError).not.toBe(true);
      const mcpResult = parseMemoryContractV2(
        "MemorySearchResultV2",
        mcp.json().result.structuredContent,
      );
      const normalizedItems = (result: typeof httpResult) => result.items.map((item, order) => ({
        order,
        record_id: item.record_id,
        record_version: item.record_version,
        match_reasons: item.match_reasons,
      }));

      expect(normalizedItems(mcpResult)).toEqual(normalizedItems(httpResult));
      expect(mcpResult).toMatchObject({
        retrieval_pack_id: httpResult.retrieval_pack_id,
        token_count: httpResult.token_count,
        omitted_count: httpResult.omitted_count,
      });
      expect(mcpResult.items).toHaveLength(httpResult.items.length);
      expect(mcpResult.items[0]).toMatchObject({
        record_id: seededRecordId,
        record_version: 1,
      });
      expect(testDb.prepare(
        "SELECT COUNT(*) AS count FROM memory_v2_retrieval_packs WHERE request_id = ?",
      ).get(requestId)).toEqual({ count: 1 });

      const recordUri = `pim-memory://records/${encodeURIComponent(seededRecordId)}/versions/1`;
      const packUri = `pim-memory://packs/${encodeURIComponent(mcpResult.retrieval_pack_id)}`;
      const readResource = (uri: string) => app.inject({
        method: "POST",
        url: "/mcp/memory",
        headers: mcpHeaders("resources/read", uri, token.token),
        payload: mcpPayload("resources/read", uri, { uri, _meta: clientMeta }),
      });

      const [recordRead, packRead] = await Promise.all([
        readResource(recordUri),
        readResource(packUri),
      ]);
      expect(recordRead.statusCode, recordRead.body).toBe(200);
      expect(packRead.statusCode, packRead.body).toBe(200);
      const record = parseMemoryContractV2(
        "MemoryRecordV2",
        JSON.parse(recordRead.json().result.contents[0].text),
      );
      const pack = parseMemoryContractV2(
        "MemoryRetrievalPackV2",
        JSON.parse(packRead.json().result.contents[0].text),
      );
      expect(record).toMatchObject({
        record_id: seededRecordId,
        record_version: 1,
        resource_binding: mcpResult.resource_binding,
      });
      expect(pack).toMatchObject({
        retrieval_pack_id: mcpResult.retrieval_pack_id,
        request_id: requestId,
        token_count: mcpResult.token_count,
        omitted_count: mcpResult.omitted_count,
      });
      expect(pack.items.map((item) => ({
        record_id: item.record_id,
        record_version: item.record_version,
        match_reasons: item.match_reasons,
      }))).toEqual(normalizedItems(mcpResult).map(({ order: _order, ...item }) => item));

      const conflict = await app.inject({
        method: "POST",
        url: "/mcp/memory",
        headers: mcpHeaders("tools/call", "pim_code_memory_search", token.token),
        payload: mcpPayload("tools/call", "pim_code_memory_search", {
          name: "pim_code_memory_search",
          arguments: {
            ...mcpInput,
            task: { ...mcpInput.task, query: `${mcpInput.task.query} changed` },
          },
          _meta: clientMeta,
        }),
      });
      expect(conflict.statusCode, conflict.body).toBe(200);
      expect(conflict.json().result).toMatchObject({
        isError: true,
        structuredContent: {
          code: "idempotency_conflict",
          request_id: requestId,
          plane: "codebase",
        },
      });
      expect(testDb.prepare(
        "SELECT COUNT(*) AS count FROM memory_v2_retrieval_packs WHERE request_id = ?",
      ).get(requestId)).toEqual({ count: 1 });

      const outcomes = metrics.slice(metricStart)
        .filter((metric) => metric.name === "SearchOutcome")
        .map((metric) => metric.dimensions);
      expect(outcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          transport: "direct_http",
          operation: "search",
          plane: "codebase",
          resource_type: "repository",
          contract_version: "pim.memory.v2",
          outcome: "success",
          reason: "completed",
        }),
        expect.objectContaining({
          transport: "mcp",
          operation: "code_search",
          plane: "codebase",
          resource_type: "repository",
          contract_version: "pim.memory.v2",
          outcome: "success",
          reason: "completed",
        }),
        expect.objectContaining({
          transport: "mcp",
          operation: "record_read",
          outcome: "success",
          reason: "completed",
        }),
        expect.objectContaining({
          transport: "mcp",
          operation: "pack_read",
          outcome: "success",
          reason: "completed",
        }),
        expect.objectContaining({
          transport: "mcp",
          operation: "code_search",
          outcome: "deny",
          reason: "idempotency_conflict",
        }),
      ]));
      for (const latency of metrics.slice(metricStart).filter((metric) => (
        metric.name === "SearchLatency"
      ))) {
        expect(latency.unit).toBe("Milliseconds");
        expect(Number.isFinite(latency.value)).toBe(true);
        expect(latency.value).toBeGreaterThanOrEqual(0);
        expect(latency.value).toBeLessThan(5_000);
      }

      expect(revokeServiceToken(orgId, token.token_id)).toBe(true);
      const [revokedRecordRead, revokedPackRead] = await Promise.all([
        readResource(recordUri),
        readResource(packUri),
      ]);
      for (const denied of [revokedRecordRead, revokedPackRead]) {
        expect(denied.statusCode).toBe(401);
        expect(denied.json()).toMatchObject({
          error: { code: -32001 },
          id: null,
        });
      }
    } finally {
      revokeServiceToken(orgId, token.token_id);
      metrics.splice(metricStart);
    }
  });

  it("keeps real HTTP-v2 and restricted-MCP harness search conformant", async () => {
    const metricStart = metrics.length;
    const logStart = logChunks.length;
    const recordId = "memory-mcp-slice4-harness-parity-record";
    seedSlice4HarnessRecord(recordId);
    const source = structuredClone(MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpHarnessSearchInputV2);
    const common = {
      ...source,
      consumer: {
        ...source.consumer,
        harness_id: "example-harness-a",
        adapter_version: "example-harness-a-pim-adapter.v2",
      },
      applicability: {
        ...source.applicability,
        harness_id: "example-harness-a",
        adapter_version_range: "example-harness-a-pim-adapter.v2",
      },
    };
    const httpRequestId = "slice4-harness-parity-http";
    const mcpRequestId = "slice4-harness-parity-mcp";
    const httpInput = {
      ...common,
      request_id: httpRequestId,
      tenant: { project_id: "project-mcp" },
      resource_selector: { canonical_resource_id: "example-harness-a" },
      applicability: { ...common.applicability, configuration_digests: [] },
    };
    const mcpInput = {
      ...common,
      request_id: mcpRequestId,
      resource_selector: { canonical_resource_id: "example-harness-a" },
      applicability: { ...common.applicability, configuration_digests: [] },
    };

    const httpStartedAt = performance.now();
    const http = await app.inject({
      method: "POST",
      url: "/api/v2/memory/search",
      headers: { authorization: `Bearer ${harnessSearchOnly.token}` },
      payload: httpInput,
    });
    const httpElapsedMs = performance.now() - httpStartedAt;
    expect(http.statusCode, http.body).toBe(200);
    const httpResult = parseMemoryContractV2("MemorySearchResultV2", http.json());

    const mcpStartedAt = performance.now();
    const mcp = await invokeMcpTool(
      harnessSearchOnly.token,
      "pim_harness_memory_search",
      mcpInput,
    );
    const mcpElapsedMs = performance.now() - mcpStartedAt;
    expect(mcp.statusCode, mcp.body).toBe(200);
    expect(mcp.json().result.isError).not.toBe(true);
    const mcpResult = parseMemoryContractV2(
      "MemorySearchResultV2",
      mcp.json().result.structuredContent,
    );
    const normalized = (result: typeof httpResult) => ({
      items: result.items.map((item) => ({
        record_id: item.record_id,
        record_version: item.record_version,
        match_reasons: item.match_reasons,
      })),
      token_count: result.token_count,
      omitted_count: result.omitted_count,
    });
    expect(normalized(mcpResult)).toEqual(normalized(httpResult));
    expect(httpResult.items.length).toBeGreaterThan(0);
    expect([httpElapsedMs, mcpElapsedMs].every((value) => (
      Number.isFinite(value) && value >= 0 && value < 5_000
    ))).toBe(true);

    expect(testDb.prepare(
      `SELECT request_id, plane
       FROM memory_v2_retrieval_packs WHERE request_id IN (?, ?)
       ORDER BY request_id`,
    ).all(httpRequestId, mcpRequestId)).toEqual([
      { request_id: httpRequestId, plane: "harness" },
      { request_id: mcpRequestId, plane: "harness" },
    ]);

    const packsBeforeDenials = (testDb.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_retrieval_packs",
    ).get() as { count: number }).count;
    const deniedHttpId = "slice4-harness-parity-http-unbound";
    const deniedMcpId = "slice4-harness-parity-mcp-unbound";
    const unboundSelector = { canonical_resource_id: "unbound-harness" };
    const deniedHttp = await app.inject({
      method: "POST",
      url: "/api/v2/memory/search",
      headers: { authorization: `Bearer ${harnessSearchOnly.token}` },
      payload: { ...httpInput, request_id: deniedHttpId, resource_selector: unboundSelector },
    });
    const deniedMcp = await invokeMcpTool(
      harnessSearchOnly.token,
      "pim_harness_memory_search",
      { ...mcpInput, request_id: deniedMcpId, resource_selector: unboundSelector },
    );
    expect(deniedHttp.statusCode, deniedHttp.body).toBe(404);
    expect(deniedMcp.statusCode, deniedMcp.body).toBe(200);
    expect(deniedMcp.json().result.isError).toBe(true);
    const errorShape = (error: {
      code: string;
      plane: string | null;
      retryable: boolean;
      details: unknown[];
    }) => ({
      code: error.code,
      plane: error.plane,
      retryable: error.retryable,
      details: error.details,
    });
    expect(errorShape(deniedMcp.json().result.structuredContent))
      .toEqual(errorShape(deniedHttp.json()));
    expect(errorShape(deniedHttp.json())).toEqual({
      code: "resource_not_found",
      plane: "harness",
      retryable: false,
      details: [],
    });
    expect((testDb.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_retrieval_packs",
    ).get() as { count: number }).count).toBe(packsBeforeDenials);
    expect(testDb.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_retrieval_packs WHERE request_id IN (?, ?)",
    ).get(deniedHttpId, deniedMcpId)).toEqual({ count: 0 });

    const transportMetrics = metrics.slice(metricStart).filter((metric) => (
      (metric.name === "SearchOutcome" || metric.name === "SearchLatency")
      && (metric.dimensions?.operation === "search"
        || metric.dimensions?.operation === "harness_search")
    ));
    const dimensionKeys = [
      "contract_version", "operation", "outcome", "plane",
      "reason", "resource_type", "status", "transport",
    ];
    expect(transportMetrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "SearchOutcome", dimensions: expect.objectContaining({
        transport: "direct_http", operation: "search", outcome: "success",
      }) }),
      expect.objectContaining({ name: "SearchOutcome", dimensions: expect.objectContaining({
        transport: "mcp", operation: "harness_search", outcome: "success",
      }) }),
      expect.objectContaining({ name: "SearchOutcome", dimensions: expect.objectContaining({
        transport: "direct_http", operation: "search", outcome: "rejected",
        reason: "resource_not_found",
      }) }),
      expect.objectContaining({ name: "SearchOutcome", dimensions: expect.objectContaining({
        transport: "mcp", operation: "harness_search", outcome: "deny",
        reason: "resource_not_found",
      }) }),
    ]));
    for (const metric of transportMetrics) {
      expect(Object.keys(metric.dimensions ?? {}).sort()).toEqual(dimensionKeys);
      expect(metric.dimensions).toMatchObject({
        plane: "harness",
        resource_type: "harness",
        contract_version: "pim.memory.v2",
      });
      if (metric.name === "SearchLatency") {
        expect(metric.value).toBeGreaterThanOrEqual(0);
        expect(metric.value).toBeLessThan(5_000);
      }
    }
    const audit = logChunks.slice(logStart).join("");
    expect(audit).toContain('"event":"memory_mcp_access"');
    expect(audit).toContain('"operation":"harness_search"');
    expect(audit).not.toContain(harnessSearchOnly.token);
    expect(audit.toLowerCase()).not.toContain("authorization");
    expect(audit).not.toContain(common.task.query);
  });

  it("keeps bounded schema errors aligned between HTTP and MCP code search", async () => {
    const requestId = "slice-2-schema-error-parity";
    const input = {
      ...structuredClone(MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2),
      request_id: requestId,
      resource_selector: { canonical_resource_id: "github.com/acme/memory" },
      applicability: {
        ...MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2.applicability,
        repository_id: "github.com/acme/memory",
        base_sha: null,
      },
    };

    const http = await app.inject({
      method: "POST",
      url: "/api/v2/memory/search",
      headers: { authorization: `Bearer ${valid.token}` },
      payload: { ...input, tenant: { project_id: "project-mcp" } },
    });
    const mcp = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("tools/call", "pim_code_memory_search", valid.token),
      payload: mcpPayload("tools/call", "pim_code_memory_search", {
        name: "pim_code_memory_search",
        arguments: input,
        _meta: clientMeta,
      }),
    });

    expect(http.statusCode, http.body).toBe(400);
    expect(mcp.statusCode, mcp.body).toBe(200);
    const httpError = parseMemoryContractV2("PimErrorV2", http.json());
    const mcpError = parseMemoryContractV2(
      "PimErrorV2",
      mcp.json().result.structuredContent,
    );
    expect(mcp.json().result.isError).toBe(true);
    expect(mcpError).toMatchObject({
      code: httpError.code,
      request_id: httpError.request_id,
      plane: httpError.plane,
      retryable: httpError.retryable,
      details: httpError.details,
    });
    expect(httpError).toMatchObject({
      code: "schema_invalid",
      request_id: requestId,
      plane: "codebase",
      retryable: false,
      details: expect.arrayContaining([
        expect.objectContaining({ path: "/applicability/base_sha" }),
      ]),
    });
    expect(testDb.prepare(
      "SELECT COUNT(*) AS count FROM memory_v2_retrieval_packs WHERE request_id = ?",
    ).get(requestId)).toEqual({ count: 0 });
  });

  it("omits a facetless code record consistently over both real v2 transports", async () => {
    const facet = testDb.prepare(
      `SELECT * FROM memory_v2_record_facets
       WHERE record_id = ? AND record_version = 1`,
    ).get(seededRecordId) as Record<string, string | number | null>;
    testDb.prepare(
      "DELETE FROM memory_v2_record_facets WHERE record_id = ? AND record_version = 1",
    ).run(seededRecordId);
    const baseInput = {
      ...structuredClone(MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2),
      resource_selector: { canonical_resource_id: "github.com/acme/memory" },
      applicability: {
        ...MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2.applicability,
        repository_id: "github.com/acme/memory",
      },
    };
    const httpRequestId = "slice-2-facetless-http";
    const mcpRequestId = "slice-2-facetless-mcp";
    try {
      const http = await app.inject({
        method: "POST",
        url: "/api/v2/memory/search",
        headers: { authorization: `Bearer ${valid.token}` },
        payload: {
          ...baseInput,
          request_id: httpRequestId,
          tenant: { project_id: "project-mcp" },
        },
      });
      expect(http.statusCode, http.body).toBe(200);
      expect(http.json()).toMatchObject({
        schema_version: "pim.memory-search-result.v2",
        request_id: httpRequestId,
        items: [],
      });

      const mcp = await app.inject({
        method: "POST",
        url: "/mcp/memory",
        headers: mcpHeaders("tools/call", "pim_code_memory_search", valid.token),
        payload: mcpPayload("tools/call", "pim_code_memory_search", {
          name: "pim_code_memory_search",
          arguments: { ...baseInput, request_id: mcpRequestId },
          _meta: clientMeta,
        }),
      });
      expect(mcp.statusCode, mcp.body).toBe(200);
      expect(mcp.json().result).toMatchObject({
        structuredContent: {
          schema_version: "pim.memory-search-result.v2",
          request_id: mcpRequestId,
          items: [],
        },
      });
      expect(testDb.prepare(
        `SELECT COUNT(*) AS count FROM memory_v2_retrieval_packs
         WHERE request_id IN (?, ?)`,
      ).get(httpRequestId, mcpRequestId)).toEqual({ count: 2 });
    } finally {
      testDb.prepare(
        `INSERT INTO memory_v2_record_facets
           (record_id, record_version, org_id, project_id, plane, resource_row_id,
            broad_kind, subtype, projection_status, facet_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        facet.record_id,
        facet.record_version,
        facet.org_id,
        facet.project_id,
        facet.plane,
        facet.resource_row_id,
        facet.broad_kind,
        facet.subtype,
        facet.projection_status,
        facet.facet_json,
        facet.created_at,
      );
      ensureMemoryV2EvidenceVerifiedTrust({
        recordId: seededRecordId,
        recordVersion: 1,
        orgId,
        projectId: "project-mcp",
        evidenceVerifiedAt: "2026-08-07T17:00:00.000Z",
      });
    }
  });

  it("derives the MCP tenant from auth and classifies bounded code-resource failures", async () => {
    const searchMetricStart = metrics.length;
    const search = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("tools/call", "pim_code_memory_search", valid.token),
      payload: mcpPayload("tools/call", "pim_code_memory_search", {
        name: "pim_code_memory_search",
        arguments: MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2,
        _meta: clientMeta,
      }),
    });
    expect(search.statusCode, search.body).toBe(200);
    expect(search.json().result).toMatchObject({
      isError: true,
      structuredContent: {
        code: "resource_not_found",
        request_id: MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2.request_id,
        plane: "codebase",
      },
    });
    expect(metrics.slice(searchMetricStart).find((metric) => metric.name === "SearchOutcome"))
      .toMatchObject({
        dimensions: {
          transport: "mcp",
          operation: "code_search",
          outcome: "deny",
          reason: "resource_not_found",
        },
      });

    const packMetricStart = metrics.length;
    const missingPackUri = "pim-memory://packs/missing-pack-v2";
    const pack = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("resources/read", missingPackUri, valid.token),
      payload: mcpPayload("resources/read", missingPackUri, {
        uri: missingPackUri,
        _meta: clientMeta,
      }),
    });
    expect(pack.statusCode, pack.body).toBe(200);
    expect(pack.json().error.data).toMatchObject({
      code: "resource_not_found",
      request_id: null,
      plane: null,
    });
    expect(metrics.slice(packMetricStart).find((metric) => metric.name === "SearchOutcome"))
      .toMatchObject({
        dimensions: {
          transport: "mcp",
          operation: "pack_read",
          outcome: "deny",
          reason: "resource_not_found",
        },
      });
    expect(pack.headers["cache-control"]).toBe("private, no-store");
    expect(pack.body).not.toContain(valid.token);
  });
});

describe("Slice-3 restricted MCP code writes", () => {
  it("persists one receipt after an ambiguous response, replays it, conflicts safely, and exposes exact candidate status", async () => {
    const token = createSlice3Private("slice3-mcp-receipt-replay");
    const metricStart = metrics.length;
    const suffix = "receipt-replay-1";
    const producerRunId = `example-harness-a:test:mcp:${suffix}`;
    const baseSha = "e".repeat(40);
    try {
      const tools = await app.inject({
        method: "POST",
        url: "/mcp/memory",
        headers: mcpHeaders("tools/list", "pim-memory", token.token),
        payload: mcpPayload("tools/list", "pim-memory", { _meta: clientMeta }),
      });
      expect(tools.statusCode, tools.body).toBe(200);
      expect(tools.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        "pim_memory_capabilities",
        "pim_memory_binding",
        "pim_code_memory_search",
        "pim_run_receipt_submit",
        "pim_feedback_submit",
        "pim_candidate_status",
        "pim_memory_readiness",
      ]);

      const searchInput = {
        ...structuredClone(MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2),
        request_id: `mcp-slice3-search-${suffix}`,
        consumer: {
          ...MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2.consumer,
          consumer_run_id: producerRunId,
        },
        resource_selector: { canonical_resource_id: "github.com/acme/memory" },
        applicability: {
          ...MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2.applicability,
          repository_id: "github.com/acme/memory",
          base_sha: baseSha,
        },
      };
      const search = await invokeMcpTool(token.token, "pim_code_memory_search", searchInput);
      expect(search.statusCode, search.body).toBe(200);
      expect(search.json().result.isError).not.toBe(true);
      const pack = parseMemoryContractV2(
        "MemorySearchResultV2",
        search.json().result.structuredContent,
      );
      const expectedScopeDigest = canonicalJsonSha256({
        schema_version: "pim.memory-scope-snapshot.codebase.v2",
        plane: "codebase",
        resource_binding: pack.resource_binding,
        repository_id: "github.com/acme/memory",
        base_sha: baseSha,
      });
      expect(pack.scope_snapshot_digest).toBe(expectedScopeDigest);

      const receiptInput = slice3ReceiptInput({
        suffix,
        producerRunId,
        resourceBinding: pack.resource_binding,
        baseSha,
        scopeSnapshotDigest: expectedScopeDigest,
      });
      const canonicalRecordCountBefore = (testDb.prepare(
        "SELECT COUNT(*) AS count FROM memory_record_versions",
      ).get() as { count: number }).count;
      // The first response is intentionally treated as lost: retrying the same
      // MCP tool and idempotency key is the ambiguous-timeout recovery path.
      const ignoredFirstResponse = await invokeMcpTool(
        token.token,
        "pim_run_receipt_submit",
        receiptInput,
      );
      expect(ignoredFirstResponse.statusCode, ignoredFirstResponse.body).toBe(200);
      expect(
        ignoredFirstResponse.json().result.isError,
        ignoredFirstResponse.body,
      ).not.toBe(true);
      const accepted = parseMemoryContractV2(
        "RunReceiptResultV2",
        ignoredFirstResponse.json().result.structuredContent,
      );
      expect(accepted).toMatchObject({
        producer_run_id: producerRunId,
        status: "accepted",
        duplicate: false,
        scope_snapshot_digest: expectedScopeDigest,
      });
      expect(accepted.candidate_results).toHaveLength(1);
      expect(testDb.prepare(
        "SELECT COUNT(*) AS count FROM memory_record_versions",
      ).get()).toEqual({ count: canonicalRecordCountBefore });

      const retry = await invokeMcpTool(token.token, "pim_run_receipt_submit", receiptInput);
      expect(retry.statusCode, retry.body).toBe(200);
      const replayed = parseMemoryContractV2(
        "RunReceiptResultV2",
        retry.json().result.structuredContent,
      );
      expect(replayed).toMatchObject({
        receipt_id: accepted.receipt_id,
        producer_run_id: producerRunId,
        request_digest: accepted.request_digest,
        status: "replayed",
        duplicate: true,
      });
      expect(testDb.prepare(
        "SELECT COUNT(*) AS count FROM memory_v2_scope_snapshots WHERE producer_run_id = ?",
      ).get(producerRunId)).toEqual({ count: 1 });

      const changed = structuredClone(receiptInput);
      const changedReceipt = changed.receipt as Record<string, unknown>;
      changedReceipt.task = {
        ...(changedReceipt.task as Record<string, unknown>),
        summary: "A different immutable receipt payload must conflict",
      };
      const conflict = await invokeMcpTool(
        token.token,
        "pim_run_receipt_submit",
        changed,
      );
      expect(conflict.statusCode, conflict.body).toBe(200);
      expect(conflict.json().result).toMatchObject({
        isError: true,
        structuredContent: {
          code: "idempotency_conflict",
          plane: "codebase",
          retryable: false,
        },
      });
      expect(testDb.prepare(
        "SELECT COUNT(*) AS count FROM memory_v2_scope_snapshots WHERE producer_run_id = ?",
      ).get(producerRunId)).toEqual({ count: 1 });

      const candidateId = accepted.candidate_results[0]!.candidate_id;
      const status = await invokeMcpTool(token.token, "pim_candidate_status", {
        plane: "codebase",
        resource_selector: { canonical_resource_id: "github.com/acme/memory" },
        candidate_id: candidateId,
      });
      expect(status.statusCode, status.body).toBe(200);
      expect(parseMemoryContractV2(
        "MemoryCandidateStatusV2",
        status.json().result.structuredContent,
      )).toMatchObject({
        candidate_id: candidateId,
        client_candidate_id: `candidate-mcp-slice3-${suffix}`,
        plane: "codebase",
        resource_binding: { resource_row_id: pack.resource_binding.resource_row_id },
        status: "accepted",
        active_record: null,
      });

      const absent = await invokeMcpTool(token.token, "pim_candidate_status", {
        plane: "codebase",
        resource_selector: { canonical_resource_id: "github.com/acme/memory" },
        candidate_id: "candidate-does-not-exist",
      });
      expect(absent.statusCode, absent.body).toBe(200);
      expect(absent.json().result).toMatchObject({
        isError: true,
        structuredContent: {
          code: "resource_not_found",
          plane: "codebase",
          retryable: false,
          details: [],
        },
      });

      const writeMetrics = metrics.slice(metricStart).filter((metric) => (
        metric.name === "MemoryOperationOutcome"
      ));
      expect(writeMetrics.map((metric) => metric.dimensions)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          transport: "mcp",
          operation: "receipt_write",
          outcome: "success",
          reason: "completed",
        }),
        expect.objectContaining({
          transport: "mcp",
          operation: "receipt_write",
          outcome: "replay",
          reason: "replayed",
        }),
        expect.objectContaining({
          transport: "mcp",
          operation: "receipt_write",
          outcome: "deny",
          reason: "idempotency_conflict",
        }),
        expect.objectContaining({
          transport: "mcp",
          operation: "candidate_read",
          outcome: "success",
          reason: "completed",
        }),
        expect.objectContaining({
          transport: "mcp",
          operation: "candidate_read",
          outcome: "deny",
          reason: "resource_not_found",
        }),
      ]));
      for (const metric of writeMetrics) {
        expect(metric.dimensions).not.toHaveProperty("producer_run_id");
        expect(metric.dimensions).not.toHaveProperty("candidate_id");
        expect(metric.dimensions).not.toHaveProperty("token_id");
      }
      expect(ignoredFirstResponse.headers["cache-control"]).toBe("private, no-store");
      expect(ignoredFirstResponse.headers.vary).toBe("Authorization");
      expect(ignoredFirstResponse.headers["mcp-session-id"]).toBeUndefined();
    } finally {
      revokeServiceToken(orgId, token.token_id);
      metrics.splice(metricStart);
    }
  });

  it("binds feedback to the exact v2 pack and snapshot with replay and conflict semantics", async () => {
    const token = createSlice3Private("slice3-mcp-feedback-replay");
    const suffix = "feedback-replay-1";
    const producerRunId = `example-harness-a:test:mcp:${suffix}`;
    const baseSha = "f".repeat(40);
    try {
      const searchInput = {
        ...structuredClone(MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2),
        request_id: `mcp-slice3-search-${suffix}`,
        consumer: {
          ...MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2.consumer,
          consumer_run_id: producerRunId,
        },
        resource_selector: { canonical_resource_id: "github.com/acme/memory" },
        applicability: {
          ...MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCodeSearchInputV2.applicability,
          repository_id: "github.com/acme/memory",
          base_sha: baseSha,
        },
      };
      const search = await invokeMcpTool(token.token, "pim_code_memory_search", searchInput);
      expect(search.statusCode, search.body).toBe(200);
      const pack = parseMemoryContractV2(
        "MemorySearchResultV2",
        search.json().result.structuredContent,
      );
      expect(pack.items.length).toBeGreaterThan(0);
      const receiptInput = slice3ReceiptInput({
        suffix,
        producerRunId,
        resourceBinding: pack.resource_binding,
        baseSha,
        scopeSnapshotDigest: pack.scope_snapshot_digest,
      });
      const receipt = await invokeMcpTool(
        token.token,
        "pim_run_receipt_submit",
        receiptInput,
      );
      expect(receipt.statusCode, receipt.body).toBe(200);
      expect(receipt.json().result.isError, receipt.body).not.toBe(true);

      const feedbackInput = {
        idempotency_key: `mcp-feedback-slice3-${suffix}`,
        feedback: {
          schema_version: "pim.memory-feedback.v2",
          feedback_revision: 1,
          retrieval_pack_id: pack.retrieval_pack_id,
          record_id: pack.items[0]!.record_id,
          record_version: pack.items[0]!.record_version,
          producer_run_id: producerRunId,
          plane: "codebase",
          resource_row_id: pack.resource_binding.resource_row_id,
          scope_snapshot_digest: pack.scope_snapshot_digest,
          disposition: "helpful",
          reason_code: "mcp_slice3_helpful",
          outcome_evidence_refs: [],
          event_time: "2026-08-08T12:00:00.000Z",
        },
      };
      const accepted = await invokeMcpTool(token.token, "pim_feedback_submit", feedbackInput);
      expect(accepted.statusCode, accepted.body).toBe(200);
      const acceptedResult = parseMemoryContractV2(
        "MemoryFeedbackResultV2",
        accepted.json().result.structuredContent,
      );
      expect(acceptedResult).toMatchObject({
        feedback_revision: 1,
        duplicate: false,
        plane: "codebase",
        resource_binding: { resource_row_id: pack.resource_binding.resource_row_id },
      });

      const replay = await invokeMcpTool(token.token, "pim_feedback_submit", feedbackInput);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(parseMemoryContractV2(
        "MemoryFeedbackResultV2",
        replay.json().result.structuredContent,
      )).toMatchObject({
        feedback_id: acceptedResult.feedback_id,
        feedback_revision: 1,
        duplicate: true,
      });
      expect(testDb.prepare(
        `SELECT COUNT(*) AS count FROM memory_v2_feedback_bindings
         WHERE producer_run_id = ? AND feedback_stage = 'later'`,
      ).get(producerRunId)).toEqual({ count: 1 });

      const conflictInput = structuredClone(feedbackInput);
      conflictInput.feedback.reason_code = "mcp_slice3_changed";
      const conflict = await invokeMcpTool(
        token.token,
        "pim_feedback_submit",
        conflictInput,
      );
      expect(conflict.statusCode, conflict.body).toBe(200);
      expect(conflict.json().result).toMatchObject({
        isError: true,
        structuredContent: { code: "idempotency_conflict", plane: "codebase" },
      });

      const crossPackInput = structuredClone(feedbackInput);
      crossPackInput.idempotency_key = `mcp-feedback-cross-pack-${suffix}`;
      crossPackInput.feedback.retrieval_pack_id = "pack-v2-outside-authority";
      const crossPack = await invokeMcpTool(
        token.token,
        "pim_feedback_submit",
        crossPackInput,
      );
      expect(crossPack.statusCode, crossPack.body).toBe(200);
      expect(crossPack.json().result).toMatchObject({
        isError: true,
        structuredContent: {
          code: "evidence_mismatch",
          plane: "codebase",
          retryable: false,
        },
      });

      const crossResourceInput = structuredClone(feedbackInput);
      crossResourceInput.idempotency_key = `mcp-feedback-cross-resource-${suffix}`;
      crossResourceInput.feedback.resource_row_id = "v2res_repository:not-bound";
      const crossResource = await invokeMcpTool(
        token.token,
        "pim_feedback_submit",
        crossResourceInput,
      );
      expect(crossResource.statusCode, crossResource.body).toBe(200);
      expect(crossResource.json().result).toMatchObject({
        isError: true,
        structuredContent: {
          code: "resource_binding_mismatch",
          plane: "codebase",
          retryable: false,
        },
      });
      expect(testDb.prepare(
        `SELECT COUNT(*) AS count FROM memory_v2_feedback_bindings
         WHERE producer_run_id = ? AND feedback_stage = 'later'`,
      ).get(producerRunId)).toEqual({ count: 1 });
    } finally {
      revokeServiceToken(orgId, token.token_id);
    }
  });

  it("rejects secrets, personal data, oversized candidates, and unscoped harness branches before persistence", async () => {
    const token = createSlice3Private("slice3-mcp-input-safety");
    const bindingResponse = await callMcpTool(token.token, "pim_memory_binding");
    expect(bindingResponse.statusCode, bindingResponse.body).toBe(200);
    const binding = parseMemoryContractV2(
      "MemoryBindingV2",
      bindingResponse.json().result.structuredContent,
    ).resources[0]!;
    const baseSha = "a".repeat(40);
    const scopeSnapshotDigest = canonicalJsonSha256({
      schema_version: "pim.memory-scope-snapshot.codebase.v2",
      plane: "codebase",
      resource_binding: binding,
      repository_id: binding.canonical_resource_id,
      base_sha: baseSha,
    });
    try {
      const base = slice3ReceiptInput({
        suffix: "input-safety",
        producerRunId: "example-harness-a:test:mcp:input-safety",
        resourceBinding: binding,
        baseSha,
        scopeSnapshotDigest,
      });
      const unsafeCases = [
        ["AKIAIOSFODNN7EXAMPLE", "secret_shaped_content", "/"],
        [
          "Operator SSN 123-45-6789 must never persist",
          "disallowed_personal_data",
          "/receipt/task/summary",
        ],
      ] as const;
      for (const [summary, reason, path] of unsafeCases) {
        const unsafe = structuredClone(base);
        const receipt = unsafe.receipt as Record<string, unknown>;
        receipt.task = { ...(receipt.task as Record<string, unknown>), summary };
        const response = await invokeMcpTool(
          token.token,
          "pim_run_receipt_submit",
          unsafe,
        );
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().result).toMatchObject({
          isError: true,
          structuredContent: {
            code: "schema_invalid",
            plane: "codebase",
            retryable: false,
            details: [{ path, reason }],
          },
        });
      }

      const oversized = structuredClone(base);
      const oversizedReceipt = oversized.receipt as {
        candidates: Array<{ exceptions: string[] }>;
      };
      oversizedReceipt.candidates[0]!.exceptions = Array.from(
        { length: 32 },
        (_, index) => `${index.toString().padStart(2, "0")}-${"x".repeat(996)}`,
      );
      const oversizedResponse = await invokeMcpTool(
        token.token,
        "pim_run_receipt_submit",
        oversized,
      );
      expect(oversizedResponse.statusCode, oversizedResponse.body).toBe(200);
      expect(oversizedResponse.json().result).toMatchObject({
        isError: true,
        structuredContent: {
          code: "schema_invalid",
          plane: "codebase",
          retryable: false,
          details: [{
            path: "/receipt/candidates",
            reason: "maximum serialized candidate size is 32768 bytes",
          }],
        },
      });

      const harnessReceiptBody = structuredClone(MEMORY_CONTRACT_FIXTURES_V2.HarnessRunReceiptV2);
      const harnessReceiptRecord = harnessReceiptBody as unknown as Record<string, unknown>;
      delete harnessReceiptRecord.tenant;
      const harnessSnapshot = harnessReceiptRecord.scope_snapshot as Record<string, unknown>;
      delete harnessSnapshot.resource_binding;
      const harnessReceipt = {
        idempotency_key: "mcp-harness-receipt-remains-closed",
        producer_run_id: harnessReceiptBody.producer.consumer_run_id,
        receipt: harnessReceiptBody,
      };
      const closedReceipt = await invokeMcpTool(
        token.token,
        "pim_run_receipt_submit",
        harnessReceipt as unknown as Record<string, unknown>,
      );
      expect(closedReceipt.statusCode, closedReceipt.body).toBe(200);
      expect(closedReceipt.json().result).toMatchObject({
        isError: true,
        structuredContent: {
          code: "resource_binding_mismatch",
          plane: "harness",
          retryable: false,
        },
      });

      const authoritySecret = "mcp-harness-authority-field-must-not-leak";
      const malformedHarnessReceipt = structuredClone(harnessReceipt) as {
        receipt: Record<string, unknown>;
      };
      malformedHarnessReceipt.receipt.tenant = { project_id: authoritySecret };
      const malformedReceipt = await invokeMcpTool(
        token.token,
        "pim_run_receipt_submit",
        malformedHarnessReceipt as unknown as Record<string, unknown>,
      );
      expect(malformedReceipt.statusCode, malformedReceipt.body).toBe(200);
      expect(malformedReceipt.json().result).toMatchObject({
        isError: true,
        structuredContent: {
          code: "schema_invalid",
          plane: "harness",
          retryable: false,
        },
      });
      expect(malformedReceipt.body).not.toContain(authoritySecret);

      const wrongHarnessVersion = structuredClone(harnessReceipt) as {
        receipt: Record<string, unknown>;
      };
      wrongHarnessVersion.receipt.schema_version = "pim.run-receipt.v1";
      const unsupportedHarnessReceipt = await invokeMcpTool(
        token.token,
        "pim_run_receipt_submit",
        wrongHarnessVersion as unknown as Record<string, unknown>,
      );
      expect(unsupportedHarnessReceipt.statusCode, unsupportedHarnessReceipt.body).toBe(200);
      expect(unsupportedHarnessReceipt.json().result).toMatchObject({
        isError: true,
        structuredContent: {
          code: "contract_version_unsupported",
          plane: "harness",
          retryable: false,
        },
      });

      const harnessFeedback = structuredClone(
        MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpFeedbackSubmitInputV2,
      );
      const harnessFeedbackRecord = harnessFeedback as unknown as {
        idempotency_key: string;
        feedback: { plane: string; resource_row_id: string };
      };
      harnessFeedbackRecord.idempotency_key = "mcp-harness-feedback-remains-closed";
      harnessFeedbackRecord.feedback.plane = "harness";
      harnessFeedbackRecord.feedback.resource_row_id = "resource-harness-contract";
      const closedFeedback = await invokeMcpTool(
        token.token,
        "pim_feedback_submit",
        harnessFeedback,
      );
      expect(closedFeedback.statusCode, closedFeedback.body).toBe(200);
      expect(closedFeedback.json().result).toMatchObject({
        isError: true,
        structuredContent: {
          code: "schema_invalid",
          plane: "harness",
          retryable: false,
        },
      });

      const closedCandidateStatus = await invokeMcpTool(
        token.token,
        "pim_candidate_status",
        structuredClone(MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCandidateStatusInputV2),
      );
      expect(closedCandidateStatus.statusCode, closedCandidateStatus.body).toBe(200);
      expect(closedCandidateStatus.json().result).toMatchObject({
        isError: true,
        structuredContent: {
          code: "resource_not_found",
          plane: "harness",
          retryable: false,
        },
      });

      const malformedStatusSecret = "mcp-harness-status-field-must-not-leak";
      const malformedCandidateStatus = await invokeMcpTool(
        token.token,
        "pim_candidate_status",
        {
          ...structuredClone(MEMORY_CONTRACT_FIXTURES_V2.MemoryMcpCandidateStatusInputV2),
          receipt_id: "",
          unexpected: malformedStatusSecret,
        },
      );
      expect(malformedCandidateStatus.statusCode, malformedCandidateStatus.body).toBe(200);
      expect(malformedCandidateStatus.json().result).toMatchObject({
        isError: true,
        structuredContent: {
          code: "schema_invalid",
          plane: "harness",
          retryable: false,
        },
      });
      expect(malformedCandidateStatus.body).not.toContain(malformedStatusSecret);

      expect(testDb.prepare(
        "SELECT COUNT(*) AS count FROM memory_v2_scope_snapshots WHERE producer_run_id = ?",
      ).get("example-harness-a:test:mcp:input-safety")).toEqual({ count: 0 });
    } finally {
      revokeServiceToken(orgId, token.token_id);
    }
  });
});

describe("Slice-5 restricted MCP harness intake", () => {
  it("replays an ambiguous receipt and keeps producer-bound status non-enumerating", async () => {
    const token = createSlice5HarnessPrivate("slice5-mcp-harness-replay");
    const otherPrincipal = createSlice5HarnessPrivate("slice5-mcp-harness-other-principal");
    const otherHarness = createSlice5HarnessPrivate(
      "slice5-mcp-harness-other-resource",
      "example-harness-b",
    );
    const producerRunId = "example-harness-a:test:mcp:harness-intake:replay-1";
    try {
      const tools = await app.inject({
        method: "POST",
        url: "/mcp/memory",
        headers: mcpHeaders("tools/list", "pim-memory", token.token),
        payload: mcpPayload("tools/list", "pim-memory", { _meta: clientMeta }),
      });
      expect(tools.statusCode, tools.body).toBe(200);
      const toolNames = tools.json().result.tools.map((tool: { name: string }) => tool.name);
      expect(toolNames).toEqual([
        "pim_memory_capabilities",
        "pim_memory_binding",
        "pim_run_receipt_submit",
        "pim_candidate_status",
      ]);
      expect(toolNames).not.toEqual(expect.arrayContaining([
        "pim_runtime_attestation_submit",
        "pim_candidate_review",
        "pim_candidate_activate",
      ]));

      const bindingResponse = await callMcpTool(token.token, "pim_memory_binding");
      expect(bindingResponse.statusCode, bindingResponse.body).toBe(200);
      const binding = parseMemoryContractV2(
        "MemoryBindingV2",
        bindingResponse.json().result.structuredContent,
      ).resources.find((resource) => resource.plane === "harness")!;
      const receiptInput = slice5HarnessReceiptInput({
        suffix: "mcp-replay-1",
        producerRunId,
        resourceBinding: binding,
      });

      const secret = "AKIAIOSFODNN7EXAMPLE";
      const unsafeReceipt = structuredClone(receiptInput) as any;
      unsafeReceipt.receipt.evidence_handles[0].provider_event_id = secret;
      const secretRejected = await invokeMcpTool(
        token.token,
        "pim_run_receipt_submit",
        unsafeReceipt,
      );
      expect(secretRejected.statusCode, secretRejected.body).toBe(200);
      expect(secretRejected.json().result).toMatchObject({
        isError: true,
        structuredContent: {
          code: "schema_invalid",
          plane: "harness",
          retryable: false,
        },
      });
      expect(secretRejected.body).not.toContain(secret);

      const authoritySecret = "caller-project-authority-must-not-leak";
      const authorityReceipt = structuredClone(receiptInput) as any;
      authorityReceipt.receipt.tenant = { project_id: authoritySecret };
      const authorityRejected = await invokeMcpTool(
        token.token,
        "pim_run_receipt_submit",
        authorityReceipt,
      );
      expect(authorityRejected.statusCode, authorityRejected.body).toBe(200);
      expect(authorityRejected.json().result).toMatchObject({
        isError: true,
        structuredContent: {
          code: "schema_invalid",
          plane: "harness",
          retryable: false,
        },
      });
      expect(authorityRejected.body).not.toContain(authoritySecret);
      expect(testDb.prepare(
        "SELECT COUNT(*) AS count FROM memory_v2_scope_snapshots WHERE producer_run_id = ?",
      ).get(producerRunId)).toEqual({ count: 0 });

      // Treat the first successful response as an ambiguous timeout. Recovery
      // must retry this same MCP tool and key without switching transport.
      const ignoredFirstResponse = await invokeMcpTool(
        token.token,
        "pim_run_receipt_submit",
        receiptInput,
      );
      expect(ignoredFirstResponse.statusCode, ignoredFirstResponse.body).toBe(200);
      expect(ignoredFirstResponse.json().result.isError).not.toBe(true);
      const accepted = parseMemoryContractV2(
        "RunReceiptResultV2",
        ignoredFirstResponse.json().result.structuredContent,
      );
      expect(accepted).toMatchObject({
        producer_run_id: producerRunId,
        plane: "harness",
        resource_binding: { resource_row_id: binding.resource_row_id },
        status: "accepted",
        duplicate: false,
      });
      expect(accepted.candidate_results).toHaveLength(1);
      expect(accepted.candidate_results[0]).toMatchObject({
        plane: "harness",
        kind: "anti_pattern",
        subkind: "failure_pattern",
        status: "accepted",
        active_record: null,
      });

      const retry = await invokeMcpTool(
        token.token,
        "pim_run_receipt_submit",
        receiptInput,
      );
      expect(retry.statusCode, retry.body).toBe(200);
      const replayed = parseMemoryContractV2(
        "RunReceiptResultV2",
        retry.json().result.structuredContent,
      );
      expect(replayed).toMatchObject({
        receipt_id: accepted.receipt_id,
        request_digest: accepted.request_digest,
        status: "replayed",
        duplicate: true,
      });
      expect(testDb.prepare(
        "SELECT COUNT(*) AS count FROM memory_v2_scope_snapshots WHERE producer_run_id = ?",
      ).get(producerRunId)).toEqual({ count: 1 });
      expect(testDb.prepare(
        `SELECT COUNT(*) AS count FROM memory_v2_origins
         WHERE producer_principal_id = ? AND resource_row_id = ?`,
      ).get(token.service_principal_id, binding.resource_row_id)).toEqual({ count: 1 });

      const candidateId = accepted.candidate_results[0]!.candidate_id;
      const statusInput = {
        plane: "harness",
        resource_selector: { resource_row_id: binding.resource_row_id },
        receipt_id: accepted.receipt_id,
        producer_run_id: producerRunId,
        candidate_id: candidateId,
      };
      const status = await invokeMcpTool(token.token, "pim_candidate_status", statusInput);
      expect(status.statusCode, status.body).toBe(200);
      expect(parseMemoryContractV2(
        "MemoryCandidateStatusV2",
        status.json().result.structuredContent,
      )).toMatchObject({
        candidate_id: candidateId,
        plane: "harness",
        status: "accepted",
        active_record: null,
      });

      const deniedBodies = [];
      for (const deniedToken of [otherPrincipal.token, otherHarness.token]) {
        const denied = await invokeMcpTool(
          deniedToken,
          "pim_candidate_status",
          statusInput,
        );
        expect(denied.statusCode, denied.body).toBe(200);
        expect(denied.json().result).toMatchObject({
          isError: true,
          structuredContent: {
            code: "resource_not_found",
            plane: "harness",
            retryable: false,
            details: [],
          },
        });
        deniedBodies.push(denied.json().result.structuredContent);
      }
      expect(deniedBodies[0]).toEqual(deniedBodies[1]);

      const changed = structuredClone(receiptInput) as any;
      changed.receipt.task.summary = "Changed immutable harness receipt payload.";
      const conflict = await invokeMcpTool(
        token.token,
        "pim_run_receipt_submit",
        changed,
      );
      expect(conflict.statusCode, conflict.body).toBe(200);
      expect(conflict.json().result).toMatchObject({
        isError: true,
        structuredContent: {
          code: "idempotency_conflict",
          plane: "harness",
          retryable: false,
        },
      });
    } finally {
      revokeServiceToken(orgId, token.token_id);
      revokeServiceToken(orgId, otherPrincipal.token_id);
      revokeServiceToken(orgId, otherHarness.token_id);
    }
  });

  it("keeps real HTTP, restricted MCP, and strict SDK harness results aligned", async () => {
    const httpToken = createSlice5HarnessHttpToken("slice5-http-harness-parity");
    const sdkToken = createSlice5HarnessHttpToken("slice5-sdk-harness-parity");
    const mcpToken = createSlice5HarnessPrivate("slice5-mcp-harness-parity");
    try {
      const httpBinding = (await directHttpBinding(httpToken.token)).resources
        .find((resource) => resource.plane === "harness")!;
      const httpFixture = slice5HarnessHttpReceipt({
        suffix: "transport-parity-http",
        producerRunId: "example-harness-a:test:harness:transport-parity:http",
        resourceBinding: httpBinding,
      });
      const httpAcceptedResponse = await app.inject({
        method: "PUT",
        url: `/api/v2/memory/run-receipts/${encodeURIComponent(httpFixture.producerRunId)}`,
        headers: {
          authorization: `Bearer ${httpToken.token}`,
          "idempotency-key": httpFixture.idempotencyKey,
        },
        payload: httpFixture.receipt,
      });
      expect(httpAcceptedResponse.statusCode, httpAcceptedResponse.body).toBe(200);
      const httpAccepted = parseMemoryContractV2(
        "RunReceiptResultV2",
        httpAcceptedResponse.json(),
      );

      const mcpBindingResponse = await callMcpTool(mcpToken.token, "pim_memory_binding");
      expect(mcpBindingResponse.statusCode, mcpBindingResponse.body).toBe(200);
      const mcpBinding = parseMemoryContractV2(
        "MemoryBindingV2",
        mcpBindingResponse.json().result.structuredContent,
      ).resources.find((resource) => resource.plane === "harness")!;
      const mcpProducerRunId = "example-harness-a:test:harness:transport-parity:mcp";
      const mcpReceipt = await invokeMcpTool(
        mcpToken.token,
        "pim_run_receipt_submit",
        slice5HarnessReceiptInput({
          suffix: "transport-parity-mcp",
          producerRunId: mcpProducerRunId,
          resourceBinding: mcpBinding,
        }),
      );
      expect(mcpReceipt.statusCode, mcpReceipt.body).toBe(200);
      expect(mcpReceipt.json().result.isError).not.toBe(true);
      const mcpAccepted = parseMemoryContractV2(
        "RunReceiptResultV2",
        mcpReceipt.json().result.structuredContent,
      );

      const sdkClient = new PimMemoryV2Client({
        baseUrl: await memoryMcpLiveBaseUrl(),
        authToken: sdkToken.token,
      });
      const sdkBinding = (await sdkClient.binding()).resources
        .find((resource) => resource.plane === "harness")!;
      const sdkFixture = slice5HarnessHttpReceipt({
        suffix: "transport-parity-sdk",
        producerRunId: "example-harness-a:test:harness:transport-parity:sdk",
        resourceBinding: sdkBinding,
      });
      const sdkAccepted = await sdkClient.putRunReceipt(
        sdkFixture.producerRunId,
        sdkFixture.idempotencyKey,
        sdkFixture.receipt,
      );

      const receiptSemantics = (result: typeof httpAccepted) => ({
        plane: result.plane,
        canonical_resource_id: result.resource_binding.canonical_resource_id,
        status: result.status,
        duplicate: result.duplicate,
        candidates: result.candidate_results.map((candidate) => ({
          plane: candidate.plane,
          kind: candidate.kind,
          subkind: candidate.subkind,
          status: candidate.status,
          activation_requirement: candidate.activation_requirement,
          blockers: candidate.blockers,
          active_record: candidate.active_record,
        })),
      });
      expect(receiptSemantics(httpAccepted)).toEqual(receiptSemantics(mcpAccepted));
      expect(receiptSemantics(mcpAccepted)).toEqual(receiptSemantics(sdkAccepted));

      const httpCandidate = httpAccepted.candidate_results[0]!;
      const httpStatusQuery = new URLSearchParams({
        plane: "harness",
        receipt_id: httpAccepted.receipt_id,
        producer_run_id: httpFixture.producerRunId,
        resource_row_id: httpBinding.resource_row_id,
      });
      const httpStatusResponse = await app.inject({
        method: "GET",
        url: `/api/v2/memory/candidates/${encodeURIComponent(httpCandidate.candidate_id)}?${httpStatusQuery}`,
        headers: { authorization: `Bearer ${httpToken.token}` },
      });
      expect(httpStatusResponse.statusCode, httpStatusResponse.body).toBe(200);
      const httpStatus = parseMemoryContractV2(
        "MemoryCandidateStatusV2",
        httpStatusResponse.json(),
      );

      const mcpCandidate = mcpAccepted.candidate_results[0]!;
      const mcpStatusResponse = await invokeMcpTool(
        mcpToken.token,
        "pim_candidate_status",
        {
          plane: "harness",
          resource_selector: { resource_row_id: mcpBinding.resource_row_id },
          receipt_id: mcpAccepted.receipt_id,
          producer_run_id: mcpProducerRunId,
          candidate_id: mcpCandidate.candidate_id,
        },
      );
      expect(mcpStatusResponse.statusCode, mcpStatusResponse.body).toBe(200);
      const mcpStatus = parseMemoryContractV2(
        "MemoryCandidateStatusV2",
        mcpStatusResponse.json().result.structuredContent,
      );

      const sdkCandidate = sdkAccepted.candidate_results[0]!;
      const sdkStatus = await sdkClient.getHarnessCandidate({
        plane: "harness",
        resource_selector: { resource_row_id: sdkBinding.resource_row_id },
        receipt_id: sdkAccepted.receipt_id,
        producer_run_id: sdkFixture.producerRunId,
        candidate_id: sdkCandidate.candidate_id,
      });
      const statusSemantics = (status: typeof httpStatus) => ({
        plane: status.plane,
        canonical_resource_id: status.resource_binding.canonical_resource_id,
        kind: status.kind,
        subkind: status.subkind,
        status: status.status,
        activation_requirement: status.activation_requirement,
        blockers: status.blockers,
        active_record: status.active_record,
      });
      expect(statusSemantics(httpStatus)).toEqual(statusSemantics(mcpStatus));
      expect(statusSemantics(mcpStatus)).toEqual(statusSemantics(sdkStatus));

      const wrongHttpReceipt = {
        ...httpFixture.receipt,
        schema_version: "pim.run-receipt.v1",
      };
      const wrongHttp = await app.inject({
        method: "PUT",
        url: "/api/v2/memory/run-receipts/wrong-version-http-harness",
        headers: {
          authorization: `Bearer ${httpToken.token}`,
          "idempotency-key": "wrong-version-http-harness",
        },
        payload: wrongHttpReceipt,
      });
      expect(wrongHttp.statusCode, wrongHttp.body).toBe(400);

      const wrongMcpInput = slice5HarnessReceiptInput({
        suffix: "wrong-version-mcp-harness",
        producerRunId: "wrong-version-mcp-harness",
        resourceBinding: mcpBinding,
      }) as any;
      wrongMcpInput.receipt.schema_version = "pim.run-receipt.v1";
      const wrongMcp = await invokeMcpTool(
        mcpToken.token,
        "pim_run_receipt_submit",
        wrongMcpInput,
      );
      expect(wrongMcp.statusCode, wrongMcp.body).toBe(200);
      expect(wrongHttp.json()).toMatchObject({
        code: "contract_version_unsupported",
        plane: "harness",
        retryable: false,
      });
      expect(wrongMcp.json().result.structuredContent).toMatchObject({
        code: "contract_version_unsupported",
        plane: "harness",
        retryable: false,
      });

      const malformedHttpStatus = await app.inject({
        method: "GET",
        url: `/api/v2/memory/candidates/${encodeURIComponent(httpCandidate.candidate_id)}`
          + `?plane=harness&producer_run_id=${encodeURIComponent(httpFixture.producerRunId)}`
          + `&resource_row_id=${encodeURIComponent(httpBinding.resource_row_id)}`,
        headers: { authorization: `Bearer ${httpToken.token}` },
      });
      const malformedMcpStatus = await invokeMcpTool(
        mcpToken.token,
        "pim_candidate_status",
        {
          plane: "harness",
          resource_selector: { resource_row_id: mcpBinding.resource_row_id },
          receipt_id: "",
          producer_run_id: mcpProducerRunId,
          candidate_id: mcpCandidate.candidate_id,
        },
      );
      expect(malformedHttpStatus.statusCode, malformedHttpStatus.body).toBe(400);
      expect(malformedHttpStatus.json()).toMatchObject({
        code: "schema_invalid",
        plane: "harness",
        retryable: false,
      });
      expect(malformedMcpStatus.json().result.structuredContent).toMatchObject({
        code: "schema_invalid",
        plane: "harness",
        retryable: false,
      });

      const overlongSelectorValue = "x".repeat(129);
      const overlongReceiptStatus = await app.inject({
        method: "GET",
        url: `/api/v2/memory/candidates/${encodeURIComponent(httpCandidate.candidate_id)}`
          + `?plane=harness&receipt_id=${overlongSelectorValue}`
          + `&producer_run_id=${encodeURIComponent(httpFixture.producerRunId)}`
          + `&resource_row_id=${encodeURIComponent(httpBinding.resource_row_id)}`,
        headers: { authorization: `Bearer ${httpToken.token}` },
      });
      const overlongResourceStatus = await app.inject({
        method: "GET",
        url: `/api/v2/memory/candidates/${encodeURIComponent(httpCandidate.candidate_id)}`
          + `?plane=harness&receipt_id=${encodeURIComponent(httpAccepted.receipt_id)}`
          + `&producer_run_id=${encodeURIComponent(httpFixture.producerRunId)}`
          + `&resource_row_id=${overlongSelectorValue}`,
        headers: { authorization: `Bearer ${httpToken.token}` },
      });
      for (const response of [overlongReceiptStatus, overlongResourceStatus]) {
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json()).toMatchObject({
          code: "schema_invalid",
          plane: "harness",
          retryable: false,
        });
      }
    } finally {
      revokeServiceToken(orgId, httpToken.token_id);
      revokeServiceToken(orgId, sdkToken.token_id);
      revokeServiceToken(orgId, mcpToken.token_id);
    }
  });

  it("lets already-authorized HTTP and MCP receipts finish after revocation and denies the next request", async () => {
    const httpToken = createSlice5HarnessHttpToken("slice4-http-in-flight-revocation");
    const mcpToken = createSlice5HarnessPrivate("slice4-mcp-in-flight-revocation");
    let providerStarts = 0;
    let markBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    let releaseProvider!: () => void;
    const providerReleased = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    try {
      const httpBinding = (await directHttpBinding(httpToken.token)).resources
        .find((resource) => resource.plane === "harness")!;
      const mcpBinding = parseMemoryContractV2(
        "MemoryBindingV2",
        (await callMcpTool(mcpToken.token, "pim_memory_binding"))
          .json().result.structuredContent,
      ).resources.find((resource) => resource.plane === "harness")!;
      const httpFixture = slice5HarnessHttpReceipt({
        suffix: "slice4-in-flight-http",
        producerRunId: "example-harness-a:test:slice4:in-flight:http",
        resourceBinding: httpBinding,
      });
      const mcpInput = slice5HarnessReceiptInput({
        suffix: "slice4-in-flight-mcp",
        producerRunId: "example-harness-a:test:slice4:in-flight:mcp",
        resourceBinding: mcpBinding,
      });
      setMemoryRuntimeAttestationVerifier(async (input) => {
        providerStarts += 1;
        if (providerStarts === 2) markBothStarted();
        await providerReleased;
        return {
          providerIdentity: `service_principal:${input.auth.producerPrincipalId}`,
          providerDomainKey: `service_principal:${input.auth.producerPrincipalId}`,
          providerEventId: input.handle.provider_event_id,
          immutableDigest: input.handle.immutable_digest,
          occurredAt: input.handle.occurred_at,
          verifiedAt: input.receivedAt,
          outcomeFingerprint: canonicalJsonSha256(input.handle.outcome),
          observationType: input.handle.observation_type,
          sourceAuthority: "observed",
        };
      });

      const pendingHttp = app.inject({
        method: "PUT",
        url: `/api/v2/memory/run-receipts/${encodeURIComponent(httpFixture.producerRunId)}`,
        headers: {
          authorization: `Bearer ${httpToken.token}`,
          "idempotency-key": httpFixture.idempotencyKey,
        },
        payload: httpFixture.receipt,
      });
      const pendingMcp = invokeMcpTool(
        mcpToken.token,
        "pim_run_receipt_submit",
        mcpInput,
      );
      await bothStarted;
      expect(revokeServiceToken(orgId, httpToken.token_id)).toBe(true);
      expect(revokeServiceToken(orgId, mcpToken.token_id)).toBe(true);
      releaseProvider();

      const [httpAccepted, mcpAccepted] = await Promise.all([pendingHttp, pendingMcp]);
      expect(httpAccepted.statusCode, httpAccepted.body).toBe(200);
      expect(parseMemoryContractV2("RunReceiptResultV2", httpAccepted.json()))
        .toMatchObject({ status: "accepted", duplicate: false });
      expect(mcpAccepted.statusCode, mcpAccepted.body).toBe(200);
      expect(parseMemoryContractV2(
        "RunReceiptResultV2",
        mcpAccepted.json().result.structuredContent,
      )).toMatchObject({ status: "accepted", duplicate: false });

      const [nextHttp, nextMcp] = await Promise.all([
        app.inject({
          method: "GET",
          url: "/api/v2/memory/binding",
          headers: { authorization: `Bearer ${httpToken.token}` },
        }),
        callMcpTool(mcpToken.token, "pim_memory_binding"),
      ]);
      expect(nextHttp.statusCode).toBe(401);
      expect(nextMcp.statusCode).toBe(401);
    } finally {
      releaseProvider();
      setMemoryRuntimeAttestationVerifier(null);
      revokeServiceToken(orgId, httpToken.token_id);
      revokeServiceToken(orgId, mcpToken.token_id);
    }
  });
});

describe("private memory MCP security and transport controls", () => {
  it.each([
    ["missing", undefined, 401],
    ["ordinary", () => legacy.token, 403],
    ["unsafe", () => unsafe.token, 403],
    ["missing binding", () => missingBinding.token, 403],
    ["missing membership", () => missingMembership.token, 403],
  ] as const)("rejects %s authority", async (_label, tokenValue, statusCode) => {
    const token = typeof tokenValue === "function" ? tokenValue() : tokenValue;
    const response = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("tools/list", "pim-memory", token),
      payload: mcpPayload("tools/list", "pim-memory", { _meta: clientMeta }),
    });
    expect(response.statusCode).toBe(statusCode);
  });

  it("rejects wrong secrets, legacy traffic, missing headers, and unknown fields", async () => {
    const wrongSecret = `${valid.token.slice(0, -1)}${valid.token.endsWith("0") ? "1" : "0"}`;
    const invalid = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("tools/list", "pim-memory", wrongSecret),
      payload: mcpPayload("tools/list", "pim-memory", { _meta: clientMeta }),
    });
    expect(invalid.statusCode).toBe(401);

    const legacyResponse = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: {
        ...mcpHeaders("initialize", "pim-memory", valid.token),
        "MCP-Protocol-Version": "2025-11-25",
      },
      payload: {
        jsonrpc: "2.0",
        id: "legacy",
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          clientInfo: { name: "legacy", version: "1.0.0" },
          capabilities: {},
        },
      },
    });
    expect(legacyResponse.statusCode).toBe(400);

    const missingHeader = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${valid.token}`,
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Name": "pim-memory",
      },
      payload: mcpPayload("tools/list", "pim-memory", { _meta: clientMeta }),
    });
    expect(missingHeader.statusCode).toBe(400);

    const bodySecret = "unknown-field-must-not-appear";
    const unknown = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("tools/call", "pim_memory_binding", valid.token),
      payload: mcpPayload("tools/call", "pim_memory_binding", {
        name: "pim_memory_binding",
        arguments: { unexpected: bodySecret },
        _meta: clientMeta,
      }),
    });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json().result.isError).toBe(true);
    expect(unknown.body).not.toContain(bodySecret);
  });

  it("is POST-only, stateless, rate-limited, and capped at 512 KiB", async () => {
    const [get, remove, sse] = await Promise.all([
      app.inject({ method: "GET", url: "/mcp/memory" }),
      app.inject({ method: "DELETE", url: "/mcp/memory" }),
      app.inject({ method: "GET", url: "/mcp/memory/sse" }),
    ]);
    expect(get.statusCode).toBe(405);
    expect(get.headers.allow).toBe("POST");
    expect(remove.statusCode).toBe(405);
    expect(sse.statusCode).toBe(404);
    expect(postRouteConfig).toMatchObject({
      rateLimit: MEMORY_MCP_RATE_LIMIT,
      suppressAuthorizationHeaderLogging: true,
      suppressRequestBodyLogging: true,
    });

    const tooLarge = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("tools/list", "pim-memory", valid.token),
      payload: JSON.stringify({
        ...mcpPayload("tools/list", "pim-memory", { _meta: clientMeta }),
        padding: "x".repeat(MEMORY_MCP_BODY_LIMIT),
      }),
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.headers["cache-control"]).toBe("private, no-store");
  });

  it("emits bounded metrics/audit records without logging credentials or bodies", async () => {
    const metricStart = metrics.length;
    const bodySecret = "audit-body-secret-never-log";
    const response = await app.inject({
      method: "POST",
      url: "/mcp/memory",
      headers: mcpHeaders("tools/call", "pim_memory_binding", valid.token),
      payload: mcpPayload("tools/call", "pim_memory_binding", {
        name: "pim_memory_binding",
        arguments: { unexpected: bodySecret },
        _meta: clientMeta,
      }),
    });
    expect(response.statusCode).toBe(200);

    const logs = logChunks.join("");
    for (const secret of [valid.token, legacy.token, unsafe.token, bodySecret]) {
      expect(logs).not.toContain(secret);
    }
    expect(logs).toContain("Memory MCP audit");
    const requestMetrics = metrics.slice(metricStart);
    expect(requestMetrics.some((metric) => metric.name === "SearchOutcome")).toBe(true);
    expect(requestMetrics.some((metric) => metric.name === "SearchLatency")).toBe(true);
    for (const metric of requestMetrics) {
      expect(metric.dimensions?.transport).toBe("mcp");
      expect([
        "capabilities",
        "binding",
        "code_search",
        "record_read",
        "pack_read",
        "protocol",
      ]).toContain(metric.dimensions?.operation);
      expect(metric.dimensions).not.toHaveProperty("service_principal_id");
      expect(metric.dimensions).not.toHaveProperty("token_id");
    }
  });

  it("counts direct-HTTP v2 authentication denials with bounded transport dimensions", async () => {
    const metricStart = metrics.length;
    const response = await app.inject({
      method: "POST",
      url: "/api/v2/memory/search",
      payload: MEMORY_CONTRACT_FIXTURES_V2.MemorySearchV2,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      schema_version: "pim.error.v2",
      code: "authentication_required",
    });
    expect(metrics.slice(metricStart)).toContainEqual(expect.objectContaining({
      name: "SearchOutcome",
      dimensions: expect.objectContaining({
        transport: "direct_http",
        operation: "search",
        plane: "codebase",
        resource_type: "repository",
        contract_version: "pim.memory.v2",
        outcome: "deny",
        reason: "authentication_required",
        status: "4xx",
      }),
    }));
  });

  it("enforces the configured rate limit with a private, redacted 429", async () => {
    const isolated = Fastify({ logger: false });
    registerJsonBodyParser(isolated);
    await isolated.register(rateLimit, { max: 1_000, timeWindow: "1 minute" });
    await isolated.register(memoryMcpRoutes);
    await isolated.ready();
    const bodySecret = "rate-limit-body-secret-never-reflect";
    try {
      let rateLimited: Awaited<ReturnType<typeof isolated.inject>> | undefined;
      for (let index = 0; index < MEMORY_MCP_RATE_LIMIT.max + 1; index += 1) {
        const response = await isolated.inject({
          method: "POST",
          url: "/mcp/memory",
          headers: mcpHeaders("tools/list", "pim-memory", valid.token),
          payload: mcpPayload("tools/list", "pim-memory", {
            _meta: clientMeta,
            ...(index === MEMORY_MCP_RATE_LIMIT.max ? { unexpected: bodySecret } : {}),
          }),
        });
        if (response.statusCode === 429) {
          rateLimited = response;
          break;
        }
      }
      expect(rateLimited).toBeDefined();
      expect(rateLimited!.headers["cache-control"]).toBe("private, no-store");
      expect(rateLimited!.headers.vary).toBe("Authorization");
      expect(rateLimited!.body).not.toContain(valid.token);
      expect(rateLimited!.body).not.toContain(bodySecret);
      expect(rateLimited!.json()).toMatchObject({
        jsonrpc: "2.0",
        error: { code: -32004, message: "Rate limit exceeded" },
        id: null,
      });
    } finally {
      await isolated.close();
    }
  });
});
