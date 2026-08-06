import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { testDb, pollSlackProjectSource } = vi.hoisted(() => {
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  return {
    testDb: database,
    pollSlackProjectSource: vi.fn(),
  };
});

vi.mock("../../db/connection.js", () => ({
  default: testDb,
  withTransaction: (fn: () => unknown) => fn(),
  withImmediateTransaction: (fn: () => unknown) => fn(),
}));

vi.mock("../project-slack-source.js", () => ({
  pollSlackProjectSource,
}));

vi.mock("../knowledge-graph.js", () => ({
  addLearningsToGraph: vi.fn(async () => ({ nodesAdded: 0, edgesAdded: 0, nodeIds: [] })),
  getGraph: vi.fn(() => ({ nodes: [], edges: [] })),
  queryKnowledge: vi.fn(() => ({
    nodes: [],
    edges: [],
    total_matching: 0,
    token_estimate: 0,
    truncated: false,
  })),
  retractProjectEvidenceKnowledgeNodes: vi.fn(() => []),
}));

import type {
  PollSlackProjectSourceResult,
  SlackPollState,
} from "../project-slack-source.js";
import { createTables } from "../../db/schema.js";
import { createOrg } from "../orgs.js";
import {
  getProjectSourceSyncState,
  projectSourceId,
} from "../project-source-change.js";
import { syncSlackProjectSource } from "../project-slack-sync.js";
import { getProjectSourceHealth } from "../project-memory.js";
import { upsertUserByIms } from "../users.js";

const ORG_ID = "org_slack_sync";
const PROJECT_ID = "project-slack-sync";
const POLL_AT = "2026-07-19T12:00:00.000Z";
const RECONCILED_AT = "2026-07-19T11:59:00.000Z";
const THREAD_TS = "1752926340.000001";
const THREAD_BODY = "Deploy approval thread with token=raw-routing-secret-value";
let creatorUserId = "";

const routingState: SlackPollState = {
  channels: {
    "T_OK:CDEPLOY": {
      workspace_id: "T_OK",
      channel_id: "CDEPLOY",
      watermark: "1752926400.000000",
      last_success_at: POLL_AT,
      last_reconciliation_at: RECONCILED_AT,
      threads: {
        [THREAD_TS]: {
          native_id: `CDEPLOY:${THREAD_TS}`,
          source_version: "a".repeat(64),
          root_hint: "b".repeat(64),
          occurred_at: "2026-07-19T11:59:00.000Z",
          updated_at: "2026-07-19T11:59:30.000Z",
          message_timestamps: [THREAD_TS, "1752926370.000002"],
        },
      },
    },
  },
};

function successfulPoll(changes = true): PollSlackProjectSourceResult {
  return {
    source: "slack",
    changes: changes
      ? [{
          org_id: ORG_ID,
          project_id: PROJECT_ID,
          source: "slack",
          source_instance: "T_OK",
          native_id: `CDEPLOY:${THREAD_TS}`,
          kind: "upsert",
          source_version: "a".repeat(64),
          visibility: "project_visible",
          visibility_version: "project-visible-v1",
          occurred_at: "2026-07-19T11:59:00.000Z",
          updated_at: "2026-07-19T11:59:30.000Z",
          evidence: {
            source_type: "thread",
            source_url: `https://workspace.slack.com/archives/CDEPLOY/p${THREAD_TS.replace(".", "")}`,
            source_title: "#deploy: Deployment approval",
            summary: "Deployment approval",
            body: THREAD_BODY,
            author: "U_RELEASE",
            metadata: {
              workspace_id: "T_OK",
              channel_id: "CDEPLOY",
              thread_ts: THREAD_TS,
              reply_count: 1,
            },
            confidence_score: 0.65,
            promotable: false,
          },
        }]
      : [],
    state: routingState,
    health: {
      source: "slack",
      configured: true,
      configured_bindings: 1,
      admitted_bindings: 1,
      credential_state: "ok",
      last_attempt_at: POLL_AT,
      last_success_at: POLL_AT,
      last_reconciliation_at: RECONCILED_AT,
      lag_seconds: 30,
      indexed_thread_count: 1,
      retry_count: 0,
      bindings: [{
        binding: "T_OK:CDEPLOY",
        workspace_id: "T_OK",
        channel_id: "CDEPLOY",
        status: "ok",
        last_success_at: POLL_AT,
        last_reconciliation_at: RECONCILED_AT,
        lag_seconds: 30,
        indexed_thread_count: 1,
        retry_count: 0,
      }],
      errors: [],
    },
  };
}

beforeAll(() => {
  createTables();
  const creator = upsertUserByIms({
    email: "slack-sync@example.test",
    display_name: "Slack Sync",
  });
  creatorUserId = creator.user_id;
  createOrg({
    orgId: ORG_ID,
    slug: "slack-sync",
    name: "Slack Sync",
    creatorUserId,
  });
});

afterAll(() => {
  delete process.env.PROJECT_SLACK_INGESTION_ENABLED;
  delete process.env.SLACK_BOT_TOKEN;
  testDb.close();
});

beforeEach(() => {
  process.env.PROJECT_SLACK_INGESTION_ENABLED = "1";
  process.env.SLACK_BOT_TOKEN = "xoxb-health-fixture-token";
  vi.clearAllMocks();
  testDb.prepare("DELETE FROM projects WHERE org_id = ?").run(ORG_ID);
  testDb.prepare(
    `INSERT INTO projects
       (project_id, name, created_at, resources_json, org_id, created_by_user_id)
     VALUES (?, 'Slack Sync', ?, ?, ?, ?)`,
  ).run(
    PROJECT_ID,
    POLL_AT,
    JSON.stringify({ slack: { channels: ["T_OK:CDEPLOY"] } }),
    ORG_ID,
    creatorUserId,
  );
});

describe("syncSlackProjectSource persistence", () => {
  it("applies SourceChanges, stores routing-only state, and reuses that state on the next poll", async () => {
    pollSlackProjectSource
      .mockResolvedValueOnce(successfulPoll())
      .mockResolvedValueOnce(successfulPoll(false));

    const first = await syncSlackProjectSource(ORG_ID, PROJECT_ID, {
      slack: { channels: ["T_OK:CDEPLOY"] },
    });

    expect(first).toEqual({
      source: "slack",
      ingested: 1,
      deleted: 0,
      quarantined: 0,
    });
    const evidence = testDb.prepare(
      `SELECT source_id, source_instance, native_id, body
       FROM project_evidence_items
       WHERE org_id = ? AND project_id = ? AND source = 'slack'`,
    ).get(ORG_ID, PROJECT_ID) as {
      source_id: string;
      source_instance: string;
      native_id: string;
      body: string;
    };
    expect(evidence).toMatchObject({
      source_id: projectSourceId("slack", "T_OK", `CDEPLOY:${THREAD_TS}`),
      source_instance: "T_OK",
      native_id: `CDEPLOY:${THREAD_TS}`,
    });
    expect(evidence.body).toContain("[REDACTED:Generic Secret]");
    expect(evidence.body).not.toContain("raw-routing-secret-value");
    expect(testDb.prepare(
      `SELECT COUNT(*) AS count FROM project_search_documents
       WHERE org_id = ? AND project_id = ? AND source = 'slack'`,
    ).get(ORG_ID, PROJECT_ID)).toMatchObject({ count: 1 });

    const cursor = testDb.prepare(
      `SELECT cursor_value FROM project_ingestion_cursors
       WHERE org_id = ? AND project_id = ? AND source = 'slack' AND cursor_key = 'poll_state:v1'`,
    ).get(ORG_ID, PROJECT_ID) as { cursor_value: string };
    expect(JSON.parse(cursor.cursor_value)).toEqual(routingState);
    expect(cursor.cursor_value).not.toContain(THREAD_BODY);
    expect(cursor.cursor_value).not.toContain("raw-routing-secret-value");
    expect(routingState.channels["T_OK:CDEPLOY"].threads[THREAD_TS]).toEqual({
      native_id: `CDEPLOY:${THREAD_TS}`,
      source_version: "a".repeat(64),
      root_hint: "b".repeat(64),
      occurred_at: "2026-07-19T11:59:00.000Z",
      updated_at: "2026-07-19T11:59:30.000Z",
      message_timestamps: [THREAD_TS, "1752926370.000002"],
    });

    const health = getProjectSourceSyncState(ORG_ID, PROJECT_ID, "slack", "T_OK:CDEPLOY");
    expect(health).toMatchObject({
      source_instance: "T_OK:CDEPLOY",
      indexed_count: 1,
      retry_count: 0,
      lag_seconds: 30,
      last_reconciliation_at: RECONCILED_AT,
    });
    expect(health?.last_success_at).toBeDefined();

    const second = await syncSlackProjectSource(ORG_ID, PROJECT_ID, {
      slack: { channels: ["T_OK:CDEPLOY"] },
    });
    expect(second.ingested).toBe(0);
    expect(pollSlackProjectSource.mock.calls[1][0]).toMatchObject({
      org_id: ORG_ID,
      project_id: PROJECT_ID,
      bindings: ["T_OK:CDEPLOY"],
      previous_state: routingState,
    });
  });

  it("persists generic per-binding failure state instead of connector details", async () => {
    const connectorDetail = "Slack history failed at https://secret.example/path?token=raw-health-secret";
    pollSlackProjectSource.mockResolvedValueOnce({
      source: "slack",
      changes: [],
      state: { channels: {} },
      health: {
        source: "slack",
        configured: true,
        configured_bindings: 1,
        admitted_bindings: 0,
        credential_state: "misconfigured",
        last_attempt_at: POLL_AT,
        indexed_thread_count: 0,
        retry_count: 0,
        bindings: [{
          binding: "T_FAIL:CFAIL",
          workspace_id: "T_FAIL",
          channel_id: "CFAIL",
          status: "error",
          indexed_thread_count: 0,
          retry_count: 0,
          message: connectorDetail,
        }],
        errors: [connectorDetail],
      },
    } satisfies PollSlackProjectSourceResult);

    const result = await syncSlackProjectSource(ORG_ID, PROJECT_ID, {
      slack: { channels: ["T_FAIL:CFAIL"] },
    });

    expect(result).toEqual({
      source: "slack",
      ingested: 0,
      deleted: 0,
      quarantined: 0,
      missing: "slack_source_partial_or_total_failure",
    });
    const health = getProjectSourceSyncState(ORG_ID, PROJECT_ID, "slack", "T_FAIL:CFAIL");
    expect(health).toMatchObject({
      source_instance: "T_FAIL:CFAIL",
      retry_count: 1,
      last_error_code: "slack_error",
      last_error_message: "slack_error",
    });
    expect(JSON.stringify(health)).not.toContain(connectorDetail);
    expect(JSON.stringify(health)).not.toContain("raw-health-secret");
    const persisted = testDb.prepare(
      `SELECT cursor_value FROM project_ingestion_cursors
       WHERE org_id = ? AND project_id = ? AND source = 'slack' AND cursor_key = 'poll_state:v1'`,
    ).get(ORG_ID, PROJECT_ID) as { cursor_value: string };
    expect(persisted.cursor_value).toBe(JSON.stringify({ channels: {} }));
    expect(persisted.cursor_value).not.toContain(connectorDetail);
  });

  it("retains evidence and the last good cursor across a transient channel failure", async () => {
    pollSlackProjectSource
      .mockResolvedValueOnce(successfulPoll())
      .mockResolvedValueOnce({
        source: "slack",
        changes: [],
        state: { channels: {} },
        health: {
          source: "slack",
          configured: true,
          configured_bindings: 1,
          admitted_bindings: 0,
          credential_state: "unreachable",
          last_attempt_at: POLL_AT,
          indexed_thread_count: 0,
          retry_count: 3,
          bindings: [{
            binding: "T_OK:CDEPLOY",
            workspace_id: "T_OK",
            channel_id: "CDEPLOY",
            status: "error",
            indexed_thread_count: 0,
            retry_count: 3,
          }],
          errors: ["transient history failure"],
        },
      } satisfies PollSlackProjectSourceResult);

    await syncSlackProjectSource(ORG_ID, PROJECT_ID, { slack: { channels: ["T_OK:CDEPLOY"] } });
    const failed = await syncSlackProjectSource(ORG_ID, PROJECT_ID, { slack: { channels: ["T_OK:CDEPLOY"] } });

    expect(failed).toMatchObject({ deleted: 0, missing: "slack_source_partial_or_total_failure" });
    expect(testDb.prepare(
      "SELECT COUNT(*) AS count FROM project_evidence_items WHERE project_id = ? AND source = 'slack'",
    ).get(PROJECT_ID)).toMatchObject({ count: 1 });
    const cursor = testDb.prepare(
      `SELECT cursor_value FROM project_ingestion_cursors
       WHERE org_id = ? AND project_id = ? AND source = 'slack' AND cursor_key = 'poll_state:v1'`,
    ).get(ORG_ID, PROJECT_ID) as { cursor_value: string };
    expect(JSON.parse(cursor.cursor_value)).toEqual(routingState);
    expect(getProjectSourceHealth(ORG_ID, PROJECT_ID)?.find((row) => row.source === "slack")?.credential_state)
      .toBe("unreachable");
  });

  it("purges a positively ineligible channel even when its routing cursor was lost", async () => {
    pollSlackProjectSource
      .mockResolvedValueOnce(successfulPoll())
      .mockResolvedValueOnce({
        source: "slack",
        changes: [],
        state: { channels: {} },
        health: {
          source: "slack",
          configured: true,
          configured_bindings: 1,
          admitted_bindings: 0,
          credential_state: "misconfigured",
          last_attempt_at: POLL_AT,
          indexed_thread_count: 0,
          retry_count: 0,
          bindings: [{
            binding: "T_OK:CDEPLOY",
            workspace_id: "T_OK",
            channel_id: "CDEPLOY",
            status: "not_public",
            indexed_thread_count: 0,
            retry_count: 0,
          }],
          errors: ["channel is no longer public"],
        },
      } satisfies PollSlackProjectSourceResult);

    await syncSlackProjectSource(ORG_ID, PROJECT_ID, { slack: { channels: ["T_OK:CDEPLOY"] } });
    testDb.prepare(
      `DELETE FROM project_ingestion_cursors
       WHERE org_id = ? AND project_id = ? AND source = 'slack' AND cursor_key = 'poll_state:v1'`,
    ).run(ORG_ID, PROJECT_ID);
    const restricted = await syncSlackProjectSource(ORG_ID, PROJECT_ID, {
      slack: { channels: ["T_OK:CDEPLOY"] },
    });

    expect(restricted).toMatchObject({ deleted: 1, missing: "slack_source_partial_or_total_failure" });
    expect(testDb.prepare(
      "SELECT COUNT(*) AS count FROM project_evidence_items WHERE project_id = ? AND source = 'slack'",
    ).get(PROJECT_ID)).toMatchObject({ count: 0 });
    expect(testDb.prepare(
      "SELECT COUNT(*) AS count FROM project_search_documents WHERE project_id = ? AND source = 'slack'",
    ).get(PROJECT_ID)).toMatchObject({ count: 0 });
    expect(getProjectSourceHealth(ORG_ID, PROJECT_ID)?.find((row) => row.source === "slack")?.credential_state)
      .toBe("misconfigured");
  });
});
