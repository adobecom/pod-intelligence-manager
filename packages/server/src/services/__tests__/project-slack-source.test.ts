import { describe, expect, it, vi } from "vitest";
import {
  pollSlackProjectSource,
  type SlackClientFactory,
  type SlackMessageLike,
  type SlackPollState,
} from "../project-slack-source.js";

const NOW = new Date("2026-07-19T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const SCOPE = { org_id: "org-slack-test", project_id: "project-slack-test" } as const;

function ts(secondsAgo: number, suffix = "000001"): string {
  return `${NOW_SECONDS - secondsAgo}.${suffix}`;
}

function publicChannel(id: string, name = "project-alpha") {
  return {
    id,
    name,
    is_channel: true,
    is_private: false,
    is_group: false,
    is_im: false,
    is_mpim: false,
    is_archived: false,
    is_member: true,
  };
}

function fakeClient(overrides: {
  teamId?: string;
  key?: string;
  info?: ReturnType<typeof vi.fn>;
  history?: ReturnType<typeof vi.fn>;
  replies?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    auth: {
      test: vi.fn(async () => ({
        ok: true,
        team_id: overrides.teamId ?? "T_WORKSPACE",
        team: overrides.key ?? "Workspace",
        url: "https://workspace.slack.com/",
      })),
    },
    conversations: {
      info: overrides.info ?? vi.fn(async ({ channel }: { channel: string }) => ({
        ok: true,
        channel: publicChannel(channel),
      })),
      history: overrides.history ?? vi.fn(async () => ({ ok: true, messages: [] })),
      replies: overrides.replies ?? vi.fn(async () => ({ ok: true, messages: [] })),
    },
  };
}

function factoryFor(client: ReturnType<typeof fakeClient>): SlackClientFactory {
  return vi.fn(() => client) as unknown as SlackClientFactory;
}

describe("project Slack source", () => {
  it("does not use legacy user tokens for scheduled ingestion", async () => {
    const clientFactory = vi.fn();
    const result = await pollSlackProjectSource({
      ...SCOPE,
      bindings: ["CPROJECT"],
      env: { SLACK_USER_TOKEN_MWP: "xoxp-legacy-user-token" },
      client_factory: clientFactory as unknown as SlackClientFactory,
      now: () => NOW,
    });

    expect(result.changes).toEqual([]);
    expect(result.health.credential_state).toBe("missing_credentials");
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("paginates channel history and complete replies into stable redacted thread changes", async () => {
    const rootOne = ts(300, "000101");
    const replyOne = ts(250, "000102");
    const replyTwo = ts(200, "000103");
    const rootTwo = ts(100, "000104");
    const rootMessage: SlackMessageLike = {
      ts: rootOne,
      text: "How do we rotate token=\"very-secret-value\"?",
      user: "U_ROOT",
      reply_count: 2,
      latest_reply: replyTwo,
      reactions: [{ name: "eyes", count: 2, users: ["U_REPLY", "U_ROOT"] }],
    };
    const history = vi.fn(async (args: { cursor?: string }) => args.cursor
      ? {
          ok: true,
          messages: [{ ts: rootTwo, text: "Standalone update", user: "U_TWO", reply_count: 0 }],
          response_metadata: { next_cursor: "" },
        }
      : {
          ok: true,
          messages: [rootMessage],
          response_metadata: { next_cursor: "history-page-2" },
        });
    const replies = vi.fn(async (args: { cursor?: string }) => args.cursor
      ? {
          ok: true,
          messages: [{
            ts: replyTwo,
            thread_ts: rootOne,
            text: "Resolved in the runbook",
            user: "U_REPLY_TWO",
          }],
          response_metadata: { next_cursor: "" },
        }
      : {
          ok: true,
          messages: [
            rootMessage,
            { ts: replyOne, thread_ts: rootOne, text: "I will investigate", user: "U_REPLY" },
          ],
          response_metadata: { next_cursor: "reply-page-2" },
        });
    const client = fakeClient({ history, replies });

    const result = await pollSlackProjectSource({
      ...SCOPE,
      bindings: ["C_PROJECT".replace("_", "")],
      env: { SLACK_BOT_TOKEN: "xoxb-test" },
      client_factory: factoryFor(client),
      now: () => NOW,
      sleep: vi.fn(async () => undefined),
    });

    expect(history).toHaveBeenCalledTimes(2);
    expect(history.mock.calls[1][0]).toMatchObject({ cursor: "history-page-2" });
    expect(replies).toHaveBeenCalledTimes(2);
    expect(replies.mock.calls[1][0]).toMatchObject({ cursor: "reply-page-2", ts: rootOne });
    expect(result.changes).toHaveLength(2);

    const thread = result.changes.find((change) => change.operational_metadata?.thread_ts === rootOne);
    expect(thread).toMatchObject({
      ...SCOPE,
      kind: "upsert",
      source_instance: "T_WORKSPACE",
      native_id: `CPROJECT:${rootOne}`,
      visibility: "project_visible",
    });
    expect(thread?.source_version).toMatch(/^[a-f0-9]{64}$/);
    expect(thread?.evidence?.body).toContain("[REDACTED:Generic Secret]");
    expect(thread?.evidence?.body).not.toContain("very-secret-value");
    expect(thread?.evidence?.body).toContain("<@U_REPLY_TWO>");
    expect(thread?.evidence?.body).toContain("Reactions: :eyes: ×2");
    expect(thread?.evidence?.body).toContain("Question: How do we rotate");
    expect(thread?.evidence?.body).toContain("Resolution: Resolved in the runbook");
    expect(thread?.evidence?.body).toContain("https://workspace.slack.com/archives/CPROJECT/");
    expect(thread?.evidence?.metadata).toMatchObject({
      workspace_id: "T_WORKSPACE",
      channel_id: "CPROJECT",
      thread_ts: rootOne,
      message_timestamps: [rootOne, replyOne, replyTwo],
      reply_count: 2,
      participants: ["U_REPLY", "U_REPLY_TWO", "U_ROOT"],
      reactions: { eyes: 2 },
      question: expect.stringContaining("How do we rotate"),
      resolution: "Resolved in the runbook",
    });
    expect((thread?.evidence?.metadata?.message_permalinks as Record<string, string>)[replyTwo])
      .toContain("thread_ts=");
    expect(result.state.channels["T_WORKSPACE:CPROJECT"].watermark).toBe((NOW.getTime() / 1000).toFixed(6));
    expect(result.health).toMatchObject({
      credential_state: "ok",
      admitted_bindings: 1,
      indexed_thread_count: 2,
      retry_count: 0,
    });
  });

  it("deduplicates overlap replays and emits the same stable identity for an edited root", async () => {
    const rootTs = ts(60, "000201");
    let root: SlackMessageLike = {
      ts: rootTs,
      text: "Initial decision",
      user: "U_DECIDER",
      reply_count: 0,
    };
    const history = vi.fn(async (_args: { oldest?: string }) => ({ ok: true, messages: [{ ...root }] }));
    const client = fakeClient({ history });
    const common = {
      ...SCOPE,
      bindings: ["T_WORKSPACE:CDECISIONS"],
      env: { SLACK_BOT_TOKEN: "xoxb-test" },
      client_factory: factoryFor(client),
      sleep: vi.fn(async () => undefined),
    };

    const first = await pollSlackProjectSource({ ...common, now: () => NOW });
    const replay = await pollSlackProjectSource({
      ...common,
      now: () => new Date(NOW.getTime() + 5 * 60_000),
      previous_state: first.state,
      force_reconciliation: false,
      reconciliation_interval_ms: 86_400_000,
    });

    expect(first.changes).toHaveLength(1);
    expect(replay.changes).toHaveLength(0);
    expect(history.mock.calls[1][0].oldest).toBe(
      (NOW.getTime() / 1000 - 60 * 60).toFixed(6),
    );

    root = {
      ...root,
      text: "Edited final decision",
      edited: { ts: ts(10, "000202"), user: "U_DECIDER" },
    };
    const edited = await pollSlackProjectSource({
      ...common,
      now: () => new Date(NOW.getTime() + 10 * 60_000),
      previous_state: replay.state,
      force_reconciliation: false,
      reconciliation_interval_ms: 86_400_000,
    });

    expect(edited.changes).toHaveLength(1);
    expect(edited.changes[0].native_id).toBe(first.changes[0].native_id);
    expect(edited.changes[0].source_instance).toBe(first.changes[0].source_instance);
    expect(edited.changes[0].source_version).not.toBe(first.changes[0].source_version);
    expect(edited.changes[0].evidence?.body).toContain("Edited final decision");
    expect(client.conversations.replies).not.toHaveBeenCalled();
  });

  it("emits a bounded reconciliation delete only after a complete channel scan", async () => {
    const rootA = ts(300, "000301");
    const rootB = ts(200, "000302");
    const history = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        messages: [
          { ts: rootA, text: "Keep me", user: "U_A", reply_count: 0 },
          { ts: rootB, text: "Delete me upstream", user: "U_B", reply_count: 0 },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        messages: [{ ts: rootA, text: "Keep me", user: "U_A", reply_count: 0 }],
      });
    const client = fakeClient({ history });
    const common = {
      ...SCOPE,
      bindings: ["CDELETE"],
      env: { SLACK_BOT_TOKEN: "xoxb-test" },
      client_factory: factoryFor(client),
      sleep: vi.fn(async () => undefined),
    };
    const first = await pollSlackProjectSource({ ...common, now: () => NOW });
    const reconciled = await pollSlackProjectSource({
      ...common,
      now: () => new Date(NOW.getTime() + 60_000),
      previous_state: first.state,
      force_reconciliation: true,
    });

    expect(reconciled.changes).toHaveLength(1);
    expect(reconciled.changes[0]).toMatchObject({
      ...SCOPE,
      kind: "delete",
      source_instance: "T_WORKSPACE",
      native_id: `CDELETE:${rootB}`,
    });
    expect(reconciled.state.channels["T_WORKSPACE:CDELETE"].threads[rootB]).toBeUndefined();
    expect(reconciled.state.channels["T_WORKSPACE:CDELETE"].threads[rootA]).toBeDefined();
    expect(reconciled.health.last_reconciliation_at).toBe("2026-07-19T12:01:00.000Z");
  });

  it("advances a bounded reconciliation cursor so later threads are eventually checked", async () => {
    const roots = [ts(300, "000311"), ts(200, "000312"), ts(100, "000313")];
    let lastReply = "Original third reply";
    const history = vi.fn(async () => ({
      ok: true,
      messages: roots.map((root, index) => ({
        ts: root,
        text: `Root ${index + 1}`,
        user: `U_ROOT_${index + 1}`,
        reply_count: 1,
        latest_reply: `${Number(root) + 0.01}`,
      })),
    }));
    const replies = vi.fn(async ({ ts: root }: { ts: string }) => ({
      ok: true,
      messages: [
        { ts: root, text: `Root ${roots.indexOf(root) + 1}`, user: "U_ROOT", reply_count: 1 },
        {
          ts: `${Number(root) + 0.01}`,
          thread_ts: root,
          text: root === roots[2] ? lastReply : `Reply ${roots.indexOf(root) + 1}`,
          user: "U_REPLY",
        },
      ],
    }));
    const client = fakeClient({ history, replies });
    const common = {
      ...SCOPE,
      bindings: ["CROLLING"],
      env: { SLACK_BOT_TOKEN: "xoxb-test" },
      client_factory: factoryFor(client),
      sleep: vi.fn(async () => undefined),
      force_reconciliation: true,
    };
    const initial = await pollSlackProjectSource({ ...common, now: () => NOW, max_reconciliation_threads: 10 });
    lastReply = "Edited final decision";

    const firstPage = await pollSlackProjectSource({
      ...common,
      now: () => new Date(NOW.getTime() + 60_000),
      previous_state: initial.state,
      max_reconciliation_threads: 1,
    });
    const secondPage = await pollSlackProjectSource({
      ...common,
      now: () => new Date(NOW.getTime() + 120_000),
      previous_state: firstPage.state,
      max_reconciliation_threads: 1,
    });
    const thirdPage = await pollSlackProjectSource({
      ...common,
      now: () => new Date(NOW.getTime() + 180_000),
      previous_state: secondPage.state,
      max_reconciliation_threads: 1,
    });

    expect(firstPage.state.channels["T_WORKSPACE:CROLLING"].reconciliation_cursor).toBe(roots[0]);
    expect(secondPage.state.channels["T_WORKSPACE:CROLLING"].reconciliation_cursor).toBe(roots[1]);
    expect(thirdPage.state.channels["T_WORKSPACE:CROLLING"].reconciliation_cursor).toBeUndefined();
    expect(thirdPage.changes).toEqual([
      expect.objectContaining({ kind: "upsert", native_id: `CROLLING:${roots[2]}` }),
    ]);
    expect(thirdPage.changes[0].evidence?.body).toContain("Edited final decision");
  });

  it("fails closed for empty, non-ID, private, DM, MPIM, archived, and non-member bindings", async () => {
    const neverFactory = vi.fn();
    const empty = await pollSlackProjectSource({
      ...SCOPE,
      bindings: [],
      env: { SLACK_BOT_TOKEN: "xoxb-test" },
      client_factory: neverFactory as unknown as SlackClientFactory,
      now: () => NOW,
    });
    expect(empty.changes).toEqual([]);
    expect(empty.health.credential_state).toBe("not_configured");
    expect(neverFactory).not.toHaveBeenCalled();

    const info = vi.fn(async ({ channel }: { channel: string }) => {
      const base = publicChannel(channel);
      if (channel === "C111") return { ok: true, channel: { ...base, is_private: true } };
      if (channel === "C222") return { ok: true, channel: { ...base, is_im: true } };
      if (channel === "C333") return { ok: true, channel: { ...base, is_mpim: true } };
      if (channel === "C444") return { ok: true, channel: { ...base, is_archived: true } };
      return { ok: true, channel: { ...base, is_member: false } };
    });
    const client = fakeClient({ info });
    const excluded = await pollSlackProjectSource({
      ...SCOPE,
      bindings: ["general", "D123", "C111", "C222", "C333", "C444", "C555"],
      env: { SLACK_BOT_TOKEN: "xoxb-test" },
      client_factory: factoryFor(client),
      now: () => NOW,
      sleep: vi.fn(async () => undefined),
    });

    expect(excluded.changes).toEqual([]);
    expect(client.conversations.history).not.toHaveBeenCalled();
    expect(excluded.health.bindings.filter((entry) => entry.status === "invalid_binding")).toHaveLength(2);
    expect(excluded.health.bindings.filter((entry) => entry.status === "not_public")).toHaveLength(4);
    expect(excluded.health.bindings.filter((entry) => entry.status === "not_member")).toHaveLength(1);
    expect(excluded.health.credential_state).toBe("misconfigured");
  });

  it("tombstones previously indexed threads when a channel becomes private", async () => {
    const rootTs = ts(120, "000350");
    const publicClient = fakeClient({
      history: vi.fn(async () => ({
        ok: true,
        messages: [{ ts: rootTs, text: "Previously public", user: "U_OWNER", reply_count: 0 }],
      })),
    });
    const first = await pollSlackProjectSource({
      ...SCOPE,
      bindings: ["CVISIBILITY"],
      env: { SLACK_BOT_TOKEN: "xoxb-test" },
      client_factory: factoryFor(publicClient),
      now: () => NOW,
      sleep: vi.fn(async () => undefined),
    });

    const privateClient = fakeClient({
      info: vi.fn(async ({ channel }: { channel: string }) => ({
        ok: true,
        channel: { ...publicChannel(channel), is_private: true },
      })),
    });
    const restricted = await pollSlackProjectSource({
      ...SCOPE,
      bindings: ["CVISIBILITY"],
      previous_state: first.state,
      env: { SLACK_BOT_TOKEN: "xoxb-test" },
      client_factory: factoryFor(privateClient),
      now: () => new Date(NOW.getTime() + 60_000),
      sleep: vi.fn(async () => undefined),
    });

    expect(restricted.changes).toEqual([
      expect.objectContaining({
        ...SCOPE,
        kind: "delete",
        source_instance: "T_WORKSPACE",
        native_id: `CVISIBILITY:${rootTs}`,
      }),
    ]);
    expect(restricted.state.channels["T_WORKSPACE:CVISIBILITY"]).toBeUndefined();
    expect(privateClient.conversations.history).not.toHaveBeenCalled();
  });

  it("requires workspace-qualified bindings when multiple workspaces are configured", async () => {
    const clients = {
      "bot-mwp": fakeClient({ teamId: "T_MWP" }),
      "bot-aem": fakeClient({ teamId: "T_AEM" }),
    };
    const factory = vi.fn((token: string) => clients[token as keyof typeof clients]) as unknown as SlackClientFactory;
    const result = await pollSlackProjectSource({
      ...SCOPE,
      bindings: ["CBARE", "mwp:CMWP"],
      env: {
        SLACK_BOT_TOKEN_MWP: "bot-mwp",
        SLACK_BOT_TOKEN_AEM_ENG: "bot-aem",
      },
      client_factory: factory,
      now: () => NOW,
      sleep: vi.fn(async () => undefined),
    });

    expect(result.health.bindings.find((entry) => entry.binding === "CBARE")?.status).toBe("workspace_not_found");
    expect(result.health.bindings.find((entry) => entry.binding === "mwp:CMWP")?.status).toBe("ok");
    expect(result.state.channels["T_MWP:CMWP"]).toBeDefined();
    expect(clients["bot-aem"].conversations.info).not.toHaveBeenCalled();
  });

  it("honors Retry-After with a bounded injected sleep and records retry health", async () => {
    const rootTs = ts(10, "000401");
    const rateLimited = Object.assign(new Error("rate limited"), {
      code: "slack_webapi_rate_limited_error",
      retryAfter: 2,
    });
    const history = vi.fn()
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValueOnce({
        ok: true,
        messages: [{ ts: rootTs, text: "After retry", user: "U_RETRY", reply_count: 0 }],
      });
    const sleep = vi.fn(async () => undefined);
    const client = fakeClient({ history });

    const result = await pollSlackProjectSource({
      ...SCOPE,
      bindings: ["CRETRY"],
      env: { SLACK_BOT_TOKEN: "xoxb-test" },
      client_factory: factoryFor(client),
      now: () => NOW,
      sleep,
      max_rate_limit_retries: 1,
    });

    expect(history).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(result.changes).toHaveLength(1);
    expect(result.health.retry_count).toBe(1);
    expect(result.health.bindings[0]).toMatchObject({ status: "ok", retry_count: 1 });
  });

  it("does not reconcile deletes or advance the watermark from an incomplete history page bound", async () => {
    const rootTs = ts(10, "000501");
    const previous: SlackPollState = {
      channels: {
        "T_WORKSPACE:CBOUND": {
          workspace_id: "T_WORKSPACE",
          channel_id: "CBOUND",
          watermark: ts(100, "000500"),
          threads: {
            [rootTs]: {
              native_id: `CBOUND:${rootTs}`,
              source_version: "old-version",
              root_hint: "old-hint",
              occurred_at: new Date((NOW_SECONDS - 10) * 1000).toISOString(),
              updated_at: new Date((NOW_SECONDS - 10) * 1000).toISOString(),
              message_timestamps: [rootTs],
            },
          },
        },
      },
    };
    const history = vi.fn(async () => ({
      ok: true,
      messages: [],
      response_metadata: { next_cursor: "still-more" },
    }));
    const client = fakeClient({ history });

    const result = await pollSlackProjectSource({
      ...SCOPE,
      bindings: ["CBOUND"],
      previous_state: previous,
      env: { SLACK_BOT_TOKEN: "xoxb-test" },
      client_factory: factoryFor(client),
      now: () => NOW,
      sleep: vi.fn(async () => undefined),
      force_reconciliation: true,
      max_history_pages: 1,
    });

    expect(result.changes).toEqual([]);
    expect(result.state.channels["T_WORKSPACE:CBOUND"].watermark).toBe(previous.channels["T_WORKSPACE:CBOUND"].watermark);
    expect(result.state.channels["T_WORKSPACE:CBOUND"].threads[rootTs]).toBeDefined();
    expect(result.health.bindings[0].status).toBe("error");
  });
});
