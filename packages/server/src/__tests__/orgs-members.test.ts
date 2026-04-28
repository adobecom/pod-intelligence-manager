import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const { testDb } = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return { testDb: db };
});

vi.mock("../db/connection.js", () => ({
  default: testDb,
  withTransaction: (fn: () => unknown) => fn(),
}));

// Knowledge graph has side-effects at import; stub it
vi.mock("../services/knowledge-graph.js", () => ({
  initializeKnowledgeGraph: vi.fn(),
  refreshAnalysis: vi.fn(),
  getRelevantLearnings: vi.fn().mockReturnValue({ nodes: [], truncated: false, total_matching: 0, token_estimate: 0, edges: [] }),
  getPrecedents: vi.fn().mockReturnValue({ nodes: [] }),
}));

import { createTables } from "../db/schema.js";
import orgsRoutes from "../routes/orgs.js";
import { upsertUserByIms, type UserRecord } from "../services/users.js";
import { createOrg } from "../services/orgs.js";
import type { FastifyRequest } from "fastify";

/**
 * Build a Fastify app that authenticates as the user supplied in the
 * `X-Test-User-Email` header. This lets a single test exercise multiple
 * identities (inviter, invitee, unrelated user) without spinning up the
 * full IMS stack.
 */
function buildApp(): FastifyInstance {
  const app = Fastify();

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    reply.code(err.statusCode ?? 500).send({ error: err.message });
  });

  app.addHook("onRequest", async (req: FastifyRequest, reply) => {
    const email = req.headers["x-test-user-email"];
    if (typeof email !== "string" || !email) {
      reply.code(401).send({ error: "Missing X-Test-User-Email" });
      return;
    }
    const user = upsertUserByIms({ email, display_name: email });
    (req as FastifyRequest & { userRecord: UserRecord }).userRecord = user;
  });

  app.register(orgsRoutes);
  return app;
}

let app: FastifyInstance;
let ownerUserId: string;
let orgSlug: string;

beforeAll(async () => {
  createTables();
  app = buildApp();
  await app.ready();

  const owner = upsertUserByIms({ email: "owner@example.com", display_name: "Owner" });
  ownerUserId = owner.user_id;
  const org = createOrg({ slug: "acme", name: "Acme", creatorUserId: ownerUserId });
  orgSlug = org.slug;
});

afterAll(async () => {
  await app.close();
  testDb.close();
});

async function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  email: string,
  payload?: unknown,
) {
  const headers: Record<string, string> = { "x-test-user-email": email };
  if (payload !== undefined) headers["content-type"] = "application/json";
  return app.inject({
    method,
    url,
    headers,
    payload: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
}

describe("Org members + invites", () => {
  let inviteId = "";

  it("owner can invite by email", async () => {
    const res = await call("POST", `/api/orgs/${orgSlug}/invites`, "owner@example.com", {
      email: "newbie@example.com",
      role: "member",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.email).toBe("newbie@example.com");
    expect(body.role).toBe("member");
    inviteId = body.invite_id;
  });

  it("non-member cannot list members", async () => {
    const res = await call("GET", `/api/orgs/${orgSlug}/members`, "stranger@example.com");
    expect(res.statusCode).toBe(403);
  });

  it("owner sees the pending invite in /members", async () => {
    const res = await call("GET", `/api/orgs/${orgSlug}/members`, "owner@example.com");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.invites).toHaveLength(1);
    expect(body.invites[0].email).toBe("newbie@example.com");
  });

  it("invitee sees the invite in /api/me", async () => {
    const res = await call("GET", "/api/me", "newbie@example.com");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pending_invites).toHaveLength(1);
    expect(body.pending_invites[0].org_slug).toBe(orgSlug);
  });

  it("wrong email cannot accept someone else's invite", async () => {
    const res = await call("POST", `/api/orgs/accept/${inviteId}`, "stranger@example.com");
    expect(res.statusCode).toBe(403);
  });

  it("invitee accepts → becomes member", async () => {
    const res = await call("POST", `/api/orgs/accept/${inviteId}`, "newbie@example.com");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.role).toBe("member");

    const members = (await call("GET", `/api/orgs/${orgSlug}/members`, "owner@example.com")).json();
    expect(members.members).toHaveLength(2);
    expect(members.invites).toHaveLength(0);
  });

  it("member cannot invite others", async () => {
    const res = await call("POST", `/api/orgs/${orgSlug}/invites`, "newbie@example.com", {
      email: "another@example.com",
      role: "member",
    });
    expect(res.statusCode).toBe(403);
  });

  it("owner can promote member to admin", async () => {
    const newbieUser = upsertUserByIms({ email: "newbie@example.com" });
    const res = await call(
      "PATCH",
      `/api/orgs/${orgSlug}/members/${newbieUser.user_id}`,
      "owner@example.com",
      { role: "admin" },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe("admin");
  });

  it("promoted admin can now invite", async () => {
    const res = await call("POST", `/api/orgs/${orgSlug}/invites`, "newbie@example.com", {
      email: "third@example.com",
      role: "member",
    });
    expect(res.statusCode).toBe(200);
  });

  it("owner cannot be demoted when they're the last owner", async () => {
    const res = await call(
      "PATCH",
      `/api/orgs/${orgSlug}/members/${ownerUserId}`,
      "owner@example.com",
      { role: "member" },
    );
    expect(res.statusCode).toBe(400);
  });

  it("owner can remove a member", async () => {
    const newbieUser = upsertUserByIms({ email: "newbie@example.com" });
    const res = await call(
      "DELETE",
      `/api/orgs/${orgSlug}/members/${newbieUser.user_id}`,
      "owner@example.com",
    );
    expect(res.statusCode).toBe(200);

    const check = await call("GET", `/api/orgs/${orgSlug}/members`, "owner@example.com");
    const emails = check.json().members.map((m: { email: string }) => m.email);
    expect(emails).not.toContain("newbie@example.com");
  });

  it("owner can revoke a pending invite", async () => {
    const invite = (
      await call("POST", `/api/orgs/${orgSlug}/invites`, "owner@example.com", {
        email: "revoke-me@example.com",
        role: "member",
      })
    ).json();

    const res = await call(
      "DELETE",
      `/api/orgs/${orgSlug}/invites/${invite.invite_id}`,
      "owner@example.com",
    );
    expect(res.statusCode).toBe(200);

    const membersRes = await call("GET", `/api/orgs/${orgSlug}/members`, "owner@example.com");
    const emails = membersRes.json().invites.map((i: { email: string }) => i.email);
    expect(emails).not.toContain("revoke-me@example.com");
  });

  it("inviting the same email twice returns the same invite", async () => {
    const first = (
      await call("POST", `/api/orgs/${orgSlug}/invites`, "owner@example.com", {
        email: "dedupe@example.com",
        role: "member",
      })
    ).json();
    const second = (
      await call("POST", `/api/orgs/${orgSlug}/invites`, "owner@example.com", {
        email: "dedupe@example.com",
        role: "member",
      })
    ).json();
    expect(second.invite_id).toBe(first.invite_id);
  });
});
