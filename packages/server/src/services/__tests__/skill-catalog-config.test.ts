import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { testDb } = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(":memory:");
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
  getSkillCatalogConfiguration,
  resolveSkillCatalogSource,
  setOrgDefaultSkillCatalogSource,
  setProjectSkillCatalogSource,
} from "../skill-catalog-config.js";
import { SkillCatalogError } from "../skill-catalog.js";

const ORG_A = "org-config-a";
const ORG_B = "org-config-b";
const PROJECT_A = "project-config-a";
const PROJECT_B = "project-config-b";
const SOURCE_DEFAULT = "catalog-default";
const SOURCE_OVERRIDE = "catalog-override";
const SOURCE_OTHER_ORG = "catalog-other-org";

function seedOrg(orgId: string): void {
  const now = new Date().toISOString();
  const userId = `user-${orgId}`;
  testDb
    .prepare("INSERT INTO users (user_id, email, created_at) VALUES (?, ?, ?)")
    .run(userId, `${userId}@example.com`, now);
  testDb
    .prepare(
      `INSERT INTO orgs
         (org_id, slug, name, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(orgId, orgId, orgId, userId, now);
}

function seedProject(projectId: string, orgId: string): void {
  testDb
    .prepare(
      `INSERT INTO projects
         (project_id, name, created_at, org_id)
       VALUES (?, ?, ?, ?)`,
    )
    .run(projectId, projectId, new Date().toISOString(), orgId);
}

function seedSource(sourceId: string, orgId: string): void {
  const now = new Date().toISOString();
  testDb
    .prepare(
      `INSERT INTO skill_catalog_sources
         (source_id, org_id, display_name, api_base_url, owner, repo,
          default_ref, layout_rules_json, credential_alias, enabled,
          sync_status, created_at)
       VALUES (?, ?, ?, 'https://api.github.com', 'adobe', ?, 'main',
               '[{"glob":"shared/skills/**/*.md","namespace":"shared"}]',
               'TEST_GITHUB_TOKEN', 1, 'ready', ?)`,
    )
    .run(sourceId, orgId, `Display ${sourceId}`, `repo-${sourceId}`, now);
}

beforeAll(() => {
  createTables();
  seedOrg(ORG_A);
  seedOrg(ORG_B);
  seedProject(PROJECT_A, ORG_A);
  seedProject(PROJECT_B, ORG_B);
});

beforeEach(() => {
  seedSource(SOURCE_DEFAULT, ORG_A);
  seedSource(SOURCE_OVERRIDE, ORG_A);
  seedSource(SOURCE_OTHER_ORG, ORG_B);
});

afterEach(() => {
  testDb.prepare("DELETE FROM skill_catalog_sources").run();
});

afterAll(() => {
  testDb.close();
});

describe("project-aware skill catalog configuration", () => {
  it("resolves explicit override, project mapping, and org default in order", () => {
    setOrgDefaultSkillCatalogSource(ORG_A, SOURCE_DEFAULT);
    setProjectSkillCatalogSource(ORG_A, PROJECT_A, SOURCE_OVERRIDE);

    expect(
      resolveSkillCatalogSource({
        orgId: ORG_A,
        projectId: PROJECT_A,
        sourceId: SOURCE_DEFAULT,
      }),
    ).toMatchObject({
      projectId: PROJECT_A,
      selectionMode: "explicit",
      source: { sourceId: SOURCE_DEFAULT },
    });
    expect(
      resolveSkillCatalogSource({
        orgId: ORG_A,
        projectId: PROJECT_A,
      }),
    ).toMatchObject({
      selectionMode: "project",
      source: { sourceId: SOURCE_OVERRIDE },
    });
    expect(resolveSkillCatalogSource({ orgId: ORG_A })).toMatchObject({
      projectId: null,
      selectionMode: "org_default",
      source: { sourceId: SOURCE_DEFAULT },
    });
  });

  it("falls back after clears and returns the configuration error when both are absent", () => {
    setOrgDefaultSkillCatalogSource(ORG_A, SOURCE_DEFAULT);
    setProjectSkillCatalogSource(ORG_A, PROJECT_A, SOURCE_OVERRIDE);
    const clearedProject = setProjectSkillCatalogSource(
      ORG_A,
      PROJECT_A,
      null,
    );

    expect(clearedProject.selection).toMatchObject({
      projectOverrideSourceId: null,
      effectiveSourceId: SOURCE_DEFAULT,
      mode: "org_default",
    });
    expect(
      resolveSkillCatalogSource({ orgId: ORG_A, projectId: PROJECT_A }),
    ).toMatchObject({
      selectionMode: "org_default",
      source: { sourceId: SOURCE_DEFAULT },
    });

    setOrgDefaultSkillCatalogSource(ORG_A, null);
    expect(() =>
      resolveSkillCatalogSource({ orgId: ORG_A, projectId: PROJECT_A }),
    ).toThrowError(
      expect.objectContaining<Partial<SkillCatalogError>>({
        statusCode: 409,
        code: "skill_catalog_source_not_configured",
      }),
    );
  });

  it("keeps sources, projects, and mappings isolated by organization", () => {
    expect(() =>
      setProjectSkillCatalogSource(
        ORG_A,
        PROJECT_A,
        SOURCE_OTHER_ORG,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<SkillCatalogError>>({
        statusCode: 404,
        code: "source_not_found",
      }),
    );
    expect(() =>
      resolveSkillCatalogSource({
        orgId: ORG_A,
        sourceId: SOURCE_OTHER_ORG,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<SkillCatalogError>>({
        statusCode: 404,
        code: "source_not_found",
      }),
    );
    expect(() =>
      setProjectSkillCatalogSource(ORG_A, PROJECT_B, SOURCE_DEFAULT),
    ).toThrowError(
      expect.objectContaining<Partial<SkillCatalogError>>({
        statusCode: 404,
        code: "project_not_found",
      }),
    );

    expect(() =>
      testDb
        .prepare(
          `INSERT INTO skill_catalog_project_overrides
             (project_id, org_id, source_id, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          PROJECT_A,
          ORG_A,
          SOURCE_OTHER_ORG,
          new Date().toISOString(),
        ),
    ).toThrow(/FOREIGN KEY/);
  });

  it("returns sanitized source metadata and effective project selection", () => {
    setOrgDefaultSkillCatalogSource(ORG_A, SOURCE_DEFAULT);
    const configuration = setProjectSkillCatalogSource(
      ORG_A,
      PROJECT_A,
      SOURCE_OVERRIDE,
    );

    expect(configuration.sources).toHaveLength(2);
    expect(configuration.selection).toMatchObject({
      projectId: PROJECT_A,
      orgDefaultSourceId: SOURCE_DEFAULT,
      projectOverrideSourceId: SOURCE_OVERRIDE,
      effectiveSourceId: SOURCE_OVERRIDE,
      mode: "project",
      effectiveSource: {
        sourceId: SOURCE_OVERRIDE,
        repository: {
          owner: "adobe",
          repo: `repo-${SOURCE_OVERRIDE}`,
          defaultRef: "main",
        },
        syncStatus: "ready",
        latestIndexedCommitSha: null,
      },
    });
    expect(configuration.sources[0]).not.toHaveProperty("credentialAlias");
    expect(configuration.sources[0]).not.toHaveProperty(
      "webhookSecretAlias",
    );
    expect(
      getSkillCatalogConfiguration(ORG_B).sources.map(
        (source) => source.sourceId,
      ),
    ).toEqual([SOURCE_OTHER_ORG]);
  });

  it("allows imported sources with polling disabled to remain selectable", () => {
    testDb
      .prepare(
        "UPDATE skill_catalog_sources SET enabled = 0 WHERE source_id = ?",
      )
      .run(SOURCE_DEFAULT);

    const configuration = setOrgDefaultSkillCatalogSource(
      ORG_A,
      SOURCE_DEFAULT,
    );
    expect(configuration.selection.effectiveSource).toMatchObject({
      sourceId: SOURCE_DEFAULT,
      enabled: false,
    });
    expect(resolveSkillCatalogSource({ orgId: ORG_A })).toMatchObject({
      selectionMode: "org_default",
      source: {
        sourceId: SOURCE_DEFAULT,
        enabled: false,
      },
    });
  });
});
