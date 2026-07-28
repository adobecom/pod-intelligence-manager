import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  registerHostedSkillTools,
  type HostedSkillsApiClient,
  type HostedSkillsApiPath,
} from "@pim/mcp-server/hosted-skills";
import {
  isServiceTokenValue,
  verifyServiceToken,
  type ServiceTokenScope,
} from "../services/service-tokens.js";
import { findOrgById, getMembership } from "../services/orgs.js";

const REQUIRED_SCOPES = [
  "skill-catalog:read",
  "skill-conflicts:check",
] as const satisfies readonly ServiceTokenScope[];

const LOOPBACK_TIMEOUT_MS = 45_000;

// The downstream conflict route allows 1 MiB of decoded candidate Markdown
// plus request metadata. Leave additional room for the MCP JSON-RPC envelope.
export const HOSTED_MCP_BODY_LIMIT = 1024 * 1024 + 256 * 1024;

interface HostedMcpAuth {
  bearerToken: string;
  orgSlug: string;
}

const authByRequest = new WeakMap<FastifyRequest, HostedMcpAuth>();

declare module "fastify" {
  interface FastifyContextConfig {
    suppressAuthorizationHeaderLogging?: boolean;
    suppressCandidateMarkdownLogging?: boolean;
  }
}

export interface HostedMcpRoutesOptions {
  apiBaseUrl: string;
  fetchImpl?: typeof fetch;
}

class LoopbackSkillsApiClient implements HostedSkillsApiClient {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly auth: HostedMcpAuth,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async post<T>(path: HostedSkillsApiPath, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOPBACK_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.auth.bearerToken}`,
          "content-type": "application/json",
          "x-pim-org": this.auth.orgSlug,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const responseText = await response.text();
      const parsed = parseJson(responseText);
      if (!response.ok) {
        throw new Error(safeApiError(response.status, parsed.value));
      }
      if (!parsed.ok) {
        throw new Error(`PIM API ${response.status} (invalid_json_response)`);
      }
      return parsed.value as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseJson(text: string): { ok: boolean; value: unknown } {
  if (!text) return { ok: false, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, value: undefined };
  }
}

/**
 * Keep upstream failures actionable without ever reflecting candidate Markdown
 * or arbitrary response bodies into application logs.
 */
function safeApiError(status: number, body: unknown): string {
  const fields =
    typeof body === "object" && body !== null
      ? body as { error?: unknown }
      : {};
  const code = typeof fields.error === "string" ? fields.error : "request_failed";
  return `PIM API ${status} (${code})`;
}

function bearerToken(req: FastifyRequest): string | null {
  const value = req.headers.authorization;
  if (!value) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value);
  return match?.[1] ?? null;
}

async function authenticateHostedMcp(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = bearerToken(req);
  if (!token || !isServiceTokenValue(token)) {
    reply.code(401).send({ error: "A PIM service-token Bearer credential is required" });
    return;
  }

  const verified = verifyServiceToken(token);
  if (!verified) {
    reply.code(401).send({ error: "Invalid or expired PIM service token" });
    return;
  }

  if (verified.auth.projectId || verified.auth.podId) {
    reply.code(403).send({
      error: "Hosted MCP requires an organization-wide PIM service token",
    });
    return;
  }

  const granted = new Set<ServiceTokenScope>(verified.auth.scopes);
  const missing = REQUIRED_SCOPES.filter((scope) => !granted.has(scope));
  const extra = verified.auth.scopes.filter(
    (scope) => !(REQUIRED_SCOPES as readonly ServiceTokenScope[]).includes(scope),
  );
  if (missing.length > 0 || extra.length > 0) {
    reply.code(403).send({
      error:
        "Hosted MCP service token must have exactly these scopes: " +
        REQUIRED_SCOPES.join(", "),
      ...(missing.length > 0 ? { missing_scopes: missing } : {}),
      ...(extra.length > 0 ? { extra_scopes: extra } : {}),
    });
    return;
  }

  const org = findOrgById(verified.auth.orgId);
  if (!org) {
    reply.code(403).send({ error: "PIM service token organization no longer exists" });
    return;
  }
  if (!getMembership(org.org_id, verified.user.user_id)) {
    reply.code(403).send({
      error: "Service principal is not a member of its token organization",
    });
    return;
  }

  authByRequest.set(req, {
    bearerToken: token,
    orgSlug: org.slug,
  });
}

function methodNotAllowed(_req: FastifyRequest, reply: FastifyReply) {
  return reply
    .header("Allow", "POST")
    .code(405)
    .send({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
}

function sendRawInternalError(reply: FastifyReply): void {
  if (reply.raw.headersSent) return;
  reply.raw.statusCode = 500;
  reply.raw.setHeader("content-type", "application/json");
  reply.raw.end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code: -32603, message: "Internal server error" },
    id: null,
  }));
}

export default async function hostedMcpRoutes(
  app: FastifyInstance,
  options: HostedMcpRoutesOptions,
): Promise<void> {
  const apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.post(
    "/mcp",
    {
      bodyLimit: HOSTED_MCP_BODY_LIMIT,
      config: {
        suppressRequestBodyLogging: true,
        suppressAuthorizationHeaderLogging: true,
        suppressCandidateMarkdownLogging: true,
      },
      onRequest: authenticateHostedMcp,
    },
    async (req, reply) => {
      const auth = authByRequest.get(req);
      if (!auth) return;
      authByRequest.delete(req);

      const apiClient = new LoopbackSkillsApiClient(
        apiBaseUrl,
        auth,
        fetchImpl,
      );
      const server = new McpServer(
        { name: "pim-hosted-skills", version: "0.1.0" },
        { capabilities: { tools: {} } },
      );
      registerHostedSkillTools(server, apiClient);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        void server.close().catch(() => {
          // Response cleanup is best-effort and must never become unhandled.
        });
      };

      reply.hijack();
      reply.raw.once("finish", cleanup);
      reply.raw.once("close", cleanup);
      reply.raw.once("finish", () => {
        req.log.info(
          { status_code: reply.raw.statusCode },
          "Hosted MCP request completed",
        );
      });

      try {
        await server.connect(transport);
        await transport.handleRequest(req.raw, reply.raw, req.body);
      } catch (error) {
        req.log.error(
          {
            error:
              error instanceof Error
                ? { name: error.name, message: error.message }
                : { name: "Error", message: "Unknown hosted MCP failure" },
          },
          "Hosted MCP request failed",
        );
        sendRawInternalError(reply);
        cleanup();
      }
    },
  );
}
