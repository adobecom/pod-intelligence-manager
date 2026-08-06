import crypto from "node:crypto";
import { WebClient } from "@slack/web-api";
import type { ProjectSourceCapabilities, ProjectSourceChange, ProjectSourceChangeEvidence } from "@pim/shared";
import { redactSecrets } from "./secret-scan.js";

/**
 * Slack's source connector is intentionally persistence-agnostic. It returns
 * stable, redacted upsert/delete changes plus an opaque state object that the
 * project ingestion layer can persist in project_ingestion_cursors.
 */

export const SLACK_SOURCE_REDACTION_VERSION = "secret-scan-v1";
export const SLACK_SOURCE_CAPABILITIES: ProjectSourceCapabilities = {
  pagination: "cursor",
  overlap_window: true,
  deletion_reconciliation: true,
  source_versions: true,
  visibility: "project_visible_only",
};

const DEFAULT_OVERLAP_SECONDS = 60 * 60;
const DEFAULT_BACKFILL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_RECONCILIATION_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_RECONCILIATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_MAX_HISTORY_PAGES = 100;
const DEFAULT_MAX_REPLY_PAGES = 100;
const DEFAULT_MAX_RECONCILIATION_THREADS = 250;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 2;
const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;

export interface SlackMessageLike {
  ts?: string;
  thread_ts?: string;
  text?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  subtype?: string;
  edited?: { ts?: string; user?: string };
  reply_count?: number;
  latest_reply?: string;
  reactions?: Array<{ name?: string; count?: number; users?: string[] }>;
  attachments?: Array<{ title?: string; text?: string; fallback?: string }>;
  files?: Array<{ id?: string; title?: string; name?: string; mimetype?: string }>;
}

interface SlackCursorResponse {
  ok?: boolean;
  error?: string;
  messages?: SlackMessageLike[];
  response_metadata?: { next_cursor?: string };
}

interface SlackClientLike {
  auth: {
    test(args?: Record<string, never>): Promise<{
      ok?: boolean;
      error?: string;
      team_id?: string;
      team?: string;
      url?: string;
    }>;
  };
  conversations: {
    info(args: { channel: string; include_num_members?: boolean }): Promise<{
      ok?: boolean;
      error?: string;
      channel?: {
        id?: string;
        name?: string;
        is_channel?: boolean;
        is_private?: boolean;
        is_group?: boolean;
        is_im?: boolean;
        is_mpim?: boolean;
        is_archived?: boolean;
        is_member?: boolean;
      };
    }>;
    history(args: {
      channel: string;
      cursor?: string;
      oldest?: string;
      latest?: string;
      inclusive?: boolean;
      include_all_metadata?: boolean;
      limit?: number;
    }): Promise<SlackCursorResponse>;
    replies(args: {
      channel: string;
      ts: string;
      cursor?: string;
      inclusive?: boolean;
      include_all_metadata?: boolean;
      limit?: number;
    }): Promise<SlackCursorResponse>;
  };
}

export type SlackClientFactory = (token: string, workspaceKey: string) => SlackClientLike;

export interface SlackSourceBindingHealth {
  binding: string;
  workspace_id?: string;
  channel_id?: string;
  channel_name?: string;
  status:
    | "ok"
    | "invalid_binding"
    | "workspace_not_found"
    | "invalid_credentials"
    | "not_public"
    | "not_member"
    | "error";
  cursor_watermark?: string;
  last_success_at?: string;
  last_reconciliation_at?: string;
  lag_seconds?: number;
  indexed_thread_count: number;
  retry_count: number;
  message?: string;
}

export interface SlackSourceHealth {
  source: "slack";
  configured: boolean;
  configured_bindings: number;
  admitted_bindings: number;
  credential_state:
    | "ok"
    | "missing_credentials"
    | "invalid_credentials"
    | "misconfigured"
    | "unreachable"
    | "not_configured";
  last_attempt_at: string;
  last_success_at?: string;
  last_reconciliation_at?: string;
  lag_seconds?: number;
  indexed_thread_count: number;
  retry_count: number;
  bindings: SlackSourceBindingHealth[];
  errors: string[];
}

export interface SlackThreadState {
  native_id: string;
  source_version: string;
  root_hint: string;
  occurred_at: string;
  updated_at: string;
  message_timestamps: string[];
}

export interface SlackChannelPollState {
  workspace_id: string;
  channel_id: string;
  watermark?: string;
  last_success_at?: string;
  last_reconciliation_at?: string;
  /** Last root examined in the current bounded reconciliation sweep. */
  reconciliation_cursor?: string;
  threads: Record<string, SlackThreadState>;
}

export interface SlackPollState {
  channels: Record<string, SlackChannelPollState>;
}

export interface PollSlackProjectSourceOptions {
  org_id: string;
  project_id: string;
  /** `workspace:CHANNEL_ID`, or a bare CHANNEL_ID when exactly one workspace is configured. */
  bindings: string[];
  previous_state?: SlackPollState;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  client_factory?: SlackClientFactory;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  overlap_seconds?: number;
  backfill_seconds?: number;
  reconciliation_window_seconds?: number;
  reconciliation_interval_ms?: number;
  force_reconciliation?: boolean;
  page_size?: number;
  max_history_pages?: number;
  max_reply_pages?: number;
  max_reconciliation_threads?: number;
  max_rate_limit_retries?: number;
  max_retry_after_ms?: number;
}

export interface PollSlackProjectSourceResult {
  source: "slack";
  changes: ProjectSourceChange[];
  state: SlackPollState;
  health: SlackSourceHealth;
}

interface WorkspaceToken {
  key: string;
  token: string;
  token_source: string;
}

interface AdmittedWorkspace extends WorkspaceToken {
  client: SlackClientLike;
  team_id: string;
  team_name?: string;
  workspace_url?: string;
}

interface ResolvedBinding {
  raw: string;
  workspace: AdmittedWorkspace;
  channel_id: string;
}

interface RetryContext {
  retry_count: number;
}

interface CanonicalMessage {
  ts: string;
  thread_ts: string;
  participant_id: string;
  edited_ts: string;
  text: string;
  reactions: Array<{ name: string; count: number; users: string[] }>;
  attachments: Array<{ title: string; text: string; fallback: string }>;
  files: Array<{ id: string; title: string; name: string; mimetype: string }>;
}

interface PaginationResult {
  messages: SlackMessageLike[];
  complete: boolean;
}

function defaultClientFactory(token: string): SlackClientLike {
  return new WebClient(token, {
    maxRequestConcurrency: 1,
    rejectRateLimitedCalls: true,
    retryConfig: { retries: 0 },
  }) as unknown as SlackClientLike;
}

function workspaceTokens(env: PollSlackProjectSourceOptions["env"]): WorkspaceToken[] {
  const source = env ?? process.env;
  const specs: Array<{ key: string; bot: string[] }> = [
    {
      key: "mwp",
      bot: ["SLACK_INGEST_BOT_TOKEN_MWP", "SLACK_BOT_TOKEN_MWP"],
    },
    {
      key: "aem_eng",
      bot: ["SLACK_INGEST_BOT_TOKEN_AEM_ENG", "SLACK_BOT_TOKEN_AEM_ENG"],
    },
    {
      key: "adobedotcom",
      bot: ["SLACK_INGEST_BOT_TOKEN_ADOBEDOTCOM", "SLACK_BOT_TOKEN_ADOBEDOTCOM"],
    },
    {
      key: "default",
      bot: ["SLACK_INGEST_BOT_TOKEN", "SLACK_BOT_TOKEN"],
    },
  ];

  const tokens: WorkspaceToken[] = [];
  const seenTokens = new Set<string>();
  for (const spec of specs) {
    const tokenSource = spec.bot.find((name) => source[name]?.trim());
    if (!tokenSource) continue;
    const token = source[tokenSource]!.trim();
    if (seenTokens.has(token)) continue;
    seenTokens.add(token);
    tokens.push({ key: spec.key, token, token_source: tokenSource });
  }
  return tokens;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function cleanCursor(value: string | undefined): string | undefined {
  const cursor = value?.trim();
  return cursor ? cursor : undefined;
}

function asSlackTimestamp(date: Date): string {
  return (date.getTime() / 1000).toFixed(6);
}

function subtractSeconds(ts: string, seconds: number): string {
  return Math.max(0, Number(ts) - Math.max(0, seconds)).toFixed(6);
}

function compareSlackTimestamps(a: string, b: string): number {
  const aNumber = Number(a);
  const bNumber = Number(b);
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber) && aNumber !== bNumber) {
    return aNumber - bNumber;
  }
  return a.localeCompare(b);
}

function slackTimestampToIso(ts: string): string {
  const millis = Number(ts) * 1000;
  return Number.isFinite(millis) ? new Date(millis).toISOString() : new Date(0).toISOString();
}

function cloneState(previous: SlackPollState | undefined): SlackPollState {
  const channels: Record<string, SlackChannelPollState> = {};
  for (const [key, channel] of Object.entries(previous?.channels ?? {})) {
    channels[key] = {
      ...channel,
      threads: Object.fromEntries(
        Object.entries(channel.threads ?? {}).map(([ts, thread]) => [
          ts,
          { ...thread, message_timestamps: [...thread.message_timestamps] },
        ]),
      ),
    };
  }
  return { channels };
}

function errorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const value = (err as { code?: unknown; data?: { error?: unknown } }).code
    ?? (err as { data?: { error?: unknown } }).data?.error;
  return typeof value === "string" ? value : undefined;
}

function safeError(err: unknown): string {
  const code = errorCode(err);
  return code?.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80) || "slack_api_error";
}

function retryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const value = (err as {
    retryAfter?: unknown;
    data?: { response_metadata?: { retryAfter?: unknown } };
    response?: { headers?: Record<string, unknown> };
  }).retryAfter
    ?? (err as { data?: { response_metadata?: { retryAfter?: unknown } } }).data?.response_metadata?.retryAfter
    ?? (err as { response?: { headers?: Record<string, unknown> } }).response?.headers?.["retry-after"];
  const seconds = typeof value === "number" ? value : Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

async function callWithRateLimitRetry<T>(
  fn: () => Promise<T>,
  ctx: RetryContext,
  sleep: (ms: number) => Promise<void>,
  maxRetries: number,
  maxRetryAfterMs: number,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const delay = retryAfterMs(err);
      if (delay === null || attempt >= maxRetries || delay > maxRetryAfterMs) throw err;
      attempt++;
      ctx.retry_count++;
      await sleep(delay);
    }
  }
}

function assertSlackResponse(response: { ok?: boolean; error?: string }): void {
  if (response.ok === false || response.error) {
    const error = new Error(response.error ?? "Slack API call failed") as Error & { code?: string };
    error.code = response.error;
    throw error;
  }
}

function canonicalMessage(message: SlackMessageLike, rootTs: string): CanonicalMessage | null {
  if (!message.ts || message.subtype === "message_deleted") return null;
  const participant = message.user ?? message.bot_id ?? message.username ?? "unknown";
  return {
    ts: message.ts,
    thread_ts: message.thread_ts ?? rootTs,
    participant_id: participant,
    edited_ts: message.edited?.ts ?? "",
    text: message.text ?? "",
    reactions: (message.reactions ?? [])
      .map((reaction) => ({
        name: reaction.name ?? "unknown",
        count: reaction.count ?? reaction.users?.length ?? 0,
        users: [...(reaction.users ?? [])].sort(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    attachments: (message.attachments ?? []).map((attachment) => ({
      title: attachment.title ?? "",
      text: attachment.text ?? "",
      fallback: attachment.fallback ?? "",
    })),
    files: (message.files ?? []).map((file) => ({
      id: file.id ?? "",
      title: file.title ?? "",
      name: file.name ?? "",
      mimetype: file.mimetype ?? "",
    })),
  };
}

function rootHint(message: SlackMessageLike, rootTs: string): string {
  return sha256(JSON.stringify({
    root_ts: rootTs,
    message_ts: message.ts ?? "",
    text: message.text ?? "",
    edited_ts: message.edited?.ts ?? "",
    reply_count: message.reply_count ?? 0,
    latest_reply: message.latest_reply ?? "",
    reactions: canonicalMessage(message, rootTs)?.reactions ?? [],
  }));
}

function permalinkFor(workspaceUrl: string | undefined, teamId: string, channelId: string, rootTs: string, messageTs: string): string {
  if (!workspaceUrl) {
    return `https://app.slack.com/client/${encodeURIComponent(teamId)}/${encodeURIComponent(channelId)}/thread/${rootTs}-${messageTs}`;
  }
  const base = workspaceUrl.replace(/\/+$/, "");
  const messagePath = `p${messageTs.replace(".", "")}`;
  const url = `${base}/archives/${encodeURIComponent(channelId)}/${messagePath}`;
  return messageTs === rootTs
    ? url
    : `${url}?thread_ts=${encodeURIComponent(rootTs)}&cid=${encodeURIComponent(channelId)}`;
}

function redacted(value: string): string {
  return redactSecrets(value).text;
}

function supplementalText(message: CanonicalMessage): string[] {
  const lines: string[] = [];
  for (const attachment of message.attachments) {
    const text = [attachment.title, attachment.text, attachment.fallback].filter(Boolean).join(" — ");
    if (text) lines.push(`Attachment: ${redacted(text)}`);
  }
  for (const file of message.files) {
    const label = file.title || file.name || file.id;
    if (label) lines.push(`File: ${redacted(label)}${file.mimetype ? ` (${file.mimetype})` : ""}`);
  }
  if (message.reactions.length > 0) {
    lines.push(`Reactions: ${message.reactions.map((r) => `:${r.name}: ×${r.count}`).join(", ")}`);
  }
  return lines;
}

function threadSearchFacets(messages: CanonicalMessage[]): {
  question?: string;
  resolution?: string;
  referencedSystems: string[];
} {
  const texts = messages.map((message) => redacted(message.text).replace(/\s+/g, " ").trim()).filter(Boolean);
  const questionText = texts.find((text) => text.includes("?"));
  const question = questionText
    ? questionText.slice(0, Math.min(questionText.indexOf("?") + 1, 320))
    : undefined;
  const resolution = [...texts].reverse().find((text) =>
    /\b(?:resolved|resolution|decided|decision\s*:|approved|conclusion|fixed|final answer)\b/i.test(text),
  )?.slice(0, 480);

  const joined = texts.join("\n");
  const references = new Set<string>();
  const patterns = [
    /\b[A-Z][A-Z0-9]{1,15}-\d+\b/g,
    /\b[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+\b/g,
    /\b[0-9a-f]{7,40}\b/gi,
    /(?:^|[\s`'"])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,12})(?=$|[\s`'",.;:)])/gm,
    /`([^`\n]{1,120})`/g,
  ];
  for (const pattern of patterns) {
    for (const match of joined.matchAll(pattern)) {
      const value = (match[1] ?? match[0]).trim();
      if (value) references.add(value);
      if (references.size >= 40) break;
    }
    if (references.size >= 40) break;
  }
  return {
    ...(question ? { question } : {}),
    ...(resolution ? { resolution } : {}),
    referencedSystems: [...references].sort(),
  };
}

function buildUpsertChange(
  orgId: string,
  projectId: string,
  workspace: AdmittedWorkspace,
  channel: { id: string; name: string },
  rootTs: string,
  messages: SlackMessageLike[],
  hint: string,
): { change: ProjectSourceChange; state: SlackThreadState } | null {
  const canonical = messages
    .map((message) => canonicalMessage(message, rootTs))
    .filter((message): message is CanonicalMessage => message !== null)
    .sort((a, b) => compareSlackTimestamps(a.ts, b.ts));
  if (canonical.length === 0) return null;

  const deduped = [...new Map(canonical.map((message) => [message.ts, message])).values()];
  const root = deduped.find((message) => message.ts === rootTs) ?? deduped[0];
  const latest = deduped.reduce((value, message) =>
    compareSlackTimestamps(message.edited_ts || message.ts, value) > 0 ? (message.edited_ts || message.ts) : value,
  root.edited_ts || root.ts);
  const participantIds = [...new Set(deduped.map((message) => message.participant_id))].sort();
  const facets = threadSearchFacets(deduped);
  const messagePermalinks: Record<string, string> = {};
  const reactionCounts: Record<string, number> = {};
  const bodyParts: string[] = [];
  for (const message of deduped) {
    const permalink = permalinkFor(workspace.workspace_url, workspace.team_id, channel.id, rootTs, message.ts);
    messagePermalinks[message.ts] = permalink;
    for (const reaction of message.reactions) {
      reactionCounts[reaction.name] = (reactionCounts[reaction.name] ?? 0) + reaction.count;
    }
    const messageText = redacted(message.text).trim() || "(no text)";
    bodyParts.push([
      `[${slackTimestampToIso(message.ts)}] <@${message.participant_id}>: ${messageText}`,
      ...supplementalText(message),
      `Permalink: ${permalink}`,
    ].join("\n"));
  }

  const nativeId = `${channel.id}:${rootTs}`;
  const sourceVersion = sha256(JSON.stringify({
    workspace_id: workspace.team_id,
    channel_id: channel.id,
    root_ts: rootTs,
    messages: deduped,
  }));
  const rootText = redacted(root.text).replace(/\s+/g, " ").trim();
  const channelName = redacted(channel.name || channel.id);
  const summary = rootText.slice(0, 280) || `Slack thread in #${channelName}`;
  const sourceTitle = `#${channelName}: ${rootText.slice(0, 120) || "Slack thread"}`;
  const body = [
    ...(facets.question ? [`Question: ${facets.question}`] : []),
    `Summary: ${summary}`,
    ...(facets.resolution ? [`Resolution: ${facets.resolution}`] : []),
    ...(facets.referencedSystems.length > 0
      ? [`Referenced systems/code: ${facets.referencedSystems.join(", ")}`]
      : []),
    "",
    "Thread:",
    bodyParts.join("\n\n"),
  ].join("\n");
  const sourceUrl = messagePermalinks[rootTs]
    ?? permalinkFor(workspace.workspace_url, workspace.team_id, channel.id, rootTs, rootTs);
  const occurredAt = slackTimestampToIso(rootTs);
  const updatedAt = slackTimestampToIso(latest);
  const redactedContentHash = sha256([sourceTitle, summary, body].join("\0"));

  const state: SlackThreadState = {
    native_id: nativeId,
    source_version: sourceVersion,
    root_hint: hint,
    occurred_at: occurredAt,
    updated_at: updatedAt,
    message_timestamps: deduped.map((message) => message.ts),
  };
  const evidence: ProjectSourceChangeEvidence = {
    source_type: "thread",
    source_url: sourceUrl,
    source_title: sourceTitle,
    summary,
    body,
    author: root.participant_id,
    metadata: {
      workspace_id: workspace.team_id,
      workspace: redacted(workspace.team_name ?? workspace.key),
      channel_id: channel.id,
      channel_name: channelName,
      thread_ts: rootTs,
      root_ts: rootTs,
      message_timestamps: deduped.map((message) => message.ts),
      message_permalinks: messagePermalinks,
      last_activity: latest,
      latest_reply: deduped.length > 1 ? deduped[deduped.length - 1].ts : undefined,
      reply_count: Math.max(0, deduped.length - 1),
      participants: participantIds,
      reactions: reactionCounts,
      thread_url: sourceUrl,
      question: facets.question,
      resolution: facets.resolution,
      referenced_systems: facets.referencedSystems,
      visibility: "project_visible",
    },
    confidence_score: 0.65,
    promotable: false,
  };

  return {
    change: {
      org_id: orgId,
      project_id: projectId,
      source: "slack",
      source_instance: workspace.team_id,
      native_id: nativeId,
      kind: "upsert",
      source_version: sourceVersion,
      visibility: "project_visible",
      visibility_version: "project-visible-v1",
      occurred_at: occurredAt,
      updated_at: updatedAt,
      evidence,
      operational_metadata: {
        workspace_id: workspace.team_id,
        channel_id: channel.id,
        thread_ts: rootTs,
        message_timestamps: state.message_timestamps,
        message_permalinks: messagePermalinks,
        redaction_version: SLACK_SOURCE_REDACTION_VERSION,
        redacted_content_hash: redactedContentHash,
      },
    },
    state,
  };
}

function buildDeleteChange(
  orgId: string,
  projectId: string,
  channel: SlackChannelPollState,
  rootTs: string,
  previous: SlackThreadState,
  nowIso: string,
): ProjectSourceChange {
  return {
    org_id: orgId,
    project_id: projectId,
    source: "slack",
    source_instance: channel.workspace_id,
    native_id: `${channel.channel_id}:${rootTs}`,
    kind: "delete",
    source_version: sha256(`deleted\0${previous.source_version}\0${nowIso}`),
    visibility: "project_visible",
    visibility_version: "project-visible-v1",
    occurred_at: previous.occurred_at,
    updated_at: nowIso,
    operational_metadata: {
      workspace_id: channel.workspace_id,
      channel_id: channel.channel_id,
      thread_ts: rootTs,
      redaction_version: SLACK_SOURCE_REDACTION_VERSION,
    },
  };
}

async function paginateHistory(
  client: SlackClientLike,
  channel: string,
  oldest: string,
  latest: string,
  pageSize: number,
  maxPages: number,
  retry: (fn: () => Promise<SlackCursorResponse>) => Promise<SlackCursorResponse>,
): Promise<PaginationResult> {
  const messages: SlackMessageLike[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const response = await retry(() => client.conversations.history({
      channel,
      ...(cursor ? { cursor } : {}),
      oldest,
      latest,
      inclusive: true,
      include_all_metadata: true,
      limit: pageSize,
    }));
    assertSlackResponse(response);
    messages.push(...(response.messages ?? []));
    cursor = cleanCursor(response.response_metadata?.next_cursor);
    if (!cursor) return { messages, complete: true };
  }
  return { messages, complete: false };
}

async function paginateReplies(
  client: SlackClientLike,
  channel: string,
  rootTs: string,
  pageSize: number,
  maxPages: number,
  retry: (fn: () => Promise<SlackCursorResponse>) => Promise<SlackCursorResponse>,
): Promise<PaginationResult> {
  const messages: SlackMessageLike[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const response = await retry(() => client.conversations.replies({
      channel,
      ts: rootTs,
      ...(cursor ? { cursor } : {}),
      inclusive: true,
      include_all_metadata: true,
      limit: pageSize,
    }));
    assertSlackResponse(response);
    messages.push(...(response.messages ?? []));
    cursor = cleanCursor(response.response_metadata?.next_cursor);
    if (!cursor) return { messages, complete: true };
  }
  return { messages, complete: false };
}

function parseBinding(raw: string): { workspace?: string; channel_id?: string; error?: string } {
  const value = raw.trim();
  if (!value) return { error: "Slack channel binding is empty" };
  const colon = value.indexOf(":");
  const workspace = colon >= 0 ? value.slice(0, colon).trim() : undefined;
  const channelId = colon >= 0 ? value.slice(colon + 1).trim() : value;
  if (colon >= 0 && !workspace) return { error: `Slack binding "${value}" has no workspace` };
  if (!/^C[A-Z0-9]+$/.test(channelId)) {
    return { error: `Slack binding "${value}" must use a public channel ID beginning with C` };
  }
  return { ...(workspace ? { workspace } : {}), channel_id: channelId };
}

function channelStateKey(teamId: string, channelId: string): string {
  return `${teamId}:${channelId}`;
}

function isCredentialError(code: string | undefined): boolean {
  return !!code && ["invalid_auth", "not_authed", "token_expired", "token_revoked", "account_inactive"].includes(code);
}

function reconciliationIsDue(
  channel: SlackChannelPollState | undefined,
  nowMs: number,
  force: boolean,
  intervalMs: number,
): boolean {
  if (force || !channel?.last_reconciliation_at) return true;
  const previous = new Date(channel.last_reconciliation_at).getTime();
  return !Number.isFinite(previous) || nowMs - previous >= intervalMs;
}

function sourceLagSeconds(state: SlackChannelPollState, nowMs: number): number | undefined {
  const latest = Object.values(state.threads).reduce<string | undefined>((value, thread) => {
    if (!value) return thread.updated_at;
    return thread.updated_at > value ? thread.updated_at : value;
  }, undefined);
  if (!latest) return undefined;
  const millis = new Date(latest).getTime();
  return Number.isFinite(millis) ? Math.max(0, Math.floor((nowMs - millis) / 1000)) : undefined;
}

function tombstonePreviouslyIndexedChannel(
  state: SlackPollState,
  changes: ProjectSourceChange[],
  orgId: string,
  projectId: string,
  workspaceId: string,
  channelId: string,
  nowIso: string,
): void {
  const key = channelStateKey(workspaceId, channelId);
  const previous = state.channels[key];
  if (!previous) return;
  for (const [rootTs, thread] of Object.entries(previous.threads)) {
    changes.push(buildDeleteChange(orgId, projectId, previous, rootTs, thread, nowIso));
  }
  delete state.channels[key];
}

/**
 * Poll explicitly configured Slack public channels and return complete-thread
 * changes. No upstream content is returned for an empty/invalid/private binding.
 */
export async function pollSlackProjectSource(
  options: PollSlackProjectSourceOptions,
): Promise<PollSlackProjectSourceResult> {
  const now = options.now?.() ?? new Date();
  const nowIso = now.toISOString();
  const scanLatest = asSlackTimestamp(now);
  const state = cloneState(options.previous_state);
  const changes: ProjectSourceChange[] = [];
  const bindingHealth: SlackSourceBindingHealth[] = [];
  const errors: string[] = [];
  const configuredBindings = [...new Set(options.bindings.map((binding) => binding.trim()).filter(Boolean))];
  const baseHealth: SlackSourceHealth = {
    source: "slack",
    configured: configuredBindings.length > 0,
    configured_bindings: configuredBindings.length,
    admitted_bindings: 0,
    credential_state: configuredBindings.length > 0 ? "missing_credentials" : "not_configured",
    last_attempt_at: nowIso,
    indexed_thread_count: Object.values(state.channels).reduce((sum, channel) => sum + Object.keys(channel.threads).length, 0),
    retry_count: 0,
    bindings: bindingHealth,
    errors,
  };
  // Empty means no Slack boundary, not "all channels". Do not even authenticate.
  if (configuredBindings.length === 0) return { source: "slack", changes, state, health: baseHealth };

  const tokens = workspaceTokens(options.env);
  if (tokens.length === 0) {
    errors.push("No Slack ingestion token is configured");
    return { source: "slack", changes, state, health: baseHealth };
  }

  const clientFactory = options.client_factory ?? defaultClientFactory;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retryContext: RetryContext = { retry_count: 0 };
  const maxRetries = Math.max(0, options.max_rate_limit_retries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES);
  const maxRetryAfter = Math.max(0, options.max_retry_after_ms ?? DEFAULT_MAX_RETRY_AFTER_MS);
  const retry = <T>(fn: () => Promise<T>) => callWithRateLimitRetry(
    fn,
    retryContext,
    sleep,
    maxRetries,
    maxRetryAfter,
  );

  const workspaces: AdmittedWorkspace[] = [];
  let credentialFailures = 0;
  for (const token of tokens) {
    const client = clientFactory(token.token, token.key);
    try {
      const auth = await retry(() => client.auth.test());
      assertSlackResponse(auth);
      if (!auth.team_id) throw new Error("auth.test did not return team_id");
      if (workspaces.some((workspace) => workspace.team_id === auth.team_id)) continue;
      workspaces.push({
        ...token,
        client,
        team_id: auth.team_id,
        ...(auth.team ? { team_name: auth.team } : {}),
        ...(auth.url ? { workspace_url: auth.url } : {}),
      });
    } catch (err) {
      credentialFailures++;
      errors.push(`Slack workspace ${token.key} authentication failed: ${safeError(err)}`);
    }
  }

  if (workspaces.length === 0) {
    baseHealth.credential_state = credentialFailures > 0 ? "invalid_credentials" : "missing_credentials";
    baseHealth.retry_count = retryContext.retry_count;
    return { source: "slack", changes, state, health: baseHealth };
  }
  baseHealth.credential_state = credentialFailures > 0 ? "misconfigured" : "ok";

  const resolved: ResolvedBinding[] = [];
  for (const raw of configuredBindings) {
    const parsed = parseBinding(raw);
    if (!parsed.channel_id) {
      const message = parsed.error ?? `Invalid Slack binding "${raw}"`;
      errors.push(message);
      bindingHealth.push({ binding: raw, status: "invalid_binding", indexed_thread_count: 0, retry_count: 0, message });
      continue;
    }
    let workspace: AdmittedWorkspace | undefined;
    if (parsed.workspace) {
      workspace = workspaces.find((candidate) =>
        candidate.key === parsed.workspace
        || candidate.team_id === parsed.workspace
        || candidate.team_name === parsed.workspace,
      );
    } else if (workspaces.length === 1) {
      workspace = workspaces[0];
    }
    if (!workspace) {
      const message = parsed.workspace
        ? `No authenticated Slack workspace matches "${parsed.workspace}"`
        : "A bare Slack channel ID is allowed only when exactly one workspace is configured";
      errors.push(message);
      bindingHealth.push({
        binding: raw,
        channel_id: parsed.channel_id,
        status: "workspace_not_found",
        indexed_thread_count: 0,
        retry_count: 0,
        message,
      });
      continue;
    }
    const duplicate = resolved.some((binding) =>
      binding.workspace.team_id === workspace!.team_id && binding.channel_id === parsed.channel_id,
    );
    if (!duplicate) resolved.push({ raw, workspace, channel_id: parsed.channel_id });
  }

  const overlap = Math.max(0, options.overlap_seconds ?? DEFAULT_OVERLAP_SECONDS);
  const backfill = Math.max(0, options.backfill_seconds ?? DEFAULT_BACKFILL_SECONDS);
  const reconciliationWindow = Math.max(0, options.reconciliation_window_seconds ?? DEFAULT_RECONCILIATION_SECONDS);
  const reconciliationInterval = Math.max(0, options.reconciliation_interval_ms ?? DEFAULT_RECONCILIATION_INTERVAL_MS);
  const pageSize = Math.max(1, options.page_size ?? DEFAULT_PAGE_SIZE);
  const maxHistoryPages = Math.max(1, options.max_history_pages ?? DEFAULT_MAX_HISTORY_PAGES);
  const maxReplyPages = Math.max(1, options.max_reply_pages ?? DEFAULT_MAX_REPLY_PAGES);
  const maxReconciliationThreads = Math.max(0, options.max_reconciliation_threads ?? DEFAULT_MAX_RECONCILIATION_THREADS);

  for (const binding of resolved) {
    const channelRetryStart = retryContext.retry_count;
    let info: Awaited<ReturnType<SlackClientLike["conversations"]["info"]>>;
    try {
      info = await retry(() => binding.workspace.client.conversations.info({
        channel: binding.channel_id,
        include_num_members: false,
      }));
      assertSlackResponse(info);
    } catch (err) {
      const code = errorCode(err);
      // Slack commonly returns channel_not_found when a formerly public
      // channel was deleted or made private and the app lost access. Treat
      // that positive loss-of-eligibility signal as a tombstone transition.
      if (code === "channel_not_found") {
        tombstonePreviouslyIndexedChannel(
          state,
          changes,
          options.org_id,
          options.project_id,
          binding.workspace.team_id,
          binding.channel_id,
          nowIso,
        );
      }
      const message = `Slack channel ${binding.raw} admission failed: ${safeError(err)}`;
      errors.push(message);
      bindingHealth.push({
        binding: binding.raw,
        workspace_id: binding.workspace.team_id,
        channel_id: binding.channel_id,
        status: code === "channel_not_found"
          ? "not_public"
          : isCredentialError(code)
            ? "invalid_credentials"
            : "error",
        indexed_thread_count: 0,
        retry_count: retryContext.retry_count - channelRetryStart,
        message,
      });
      continue;
    }

    const channel = info.channel;
    const isPublic = channel?.id === binding.channel_id
      && channel.is_channel === true
      && channel.is_private === false
      && channel.is_group !== true
      && channel.is_im !== true
      && channel.is_mpim !== true
      && channel.is_archived !== true;
    if (!isPublic) {
      tombstonePreviouslyIndexedChannel(
        state,
        changes,
        options.org_id,
        options.project_id,
        binding.workspace.team_id,
        binding.channel_id,
        nowIso,
      );
      const message = `Slack channel ${binding.raw} is not an eligible public channel`;
      errors.push(message);
      bindingHealth.push({
        binding: binding.raw,
        workspace_id: binding.workspace.team_id,
        channel_id: binding.channel_id,
        channel_name: channel?.name,
        status: "not_public",
        indexed_thread_count: 0,
        retry_count: retryContext.retry_count - channelRetryStart,
        message,
      });
      continue;
    }
    if (channel.is_member !== true) {
      tombstonePreviouslyIndexedChannel(
        state,
        changes,
        options.org_id,
        options.project_id,
        binding.workspace.team_id,
        binding.channel_id,
        nowIso,
      );
      const message = `Slack app is not a member of public channel ${binding.raw}`;
      errors.push(message);
      bindingHealth.push({
        binding: binding.raw,
        workspace_id: binding.workspace.team_id,
        channel_id: binding.channel_id,
        channel_name: channel.name,
        status: "not_member",
        indexed_thread_count: 0,
        retry_count: retryContext.retry_count - channelRetryStart,
        message,
      });
      continue;
    }

    const key = channelStateKey(binding.workspace.team_id, binding.channel_id);
    const previousChannel = state.channels[key];
    const nextChannel: SlackChannelPollState = previousChannel ?? {
      workspace_id: binding.workspace.team_id,
      channel_id: binding.channel_id,
      threads: {},
    };
    state.channels[key] = nextChannel;
    const reconcile = reconciliationIsDue(
      previousChannel,
      now.getTime(),
      options.force_reconciliation === true,
      reconciliationInterval,
    );
    const forwardOldest = nextChannel.watermark
      ? subtractSeconds(nextChannel.watermark, overlap)
      : subtractSeconds(scanLatest, backfill);
    const reconciliationOldest = subtractSeconds(scanLatest, reconciliationWindow);
    const oldest = reconcile && compareSlackTimestamps(reconciliationOldest, forwardOldest) < 0
      ? reconciliationOldest
      : forwardOldest;

    let history: PaginationResult;
    try {
      history = await paginateHistory(
        binding.workspace.client,
        binding.channel_id,
        oldest,
        scanLatest,
        pageSize,
        maxHistoryPages,
        retry,
      );
    } catch (err) {
      const message = `Slack channel ${binding.raw} history failed: ${safeError(err)}`;
      errors.push(message);
      bindingHealth.push({
        binding: binding.raw,
        workspace_id: binding.workspace.team_id,
        channel_id: binding.channel_id,
        channel_name: channel.name,
        status: "error",
        cursor_watermark: nextChannel.watermark,
        last_success_at: nextChannel.last_success_at,
        last_reconciliation_at: nextChannel.last_reconciliation_at,
        indexed_thread_count: Object.keys(nextChannel.threads).length,
        retry_count: retryContext.retry_count - channelRetryStart,
        message,
      });
      continue;
    }

    let channelComplete = history.complete;
    let reconciliationComplete = reconcile && history.complete;
    const seenRoots = new Set<string>();
    const roots = new Map<string, SlackMessageLike>();
    for (const message of history.messages) {
      if (!message.ts || message.subtype === "message_deleted") continue;
      const rootTs = message.thread_ts || message.ts;
      seenRoots.add(rootTs);
      const existing = roots.get(rootTs);
      if (!existing || message.ts === rootTs) roots.set(rootTs, message);
    }

    const sortedRoots = [...roots.entries()].sort(([a], [b]) => compareSlackTimestamps(a, b));
    const reconciliationCandidates = reconcile
      ? sortedRoots.filter(([rootTs, message]) =>
          compareSlackTimestamps(rootTs, reconciliationOldest) >= 0 && (message.reply_count ?? 0) > 0)
      : [];
    const reconciliationStart = nextChannel.reconciliation_cursor
      ? Math.max(0, reconciliationCandidates.findIndex(([rootTs]) =>
          compareSlackTimestamps(rootTs, nextChannel.reconciliation_cursor!) > 0))
      : 0;
    const boundedReconciliation = maxReconciliationThreads > 0
      ? reconciliationCandidates.slice(
          reconciliationStart,
          reconciliationStart + maxReconciliationThreads,
        )
      : [];
    const reconciliationRoots = new Set(boundedReconciliation.map(([rootTs]) => rootTs));
    let reconciliationFetchFailed = false;
    let lastCompletedReconciliationRoot = nextChannel.reconciliation_cursor;
    const reconciliationHasMore = reconcile
      && reconciliationStart + boundedReconciliation.length < reconciliationCandidates.length;
    if (reconcile && (maxReconciliationThreads === 0 || reconciliationHasMore)) {
      reconciliationComplete = false;
    }

    for (const [rootTs, historyMessage] of sortedRoots) {
      const previousThread = nextChannel.threads[rootTs];
      const hint = rootHint(historyMessage, rootTs);
      const inReconciliationWindow = compareSlackTimestamps(rootTs, reconciliationOldest) >= 0;
      const wantsReconciliationFetch = reconcile
        && inReconciliationWindow
        && reconciliationRoots.has(rootTs);
      const changedHint = !previousThread || previousThread.root_hint !== hint;
      let threadMessages: SlackMessageLike[] | null = null;

      if ((historyMessage.reply_count ?? 0) === 0 && historyMessage.ts === rootTs) {
        threadMessages = [historyMessage];
      } else if (changedHint || wantsReconciliationFetch) {
        try {
          const replies = await paginateReplies(
            binding.workspace.client,
            binding.channel_id,
            rootTs,
            pageSize,
            maxReplyPages,
            retry,
          );
          if (!replies.complete) {
            channelComplete = false;
            reconciliationComplete = false;
            if (wantsReconciliationFetch) {
              reconciliationFetchFailed = true;
              break;
            }
            continue;
          }
          threadMessages = replies.messages;
          if (wantsReconciliationFetch) lastCompletedReconciliationRoot = rootTs;
        } catch (err) {
          channelComplete = false;
          reconciliationComplete = false;
          if (wantsReconciliationFetch) reconciliationFetchFailed = true;
          errors.push(`Slack thread ${binding.raw}:${rootTs} failed: ${safeError(err)}`);
          if (wantsReconciliationFetch) break;
          continue;
        }
      }

      if (!threadMessages) continue;
      const built = buildUpsertChange(
        options.org_id,
        options.project_id,
        binding.workspace,
        { id: binding.channel_id, name: channel.name ?? binding.channel_id },
        rootTs,
        threadMessages,
        hint,
      );
      if (!built) continue;
      nextChannel.threads[rootTs] = built.state;
      if (!previousThread || previousThread.source_version !== built.change.source_version) {
        changes.push(built.change);
      }
    }

    if (reconcile && history.complete) {
      for (const [rootTs, previousThread] of Object.entries(nextChannel.threads)) {
        const eligible = compareSlackTimestamps(rootTs, reconciliationOldest) >= 0
          && compareSlackTimestamps(rootTs, scanLatest) <= 0;
        if (!eligible || seenRoots.has(rootTs)) continue;
        changes.push(buildDeleteChange(options.org_id, options.project_id, nextChannel, rootTs, previousThread, nowIso));
        delete nextChannel.threads[rootTs];
      }
    }

    if (!history.complete) {
      const message = `Slack channel ${binding.raw} exceeded the history pagination bound`;
      errors.push(message);
      reconciliationComplete = false;
    }
    if (channelComplete) {
      // A fixed scan boundary plus the overlap window prevents a message posted
      // during this scan from falling between two successful polls.
      nextChannel.watermark = scanLatest;
      nextChannel.last_success_at = nowIso;
    }
    if (reconcile && history.complete) {
      if (reconciliationFetchFailed) {
        if (lastCompletedReconciliationRoot) {
          nextChannel.reconciliation_cursor = lastCompletedReconciliationRoot;
        } else {
          delete nextChannel.reconciliation_cursor;
        }
      } else if (reconciliationHasMore && boundedReconciliation.length > 0) {
        nextChannel.reconciliation_cursor = boundedReconciliation[boundedReconciliation.length - 1][0];
      } else if (maxReconciliationThreads > 0) {
        delete nextChannel.reconciliation_cursor;
      }
    }
    if (reconciliationComplete) {
      nextChannel.last_reconciliation_at = nowIso;
      delete nextChannel.reconciliation_cursor;
    }

    const bindingLag = sourceLagSeconds(nextChannel, now.getTime());
    bindingHealth.push({
      binding: binding.raw,
      workspace_id: binding.workspace.team_id,
      channel_id: binding.channel_id,
      channel_name: channel.name,
      status: channelComplete ? "ok" : "error",
      cursor_watermark: nextChannel.watermark,
      last_success_at: nextChannel.last_success_at,
      last_reconciliation_at: nextChannel.last_reconciliation_at,
      ...(bindingLag !== undefined ? { lag_seconds: bindingLag } : {}),
      indexed_thread_count: Object.keys(nextChannel.threads).length,
      retry_count: retryContext.retry_count - channelRetryStart,
      ...(!channelComplete ? { message: `Slack channel ${binding.raw} sync was incomplete` } : {}),
    });
  }

  baseHealth.admitted_bindings = bindingHealth.filter((entry) => entry.status === "ok").length;
  baseHealth.retry_count = retryContext.retry_count;
  baseHealth.indexed_thread_count = Object.values(state.channels).reduce(
    (sum, channel) => sum + Object.keys(channel.threads).length,
    0,
  );
  const successes = bindingHealth.map((entry) => entry.last_success_at).filter((value): value is string => !!value).sort();
  const reconciliations = bindingHealth
    .map((entry) => entry.last_reconciliation_at)
    .filter((value): value is string => !!value)
    .sort();
  const lags = bindingHealth.map((entry) => entry.lag_seconds).filter((value): value is number => value !== undefined);
  if (successes.length > 0) baseHealth.last_success_at = successes[successes.length - 1];
  if (reconciliations.length > 0) baseHealth.last_reconciliation_at = reconciliations[reconciliations.length - 1];
  if (lags.length > 0) baseHealth.lag_seconds = Math.max(...lags);
  if (baseHealth.admitted_bindings === 0 && baseHealth.credential_state === "ok") {
    baseHealth.credential_state = "misconfigured";
  }
  return { source: "slack", changes, state, health: baseHealth };
}
