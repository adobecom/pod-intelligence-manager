import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const freshnessMocks = vi.hoisted(() => ({
  scheduleSkillCatalogSourceSync: vi.fn(),
}));

const catalogMocks = vi.hoisted(() => ({
  resolveSkillCatalogWebhookSecret: vi.fn(),
}));

vi.mock("../../services/skill-catalog-freshness.js", () => freshnessMocks);
vi.mock("../../services/skill-catalog.js", () => catalogMocks);

import { registerJsonBodyParser } from "../../middleware/validation.js";
import skillCatalogWebhookRoutes, {
  resetSkillCatalogWebhookDeliveriesForTests,
  SKILL_CATALOG_WEBHOOK_BODY_LIMIT,
} from "../skill-catalog-webhooks.js";

const SOURCE_ID = "mimir-main";
const SECRET = "test-webhook-secret";

let app: FastifyInstance;

function signature(rawBody: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function pushBody(repository = "Adobe-acom/mimir"): string {
  return JSON.stringify({
    ref: "refs/heads/main",
    repository: { full_name: repository },
    message: "Unicode remains exact: café 東京",
  });
}

function webhookHeaders(
  rawBody: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-github-delivery": "delivery-123",
    "x-github-event": "push",
    "x-hub-signature-256": signature(rawBody),
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetSkillCatalogWebhookDeliveriesForTests();
  catalogMocks.resolveSkillCatalogWebhookSecret.mockReturnValue({
    status: "ready",
    orgId: "org-route",
    sourceId: SOURCE_ID,
    owner: "Adobe-acom",
    repo: "mimir",
    secret: SECRET,
  });
  freshnessMocks.scheduleSkillCatalogSourceSync.mockResolvedValue({
    failures: 0,
    lastResult: null,
    runs: 1,
  });

  app = Fastify();
  registerJsonBodyParser(app);
  app.post<{ Body: { value: string } }>("/normal-json", async (req) => ({
    isBuffer: Buffer.isBuffer(req.body),
    value: req.body.value,
  }));
  app.register(skillCatalogWebhookRoutes);
  await app.ready();
});

afterEach(async () => {
  resetSkillCatalogWebhookDeliveriesForTests();
  await app.close();
});

describe("GitHub skill catalog webhook", () => {
  it("verifies the exact raw bytes and enqueues a configured source", async () => {
    const rawBody = ` {\n  "repository": {"full_name":"Adobe-acom/mimir"},\n  "message":"café 東京"\n}`;
    const response = await app.inject({
      method: "POST",
      url: `/api/skill-catalog/webhooks/github/${SOURCE_ID}`,
      headers: webhookHeaders(rawBody),
      payload: rawBody,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ accepted: true });
    expect(freshnessMocks.scheduleSkillCatalogSourceSync).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-route",
        sourceId: SOURCE_ID,
        trigger: "webhook",
        webhookReceivedAtMs: expect.any(Number),
      }),
    );
  });

  it("rejects missing or forged signatures before enqueuing work", async () => {
    const rawBody = pushBody();
    const forged = await app.inject({
      method: "POST",
      url: `/api/skill-catalog/webhooks/github/${SOURCE_ID}`,
      headers: webhookHeaders(rawBody, {
        "x-hub-signature-256": `sha256=${"0".repeat(64)}`,
      }),
      payload: rawBody,
    });
    const missing = await app.inject({
      method: "POST",
      url: `/api/skill-catalog/webhooks/github/${SOURCE_ID}`,
      headers: webhookHeaders(rawBody, {
        "x-hub-signature-256": "",
      }),
      payload: rawBody,
    });

    expect(forged.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);
    expect(freshnessMocks.scheduleSkillCatalogSourceSync).not.toHaveBeenCalled();
  });

  it("deduplicates a signed delivery within the bounded TTL window", async () => {
    const rawBody = pushBody();
    const request = {
      method: "POST" as const,
      url: `/api/skill-catalog/webhooks/github/${SOURCE_ID}`,
      headers: webhookHeaders(rawBody),
      payload: rawBody,
    };
    const first = await app.inject(request);
    const duplicate = await app.inject(request);

    expect(first.json()).toEqual({ accepted: true });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toEqual({ accepted: true, duplicate: true });
    expect(freshnessMocks.scheduleSkillCatalogSourceSync).toHaveBeenCalledTimes(1);
  });

  it("does not enqueue unsupported events or a mismatched repository", async () => {
    const pingBody = JSON.stringify({ zen: "Keep it logically awesome." });
    const ping = await app.inject({
      method: "POST",
      url: `/api/skill-catalog/webhooks/github/${SOURCE_ID}`,
      headers: webhookHeaders(pingBody, { "x-github-event": "ping" }),
      payload: pingBody,
    });
    const wrongRepoBody = pushBody("another-org/another-repo");
    const wrongRepo = await app.inject({
      method: "POST",
      url: `/api/skill-catalog/webhooks/github/${SOURCE_ID}`,
      headers: webhookHeaders(wrongRepoBody, {
        "x-github-delivery": "delivery-456",
      }),
      payload: wrongRepoBody,
    });

    expect(ping.json()).toEqual({ accepted: false, ignored: true });
    expect(wrongRepo.json()).toEqual({ accepted: false, ignored: true });
    expect(freshnessMocks.scheduleSkillCatalogSourceSync).not.toHaveBeenCalled();
  });

  it("bounds raw webhook bodies without changing normal JSON parsing", async () => {
    const normal = await app.inject({
      method: "POST",
      url: "/normal-json",
      payload: { value: "parsed" },
    });
    expect(normal.json()).toEqual({ isBuffer: false, value: "parsed" });

    const oversized = JSON.stringify({
      repository: { full_name: "Adobe-acom/mimir" },
      padding: "x".repeat(SKILL_CATALOG_WEBHOOK_BODY_LIMIT),
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/skill-catalog/webhooks/github/${SOURCE_ID}`,
      headers: webhookHeaders(oversized, {
        "x-github-delivery": "delivery-oversized",
      }),
      payload: oversized,
    });
    expect(response.statusCode).toBe(413);
    expect(freshnessMocks.scheduleSkillCatalogSourceSync).not.toHaveBeenCalled();
  });
});
