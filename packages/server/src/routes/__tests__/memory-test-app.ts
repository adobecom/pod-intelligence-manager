import { randomUUID } from "node:crypto";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import db from "../../db/connection.js";
import { createTables } from "../../db/schema.js";
import { createAuthHook } from "../../middleware/auth.js";
import {
  isMemoryApiPath,
  isMemoryV2ApiPath,
  sendMemoryError,
  sendMemoryV2Error,
} from "../../middleware/memory-errors.js";
import { resolveRequestOrg } from "../../middleware/org-context.js";
import { registerJsonBodyParser } from "../../middleware/validation.js";
import memoryCapabilitiesRoutes from "../memory-capabilities.js";
import memoryAttestationRoutes from "../memory-attestations.js";
import memoryCandidatesRoutes from "../memory-candidates.js";
import memoryReceiptsRoutes from "../memory-receipts.js";
import memoryFeedbackRoutes from "../memory-feedback.js";
import memoryDecisionRoutes from "../memory-decisions.js";
import memorySearchRoutes from "../memory-search.js";
import memoryHarnessSearchRoutes from "../memory-harness-search.js";
import memoryV2BindingRoutes from "../memory-v2-binding.js";
import memoryV2CapabilitiesRoutes from "../memory-v2-capabilities.js";
import memoryV2ReadinessRoutes from "../memory-v2-readiness.js";
import memoryV2SearchRoutes from "../memory-v2-search.js";
import memoryV2WriteRoutes, {
  MEMORY_V2_PATH_PARAM_MAX_LENGTH,
} from "../memory-v2-write.js";
import { createOrg } from "../../services/orgs.js";
import { seedMemoryReadFixture } from "../../services/memory-seed.js";
import { registerMemoryRepository } from "../../services/memory-repository-registry.js";
import { createServiceToken } from "../../services/service-tokens.js";
import { upsertUserByIms } from "../../services/users.js";
import { ensureMemoryV2EvidenceVerifiedTrust } from "../../services/memory-v2-trust.js";

export interface MemoryTestContext {
  app: FastifyInstance;
  orgA: { id: string; slug: string };
  orgB: { id: string; slug: string };
  projectA: string;
  projectA2: string;
  projectB: string;
  tokenA: string;
  tokenEmptyA: string;
  tokenB: string;
  tokenWithoutScope: string;
  receiptTokenA: string;
  receiptTokenB: string;
  attestTokenA: string;
  feedbackTokenA: string;
  feedbackTokenB: string;
  reviewerTokenA: string;
  reviewerTokenB: string;
  candidateReadTokenA: string;
  candidateReadTokenB: string;
  adminTokenA: string;
  adminTokenB: string;
  harnessReceiptTokenA: string;
  harnessReviewerTokenA: string;
  harnessSearchTokenA: string;
  otherHarnessSearchTokenA: string;
  otherProjectHarnessSearchTokenA: string;
  seededRecordId: string;
  otherTenantRecordId: string;
}

export interface MemoryTestRouteOptions {
  v2Reads?: boolean;
  v2Writes?: boolean;
}

function insertProject(input: {
  projectId: string;
  orgId: string;
  creatorId: string;
  repositories: string[];
}): void {
  db.prepare(
    `INSERT INTO projects
       (project_id, name, description, created_at, anatomy_json, resources_json, org_id, created_by_user_id)
     VALUES (?, ?, NULL, ?, '{"internal":[],"external":[]}', ?, ?, ?)`,
  ).run(
    input.projectId,
    input.projectId,
    new Date().toISOString(),
    JSON.stringify({ github: { repos: input.repositories } }),
    input.orgId,
    input.creatorId,
  );
}

export async function createMemoryTestContext(
  appOptions: FastifyServerOptions = {},
  routeOptions: MemoryTestRouteOptions = {},
): Promise<MemoryTestContext> {
  createTables();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const owner = upsertUserByIms({
    ims_user_id: `memory-owner-${suffix}`,
    email: `memory-owner-${suffix}@pim.test`,
    display_name: "Memory Test Owner",
  });
  const orgASlug = `memory-a-${suffix}`;
  const orgBSlug = `memory-b-${suffix}`;
  const orgA = createOrg({
    orgId: `org_memory_a_${suffix}`,
    slug: orgASlug,
    name: "Memory A",
    creatorUserId: owner.user_id,
  });
  const orgB = createOrg({
    orgId: `org_memory_b_${suffix}`,
    slug: orgBSlug,
    name: "Memory B",
    creatorUserId: owner.user_id,
  });
  const projectA = `project_memory_a_${suffix}`;
  const projectA2 = `project_memory_a2_${suffix}`;
  const projectB = `project_memory_b_${suffix}`;
  insertProject({
    projectId: projectA,
    orgId: orgA.org_id,
    creatorId: owner.user_id,
    repositories: [
      "acme/checkout",
      "acme/empty",
      "acme/legacy-name",
      "acme/new-name",
      "acme/collision",
    ],
  });
  insertProject({
    projectId: projectA2,
    orgId: orgA.org_id,
    creatorId: owner.user_id,
    repositories: ["acme/new-name"],
  });
  insertProject({
    projectId: projectB,
    orgId: orgB.org_id,
    creatorId: owner.user_id,
    repositories: ["acme/checkout"],
  });

  const seeded = seedMemoryReadFixture({
    orgId: orgA.org_id,
    projectId: projectA,
    repositoryId: "github.com/acme/checkout",
    displaySlug: "Acme/Checkout",
    providerRepositoryId: `github-repo-checkout-a-${suffix}`,
  });
  registerMemoryRepository({
    orgId: orgA.org_id,
    projectId: projectA,
    repositoryId: "github.com/acme/empty",
    displaySlug: "Acme/Empty",
    providerRepositoryId: `github-repo-empty-${suffix}`,
  });
  const otherTenant = seedMemoryReadFixture({
    orgId: orgB.org_id,
    projectId: projectB,
    repositoryId: "github.com/acme/checkout",
    displaySlug: "Acme/Checkout",
    providerRepositoryId: `github-repo-checkout-b-${suffix}`,
  });
  for (const seededTarget of [
    { seeded, orgId: orgA.org_id, projectId: projectA },
    { seeded: otherTenant, orgId: orgB.org_id, projectId: projectB },
  ]) {
    ensureMemoryV2EvidenceVerifiedTrust({
      recordId: seededTarget.seeded.record.record_id,
      recordVersion: seededTarget.seeded.record.record_version,
      orgId: seededTarget.orgId,
      projectId: seededTarget.projectId,
      evidenceVerifiedAt: seededTarget.seeded.record.freshness.last_confirmed_at,
    });
  }

  const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
  const tokenA = createServiceToken({
    orgId: orgA.org_id,
    name: "Memory search A",
    scopes: ["memory:search"],
    createdByUserId: owner.user_id,
    projectId: projectA,
    repositoryIds: ["github.com/acme/checkout"],
    expiresAt,
  }).token;
  const tokenEmptyA = createServiceToken({
    orgId: orgA.org_id,
    name: "Memory search empty A",
    scopes: ["memory:search"],
    createdByUserId: owner.user_id,
    projectId: projectA,
    repositoryIds: ["github.com/acme/empty"],
    expiresAt,
  }).token;
  const tokenB = createServiceToken({
    orgId: orgB.org_id,
    name: "Memory search B",
    scopes: ["memory:search"],
    createdByUserId: owner.user_id,
    projectId: projectB,
    repositoryIds: ["github.com/acme/checkout"],
    expiresAt,
  }).token;
  const tokenWithoutScope = createServiceToken({
    orgId: orgA.org_id,
    name: "No memory search",
    scopes: ["project:read"],
    createdByUserId: owner.user_id,
    projectId: projectA,
    expiresAt,
  }).token;
  const receiptTokenA = createServiceToken({
    orgId: orgA.org_id,
    name: "Memory receipt writer A",
    scopes: ["memory:receipt:write"],
    createdByUserId: owner.user_id,
    projectId: projectA,
    repositoryIds: ["github.com/acme/checkout"],
    expiresAt,
  }).token;
  const receiptTokenB = createServiceToken({
    orgId: orgB.org_id,
    name: "Memory receipt writer B",
    scopes: ["memory:receipt:write"],
    createdByUserId: owner.user_id,
    projectId: projectB,
    repositoryIds: ["github.com/acme/checkout"],
    expiresAt,
  }).token;
  const attestTokenA = createServiceToken({
    orgId: orgA.org_id,
    name: "Memory GitHub attester A",
    scopes: ["memory:attest"],
    createdByUserId: owner.user_id,
    projectId: projectA,
    repositoryIds: ["github.com/acme/checkout"],
    expiresAt,
  }).token;
  const feedbackTokenA = createServiceToken({
    orgId: orgA.org_id,
    name: "Memory feedback writer A",
    scopes: ["memory:feedback:write"],
    createdByUserId: owner.user_id,
    projectId: projectA,
    repositoryIds: ["github.com/acme/checkout"],
    expiresAt,
  }).token;
  const feedbackTokenB = createServiceToken({
    orgId: orgB.org_id,
    name: "Memory feedback writer B",
    scopes: ["memory:feedback:write"],
    createdByUserId: owner.user_id,
    projectId: projectB,
    repositoryIds: ["github.com/acme/checkout"],
    expiresAt,
  }).token;
  const reviewerTokenA = createServiceToken({
    orgId: orgA.org_id,
    name: "Memory reviewer A",
    scopes: ["memory:review"],
    createdByUserId: owner.user_id,
    projectId: projectA,
    repositoryIds: ["github.com/acme/checkout"],
    expiresAt,
  }).token;
  const reviewerTokenB = createServiceToken({
    orgId: orgB.org_id,
    name: "Memory reviewer B",
    scopes: ["memory:review"],
    createdByUserId: owner.user_id,
    projectId: projectB,
    repositoryIds: ["github.com/acme/checkout"],
    expiresAt,
  }).token;
  const candidateReadTokenA = createServiceToken({
    orgId: orgA.org_id,
    name: "Memory candidate reader A",
    scopes: ["memory:candidate:read"],
    createdByUserId: owner.user_id,
    projectId: projectA,
    repositoryIds: ["github.com/acme/checkout"],
    expiresAt,
  }).token;
  const candidateReadTokenB = createServiceToken({
    orgId: orgB.org_id,
    name: "Memory candidate reader B",
    scopes: ["memory:candidate:read"],
    createdByUserId: owner.user_id,
    projectId: projectB,
    repositoryIds: ["github.com/acme/checkout"],
    expiresAt,
  }).token;
  const adminTokenA = createServiceToken({
    orgId: orgA.org_id,
    name: "Memory admin A",
    scopes: ["memory:admin"],
    createdByUserId: owner.user_id,
    projectId: projectA,
    repositoryIds: ["github.com/acme/checkout", "github.com/acme/empty"],
    expiresAt,
  }).token;
  const adminTokenB = createServiceToken({
    orgId: orgB.org_id,
    name: "Memory admin B",
    scopes: ["memory:admin"],
    createdByUserId: owner.user_id,
    projectId: projectB,
    repositoryIds: ["github.com/acme/checkout"],
    expiresAt,
  }).token;
  const harnessReceiptTokenA = createServiceToken({
    orgId: orgA.org_id,
    name: "Example harness A receipt writer",
    scopes: ["memory:harness:receipt:write"],
    createdByUserId: owner.user_id,
    projectId: projectA,
    harnessIds: ["example-harness-a"],
    expiresAt,
  }).token;
  const harnessReviewerTokenA = createServiceToken({
    orgId: orgA.org_id,
    name: "Example harness A reviewer",
    scopes: ["memory:harness:review"],
    createdByUserId: owner.user_id,
    projectId: projectA,
    harnessIds: ["example-harness-a"],
    expiresAt,
  }).token;
  const harnessSearchTokenA = createServiceToken({
    orgId: orgA.org_id,
    name: "Example harness A search consumer",
    scopes: ["memory:harness:search"],
    createdByUserId: owner.user_id,
    projectId: projectA,
    harnessIds: ["example-harness-a"],
    expiresAt,
  }).token;
  const otherHarnessSearchTokenA = createServiceToken({
    orgId: orgA.org_id,
    name: "Example harness B search consumer",
    scopes: ["memory:harness:search"],
    createdByUserId: owner.user_id,
    projectId: projectA,
    harnessIds: ["example-harness-b"],
    expiresAt,
  }).token;
  const otherProjectHarnessSearchTokenA = createServiceToken({
    orgId: orgA.org_id,
    name: "Example harness A search consumer in project A2",
    scopes: ["memory:harness:search"],
    createdByUserId: owner.user_id,
    projectId: projectA2,
    harnessIds: ["example-harness-a"],
    expiresAt,
  }).token;

  const app = Fastify({
    routerOptions: { maxParamLength: MEMORY_V2_PATH_PARAM_MAX_LENGTH },
    ...appOptions,
  });
  registerJsonBodyParser(app);
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (isMemoryApiPath(request.url)) {
      if (isMemoryV2ApiPath(request.url)) {
        sendMemoryV2Error(
          reply,
          statusCode,
          statusCode >= 500 ? "temporarily_unavailable" : "schema_invalid",
          statusCode >= 500 ? "Memory service is temporarily unavailable" : error.message,
        );
        return;
      }
      sendMemoryError(
        reply,
        statusCode,
        statusCode >= 500 ? "temporarily_unavailable" : "schema_invalid",
        statusCode >= 500 ? "Memory service is temporarily unavailable" : error.message,
      );
      return;
    }
    reply.code(statusCode).send({ error: error.message });
  });
  const authenticate = createAuthHook("ims");
  app.addHook("onRequest", async (request, reply) => {
    await authenticate(request, reply);
    if (!reply.sent) await resolveRequestOrg(request, reply);
  });
  await app.register(memoryCapabilitiesRoutes);
  await app.register(memoryAttestationRoutes);
  await app.register(memoryReceiptsRoutes);
  await app.register(memoryCandidatesRoutes);
  await app.register(memoryFeedbackRoutes);
  await app.register(memoryDecisionRoutes);
  await app.register(memorySearchRoutes);
  await app.register(memoryHarnessSearchRoutes);
  if (routeOptions.v2Reads) {
    await app.register(memoryV2CapabilitiesRoutes);
    await app.register(memoryV2BindingRoutes);
    await app.register(memoryV2ReadinessRoutes);
    await app.register(memoryV2SearchRoutes);
  }
  if (routeOptions.v2Writes) {
    await app.register(memoryV2WriteRoutes);
  }
  await app.ready();

  return {
    app,
    orgA: { id: orgA.org_id, slug: orgASlug },
    orgB: { id: orgB.org_id, slug: orgBSlug },
    projectA,
    projectA2,
    projectB,
    tokenA,
    tokenEmptyA,
    tokenB,
    tokenWithoutScope,
    receiptTokenA,
    receiptTokenB,
    attestTokenA,
    feedbackTokenA,
    feedbackTokenB,
    reviewerTokenA,
    reviewerTokenB,
    candidateReadTokenA,
    candidateReadTokenB,
    adminTokenA,
    adminTokenB,
    harnessReceiptTokenA,
    harnessReviewerTokenA,
    harnessSearchTokenA,
    otherHarnessSearchTokenA,
    otherProjectHarnessSearchTokenA,
    seededRecordId: seeded.record.record_id,
    otherTenantRecordId: otherTenant.record.record_id,
  };
}
