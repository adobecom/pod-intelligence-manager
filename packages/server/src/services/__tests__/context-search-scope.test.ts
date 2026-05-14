import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const { testDb } = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return { testDb: db };
});

vi.mock("../../db/connection.js", () => ({
  default: testDb,
  withTransaction: (fn: () => unknown) => fn(),
}));

// Knowledge graph has heavy init-time side effects; stub it so importing
// services that touch it doesn't try to load embedding models.
vi.mock("../knowledge-graph.js", () => ({
  initializeKnowledgeGraph: vi.fn(),
  refreshAnalysis: vi.fn(),
  getRelevantLearnings: vi
    .fn()
    .mockReturnValue({ nodes: [], truncated: false, total_matching: 0, token_estimate: 0, edges: [] }),
  getPrecedents: vi.fn().mockReturnValue({ nodes: [] }),
}));

import { createTables } from "../../db/schema.js";
import { upsertUserByIms } from "../users.js";
import { createOrg } from "../orgs.js";
import { resolveScope, loadJiraKeysForUserOrgs } from "../context-search.js";

let userEmail: string;
let userInOrgWithNoJiraEmail: string;
let projectWithJiraId: string;

beforeAll(() => {
  createTables();

  // Strip integration credentials so resolveActor stays offline and fast.
  for (const k of [
    "SLACK_USER_TOKEN_MWP",
    "SLACK_USER_TOKEN_AEM_ENG",
    "SLACK_USER_TOKEN_ADOBEDOTCOM",
    "GH_TOKEN",
  ]) {
    delete process.env[k];
  }

  // Seed: bootstrap a creator user (required by orgs.created_by_user_id),
  // then two test users in two separate orgs. One org has a project with
  // Jira keys configured; the other has only a project with no Jira keys.
  const creator = upsertUserByIms({ email: "creator@adobe.com", display_name: "Creator" });
  const u1 = upsertUserByIms({ email: "rea01581@adobe.com", display_name: "Rayyan Khan" });
  const u2 = upsertUserByIms({ email: "no-jira@adobe.com", display_name: "No Jira" });
  userEmail = u1.email;
  userInOrgWithNoJiraEmail = u2.email;

  const orgWithJira = createOrg({ slug: "acme", name: "Acme", creatorUserId: creator.user_id });
  testDb
    .prepare("INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)")
    .run(orgWithJira.org_id, u1.user_id, new Date().toISOString());

  const orgNoJira = createOrg({ slug: "beta", name: "Beta", creatorUserId: creator.user_id });
  testDb
    .prepare("INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)")
    .run(orgNoJira.org_id, u2.user_id, new Date().toISOString());

  // Two projects with Jira keys in the Acme org (so we can assert dedup +
  // union), one project with no resources in Beta.
  projectWithJiraId = "proj_with_jira";
  testDb
    .prepare(
      "INSERT INTO projects (project_id, name, description, created_at, resources_json, org_id) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      projectWithJiraId,
      "Acme Frontend",
      null,
      new Date().toISOString(),
      JSON.stringify({ jira: { project_keys: ["MWPW", "DOTCOM"] } }),
      orgWithJira.org_id,
    );
  testDb
    .prepare(
      "INSERT INTO projects (project_id, name, description, created_at, resources_json, org_id) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      "proj_with_jira_dupe",
      "Acme Backend",
      null,
      new Date().toISOString(),
      // Includes MWPW again — should dedupe in the union.
      JSON.stringify({ jira: { project_keys: ["MWPW", "WPS"] } }),
      orgWithJira.org_id,
    );
  testDb
    .prepare(
      "INSERT INTO projects (project_id, name, description, created_at, resources_json, org_id) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      "proj_no_jira",
      "Beta Project",
      null,
      new Date().toISOString(),
      // resources_json present but no jira config
      JSON.stringify({ github: { repos: ["adobe-rnd/beta"] } }),
      orgNoJira.org_id,
    );
});

beforeEach(() => {
  // Wipe identity_cache between tests so the offline resolveActor doesn't
  // carry state from a previous run.
  testDb.exec("DELETE FROM identity_cache");
});

describe("loadJiraKeysForUserOrgs", () => {
  it("unions and dedupes Jira keys across projects in the user's orgs", () => {
    const keys = loadJiraKeysForUserOrgs(userEmail);
    expect(keys.sort()).toEqual(["DOTCOM", "MWPW", "WPS"]);
  });

  it("returns [] when the user belongs to an org with no Jira-configured projects", () => {
    const keys = loadJiraKeysForUserOrgs(userInOrgWithNoJiraEmail);
    expect(keys).toEqual([]);
  });

  it("returns [] for an email with no matching user row", () => {
    const keys = loadJiraKeysForUserOrgs("ghost@adobe.com");
    expect(keys).toEqual([]);
  });
});

describe("resolveScope IMS-authenticated-user fallback", () => {
  it("returns no scope when nothing resolves and no authenticated user is passed", async () => {
    const scope = await resolveScope({ query: "milo block init" });
    expect(scope.project_id).toBeUndefined();
    expect(scope.actor).toBeUndefined();
    expect(scope.project_resources).toBeUndefined();
    expect(scope.fallback).toBeUndefined();
  });

  it("fills actor and unions Jira keys from the user's orgs when no other scope resolves", async () => {
    const scope = await resolveScope({ query: "milo block init" }, userEmail);
    expect(scope.actor?.email).toBe(userEmail);
    expect(scope.fallback).toBe("authenticated_user");
    expect(scope.project_resources?.jira?.project_keys?.sort()).toEqual([
      "DOTCOM",
      "MWPW",
      "WPS",
    ]);
  });

  it("fills only actor when the user's orgs have no Jira-configured projects", async () => {
    const scope = await resolveScope(
      { query: "milo block init" },
      userInOrgWithNoJiraEmail,
    );
    expect(scope.actor?.email).toBe(userInOrgWithNoJiraEmail);
    expect(scope.fallback).toBe("authenticated_user");
    expect(scope.project_resources?.jira?.project_keys).toBeUndefined();
  });

  it("does NOT activate when an explicit project_id resolves", async () => {
    const scope = await resolveScope(
      { query: "milo block init", project_id: projectWithJiraId },
      userEmail,
    );
    expect(scope.project_id).toBe(projectWithJiraId);
    expect(scope.fallback).toBeUndefined();
    // The project_resources here come from the explicit project, not the fallback.
    expect(scope.project_resources?.jira?.project_keys?.sort()).toEqual(["DOTCOM", "MWPW"]);
    // Actor is not the authenticated user — only set when explicitly resolved.
    expect(scope.actor).toBeUndefined();
  });

  it("does NOT activate when the caller passes an explicit actor (someone else)", async () => {
    const scope = await resolveScope(
      { query: "milo block init", actor: { email: "someone-else@adobe.com" } },
      userEmail,
    );
    expect(scope.actor?.email).toBe("someone-else@adobe.com");
    expect(scope.fallback).toBeUndefined();
  });

  it("does NOT activate when the query mentions an email (actor auto-detected)", async () => {
    const scope = await resolveScope(
      { query: "what has someone-else@adobe.com been up to" },
      userEmail,
    );
    expect(scope.actor?.email).toBe("someone-else@adobe.com");
    expect(scope.fallback).toBeUndefined();
  });

  it("does NOT activate when the query carries a fixVersion token (release queries)", async () => {
    // A release query like "what's in T3-26.16" already satisfies the
    // Jira scope guard via fixVersion. Narrowing it to the caller as
    // actor would silently drop teammates' results for the release.
    const scope = await resolveScope(
      { query: "what's in T3-26.16" },
      userEmail,
    );
    expect(scope.actor).toBeUndefined();
    expect(scope.fallback).toBeUndefined();
    // Also: scope.project_resources should NOT have been populated from
    // the IMS fallback path, so other integrations don't get narrowed by
    // the caller's orgs either.
    expect(scope.project_resources).toBeUndefined();
  });
});
