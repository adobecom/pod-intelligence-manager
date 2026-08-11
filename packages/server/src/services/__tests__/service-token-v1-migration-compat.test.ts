import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { testDb } = vi.hoisted(() => {
  const { DatabaseSync: HoistedDatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const database = new HoistedDatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  return { testDb: database };
});

vi.mock("../../db/connection.js", () => ({
  default: testDb,
  withTransaction: (fn: () => unknown) => fn(),
  withImmediateTransaction: (fn: () => unknown) => fn(),
}));

import { createTables } from "../../db/schema.js";
import {
  createServiceToken,
  verifyServiceToken,
} from "../service-tokens.js";

const OWNER_USER_ID = "user_v1_migration_owner";
const ORG_ID = "org_v1_migration_compat";
const PROJECT_ID = "project_v1_migration_compat";

describe("generic v1 service-token migration compatibility", () => {
  beforeAll(() => {
    createTables({ memoryMigrationThroughVersion: 11 });

    const now = new Date().toISOString();
    testDb.prepare(
      `INSERT INTO users
         (user_id, ims_user_id, email, display_name, is_service, created_at, last_login_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      OWNER_USER_ID,
      "ims-v1-migration-owner",
      "v1-migration-owner@example.test",
      "V1 Migration Owner",
      now,
      now,
    );
    testDb.prepare(
      `INSERT INTO orgs (org_id, slug, name, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(ORG_ID, "v1-migration-compat", "V1 Migration Compatibility", OWNER_USER_ID, now);
    testDb.prepare(
      `INSERT INTO projects
         (project_id, name, description, created_at, anatomy_json, org_id, created_by_user_id)
       VALUES (?, ?, NULL, ?, '{}', ?, ?)`,
    ).run(PROJECT_ID, "V1 Migration Project", now, ORG_ID, OWNER_USER_ID);
  });

  afterAll(() => {
    testDb.close();
  });

  it("authenticates a generic project-scoped token without migration-012 tables", () => {
    expect(testDb.prepare(
      "SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1",
    ).get()).toEqual({ version: 11, name: "memory_attestation_diff_proof" });
    expect(testDb.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'memory_v2_resources'",
    ).get()).toBeUndefined();

    const created = createServiceToken({
      orgId: ORG_ID,
      name: "Generic v1 verifier regression",
      scopes: ["project:read"],
      createdByUserId: OWNER_USER_ID,
      projectId: PROJECT_ID,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });

    const verified = verifyServiceToken(created.token);

    expect(verified).toMatchObject({
      user: { is_service: 1 },
      auth: {
        kind: "service_token",
        tokenId: created.token_id,
        servicePrincipalId: created.service_principal_id,
        scopes: ["project:read"],
        orgId: ORG_ID,
        projectId: PROJECT_ID,
        repositoryBindings: [],
        harnessBindings: [],
      },
    });
  });
});
