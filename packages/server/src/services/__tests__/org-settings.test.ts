import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
  withImmediateTransaction: (fn: () => unknown) => fn(),
}));

import { ORG_CONFIG_ROW_KEY, createTables } from "../../db/schema.js";
import { getDefaultKgContextContract, getOrgConfig, setOrgConfig } from "../org-settings.js";

let seq = 0;

function seedOrg(): string {
  const now = new Date().toISOString();
  const orgId = `org-settings-${seq++}`;
  const userId = `user-${orgId}`;
  testDb.prepare("INSERT INTO users (user_id, email, created_at) VALUES (?, ?, ?)").run(
    userId,
    `${orgId}@example.com`,
    now,
  );
  testDb
    .prepare("INSERT INTO orgs (org_id, slug, name, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(orgId, orgId, "Org Settings Test", userId, now);
  return orgId;
}

beforeAll(() => {
  createTables();
});

afterAll(() => {
  testDb.close();
});

describe("org settings", () => {
  it("preserves kg_context_contract when a config update omits it", () => {
    const orgId = seedOrg();

    setOrgConfig(orgId, {
      scopes: [{ id: "frontend", label: "Frontend" }],
      kg_context_contract: "task_relevant",
    });

    const updated = setOrgConfig(orgId, {
      scopes: [{ id: "backend", label: "Backend" }],
    });

    expect(updated).toEqual({
      scopes: [{ id: "backend", label: "Backend" }],
      kg_context_contract: "task_relevant",
    });
    expect(getOrgConfig(orgId).kg_context_contract).toBe("task_relevant");

    const row = testDb
      .prepare("SELECT value_json FROM org_settings WHERE org_id = ? AND key = ?")
      .get(orgId, ORG_CONFIG_ROW_KEY) as { value_json: string };
    expect(JSON.parse(row.value_json)).toEqual({
      scopes: [{ id: "backend", label: "Backend" }],
      kg_context_contract: "task_relevant",
    });
  });

  it("keeps valid scopes when a stored kg_context_contract is invalid", () => {
    const orgId = seedOrg();
    testDb.prepare("INSERT INTO org_settings (org_id, key, value_json) VALUES (?, ?, ?)").run(
      orgId,
      ORG_CONFIG_ROW_KEY,
      JSON.stringify({
        scopes: [{ id: "checkout", label: "Checkout" }],
        kg_context_contract: "invalid-mode",
      }),
    );

    expect(getOrgConfig(orgId)).toEqual({
      scopes: [{ id: "checkout", label: "Checkout" }],
      kg_context_contract: getDefaultKgContextContract(),
    });
  });
});
