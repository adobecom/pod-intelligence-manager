import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  scheduleSkillCatalogSourceSync,
} from "../services/skill-catalog-freshness.js";
import { resolveSkillCatalogWebhookSecret } from "../services/skill-catalog.js";

export const SKILL_CATALOG_WEBHOOK_BODY_LIMIT = 1024 * 1024;

const DELIVERY_TTL_MS = 10 * 60_000;
const MAX_TRACKED_DELIVERIES = 10_000;
const DELIVERY_ID_RE = /^[A-Za-z0-9-]{1,200}$/;

const seenDeliveries = new Map<string, number>();

function stringHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function verifyGitHubSignature(
  rawBody: Buffer,
  signatureHeader: string | null,
  secret: string,
): boolean {
  const match = signatureHeader?.match(/^sha256=([0-9a-f]{64})$/i);
  if (!match) return false;
  const presented = Buffer.from(match[1], "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return (
    presented.length === expected.length &&
    timingSafeEqual(presented, expected)
  );
}

function isDuplicateDelivery(
  sourceId: string,
  deliveryId: string,
  nowMs: number,
): boolean {
  for (const [key, expiresAt] of seenDeliveries) {
    if (expiresAt <= nowMs) seenDeliveries.delete(key);
  }
  const key = `${sourceId}:${deliveryId}`;
  if ((seenDeliveries.get(key) ?? 0) > nowMs) return true;
  seenDeliveries.set(key, nowMs + DELIVERY_TTL_MS);
  while (seenDeliveries.size > MAX_TRACKED_DELIVERIES) {
    const oldest = seenDeliveries.keys().next().value as string | undefined;
    if (!oldest) break;
    seenDeliveries.delete(oldest);
  }
  return false;
}

function payloadRepositoryFullName(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const repository = (payload as { repository?: unknown }).repository;
  if (!repository || typeof repository !== "object") return null;
  const fullName = (repository as { full_name?: unknown }).full_name;
  return typeof fullName === "string" ? fullName : null;
}

export default async function skillCatalogWebhookRoutes(
  app: FastifyInstance,
): Promise<void> {
  // GitHub signs the exact request bytes. Override the root JSON parser only in
  // this encapsulated plugin so authenticated JSON routes keep normal parsing.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { bodyLimit: SKILL_CATALOG_WEBHOOK_BODY_LIMIT, parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  app.post<{
    Body: Buffer;
    Params: { sourceId: string };
  }>(
    "/api/skill-catalog/webhooks/github/:sourceId",
    {
      bodyLimit: SKILL_CATALOG_WEBHOOK_BODY_LIMIT,
      config: { suppressRequestBodyLogging: true },
    },
    async (req, reply) => {
      const receivedAtMs = Date.now();
      const source = resolveSkillCatalogWebhookSecret(req.params.sourceId);
      if (source.status !== "ready") {
        req.log.warn(
          {
            source_id: req.params.sourceId,
            webhook_config_status: source.status,
          },
          "Skill catalog webhook authentication failed",
        );
        reply.code(401);
        return { error: "invalid_webhook_signature" };
      }

      const signature = stringHeader(req.headers["x-hub-signature-256"]);
      if (!verifyGitHubSignature(req.body, signature, source.secret)) {
        reply.code(401);
        return { error: "invalid_webhook_signature" };
      }

      const deliveryId = stringHeader(req.headers["x-github-delivery"]);
      if (!deliveryId || !DELIVERY_ID_RE.test(deliveryId)) {
        reply.code(400);
        return { error: "invalid_webhook_delivery" };
      }
      const event = stringHeader(req.headers["x-github-event"]);
      if (event !== "push") {
        reply.code(202);
        return { accepted: false, ignored: true };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(req.body.toString("utf8")) as unknown;
      } catch {
        reply.code(400);
        return { error: "invalid_webhook_payload" };
      }
      const fullName = payloadRepositoryFullName(payload);
      const expectedFullName = `${source.owner}/${source.repo}`;
      if (
        !fullName ||
        fullName.toLowerCase() !== expectedFullName.toLowerCase()
      ) {
        req.log.warn(
          {
            delivery_id: deliveryId,
            source_id: source.sourceId,
          },
          "Skill catalog webhook repository did not match its source",
        );
        reply.code(202);
        return { accepted: false, ignored: true };
      }

      if (isDuplicateDelivery(source.sourceId, deliveryId, receivedAtMs)) {
        reply.code(202);
        return { accepted: true, duplicate: true };
      }

      void scheduleSkillCatalogSourceSync({
        orgId: source.orgId,
        sourceId: source.sourceId,
        trigger: "webhook",
        webhookReceivedAtMs: receivedAtMs,
        log: req.log,
      }).catch((error) => {
        req.log.error(
          {
            error: error instanceof Error ? error.message : String(error),
            source_id: source.sourceId,
          },
          "Skill catalog webhook sync queue failed",
        );
      });
      reply.code(202);
      return { accepted: true };
    },
  );
}

export function resetSkillCatalogWebhookDeliveriesForTests(): void {
  seenDeliveries.clear();
}
