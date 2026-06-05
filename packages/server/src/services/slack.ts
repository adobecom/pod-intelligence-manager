import { WebClient } from "@slack/web-api";
import type { Conflict } from "@pim/shared";
import db from "../db/connection.js";
import { EMAIL_RE } from "./identity-resolver.js";

// ── Configuration ──────────────────────────────────────────────────
// Env vars:
//   SLACK_BOT_TOKEN   – xoxb-... token from a Slack app (see docs/DEPLOYMENT_CHECKLIST.md)
//   SLACK_CHANNEL_ID  – default channel for conflict / pressure channel notifications
//
// Channel posts require both token and channel id. Org-invite DMs only need
// the bot token (users.lookupByEmail + conversations.open + chat.postMessage).

const token = process.env.SLACK_BOT_TOKEN;
const defaultChannel = process.env.SLACK_CHANNEL_ID;

const slack = token ? new WebClient(token) : null;

/** Channel notifications (conflicts, pressure, backlog) — needs token + channel. */
function isChannelNotificationsEnabled(): boolean {
  return slack !== null && !!defaultChannel;
}

/** Bot-only features (e.g. org-invite DMs) — needs token only. */
export function isBotAvailable(): boolean {
  return slack !== null;
}

// Fire-and-forget — never block the pipeline on Slack delivery
function send(fn: () => Promise<unknown>): void {
  if (!isChannelNotificationsEnabled()) return;
  fn().catch((err) => {
    console.error("[slack] Failed to send message:", err?.message ?? err);
  });
}

// Awaited variant for callers that need the posted message's `ts` (e.g. to
// thread follow-up notifications). Returns undefined when Slack is disabled
// or the post fails — callers should treat it as best-effort.
async function sendAndGetTs(fn: () => Promise<{ ts?: string } | undefined>): Promise<string | undefined> {
  if (!isChannelNotificationsEnabled()) return undefined;
  try {
    const res = await fn();
    return res?.ts;
  } catch (err) {
    console.error("[slack] Failed to send message:", (err as Error)?.message ?? err);
    return undefined;
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function podName(podId: string): string {
  const row = db.prepare("SELECT name FROM pods WHERE pod_id = ?").get(podId) as { name: string } | undefined;
  return row?.name ?? podId;
}

const UI_BASE = process.env.PIM_UI_URL ?? "http://localhost:5173";

function conflictUrl(podId: string, conflictId: string): string {
  return `${UI_BASE}/pod/${podId}/conflict/${conflictId}`;
}

function severityEmoji(severity: string): string {
  return severity === "blocking" ? ":red_circle:" : ":large_yellow_circle:";
}

function escalationEmoji(level: number): string {
  if (level >= 4) return ":rotating_light:";
  if (level >= 3) return ":warning:";
  if (level >= 2) return ":bell:";
  return ":mega:";
}

const SLACK_ID_RE = /^U[A-Z0-9]{8,}$/;

// Best-effort: if the contributor string is a Slack user ID, email, or matches
// a cached identity, return `<@UXXX>`. Otherwise fall back to the raw string so
// the notification still reads naturally without a native Slack ping.
function resolveAgentToSlackMention(contributor: string): string {
  if (!contributor) return contributor;
  const trimmed = contributor.trim();

  if (SLACK_ID_RE.test(trimmed)) return `<@${trimmed}>`;

  const emailMatch = trimmed.match(EMAIL_RE)?.[0];
  if (emailMatch) {
    try {
      const row = db
        .prepare("SELECT slack_user_id FROM identity_cache WHERE kind = 'email' AND value = ?")
        .get(emailMatch) as { slack_user_id: string | null } | undefined;
      if (row?.slack_user_id) return `<@${row.slack_user_id}>`;
    } catch {
      // identity_cache may not exist on very old DBs; ignore
    }
  }

  return trimmed;
}

// ── Public API ─────────────────────────────────────────────────────

export async function notifyConflictCreated(conflict: Conflict): Promise<string | undefined> {
  return sendAndGetTs(async () => {
    const pod = podName(conflict.pod_id);
    const sideNames = conflict.sides.map((s) => resolveAgentToSlackMention(s.contributor)).join(" vs ");
    const url = conflictUrl(conflict.pod_id, conflict.id);

    return slack!.chat.postMessage({
      channel: defaultChannel!,
      text: `${severityEmoji(conflict.severity)} New ${conflict.severity} conflict in *${pod}*: ${conflict.summary}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${severityEmoji(conflict.severity)} *New conflict in ${pod}*\n\n*${conflict.summary}*`,
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Severity:*\n${conflict.severity.replace("_", "-")}` },
            { type: "mrkdwn", text: `*Conflict ID:*\n${conflict.id}` },
            { type: "mrkdwn", text: `*Contributors:*\n${sideNames}` },
            { type: "mrkdwn", text: `*Pod:*\n${pod}` },
          ],
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Analysis:*\n${truncate(conflict.master_analysis, 300)}`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "View in PIM" },
              url,
            },
          ],
        },
      ],
    });
  });
}

export function notifyConflictEscalated(
  podId: string,
  conflictId: string,
  level: number,
  message: string,
  ageHours: number,
  threadTs?: string,
): void {
  send(async () => {
    const pod = podName(podId);
    const url = conflictUrl(podId, conflictId);

    await slack!.chat.postMessage({
      channel: defaultChannel!,
      thread_ts: threadTs,
      text: `${escalationEmoji(level)} Escalation L${level} in *${pod}*: ${message}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${escalationEmoji(level)} *Conflict escalated — Level ${level}*\n\nPod: *${pod}*  |  Conflict: \`${conflictId}\`  |  Age: ${ageHours}h`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: message,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Resolve now" },
              url,
              style: level >= 3 ? "danger" : undefined,
            },
          ],
        },
      ],
    });
  });
}

export function notifyConflictResolved(conflict: Conflict, threadTs?: string): void {
  send(async () => {
    const pod = podName(conflict.pod_id);
    const url = conflictUrl(conflict.pod_id, conflict.id);

    await slack!.chat.postMessage({
      channel: defaultChannel!,
      thread_ts: threadTs,
      text: `:white_check_mark: Conflict resolved in *${pod}*: ${conflict.summary}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:white_check_mark: *Conflict resolved in ${pod}*\n\n*${conflict.summary}*`,
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Resolved by:*\n${conflict.resolved_by ?? "—"}` },
            { type: "mrkdwn", text: `*Conflict ID:*\n${conflict.id}` },
          ],
        },
        ...(conflict.resolution
          ? [
              {
                type: "section" as const,
                text: {
                  type: "mrkdwn" as const,
                  text: `*Resolution:*\n${truncate(conflict.resolution, 300)}`,
                },
              },
            ]
          : []),
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "View details" },
              url,
            },
          ],
        },
      ],
    });
  });
}

export function notifyPressureThreshold(
  podId: string,
  pressure: number,
  previousPressure: number,
  thresholds: { cautiousMax: number; degradedMax: number } = {
    cautiousMax: 0.6,
    degradedMax: 0.8,
  },
): void {
  const crossedDegraded =
    previousPressure < thresholds.cautiousMax && pressure >= thresholds.cautiousMax;
  const crossedCritical =
    previousPressure < thresholds.degradedMax && pressure >= thresholds.degradedMax;

  if (!crossedDegraded && !crossedCritical) return;

  send(async () => {
    const pod = podName(podId);
    const level = crossedCritical ? "CRITICAL" : "DEGRADED";
    const emoji = crossedCritical ? ":rotating_light:" : ":warning:";
    const color = crossedCritical ? "danger" : "warning";

    await slack!.chat.postMessage({
      channel: defaultChannel!,
      text: `${emoji} Pod *${pod}* conflict pressure is now ${level} (${(pressure * 100).toFixed(0)}%)`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${emoji} *Pod ${pod} — Conflict Pressure ${level}*\n\nPressure: *${(pressure * 100).toFixed(0)}%*  (was ${(previousPressure * 100).toFixed(0)}%)`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: crossedCritical
              ? ":hourglass_flowing_sand: *Context updates queued.* Intake still accepted but processing is paused until conflicts are resolved."
              : ":pause_button: *Contested areas held.* Merges in overlapping areas are paused.",
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Open pod" },
              url: `${UI_BASE}/pod/${podId}/conflicts`,
              style: color === "danger" ? "danger" : undefined,
            },
          ],
        },
      ],
    });
  });
}

export function notifyQueueBacklog(podId: string, queueSize: number): void {
  send(async () => {
    const pod = podName(podId);
    await slack!.chat.postMessage({
      channel: defaultChannel!,
      text: `:hourglass_flowing_sand: Queue backlog alert — ${pod} has ${queueSize} updates waiting`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:hourglass_flowing_sand: *Queue backlog alert — ${pod}*\n\n*${queueSize} context updates* are waiting to be processed. Resolve the blocking conflicts to drain the queue.`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "View Conflicts" },
              url: `${UI_BASE}/pod/${podId}/conflicts`,
              style: "danger",
            },
          ],
        },
      ],
    });
  });
}

function sendDm(fn: () => Promise<unknown>): void {
  if (!isBotAvailable()) return;
  fn().catch((err) => {
    console.error("[slack] Failed to send DM:", (err as Error)?.message ?? err);
  });
}

export interface OrgInviteDmParams {
  inviteeEmail: string;
  inviteId: string;
  orgName: string;
  /** Display label e.g. `admin` or `member` */
  role: string;
  inviterLabel: string;
}

/** Best-effort DM with accept link; no-ops if bot token missing or Slack errors. */
export function notifyOrgInviteDM(params: OrgInviteDmParams): void {
  sendDm(async () => {
    const lookup = await slack!.users.lookupByEmail({ email: params.inviteeEmail });
    if (!lookup.ok || !lookup.user?.id) {
      if (!lookup.ok) console.error("[slack] lookupByEmail:", lookup.error ?? "unknown");
      return;
    }
    const opened = await slack!.conversations.open({ users: lookup.user.id });
    if (!opened.ok || !opened.channel?.id) {
      console.error("[slack] conversations.open:", opened.error ?? "unknown");
      return;
    }
    const acceptUrl = `${UI_BASE}/accept/${params.inviteId}`;
    const roleNice = params.role === "admin" ? "admin" : "member";
    await slack!.chat.postMessage({
      channel: opened.channel.id,
      text: `You've been invited to join *${params.orgName}* on PIM (${roleNice})`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `:incoming_envelope: *Organization invite — PIM*\n\n*${params.inviterLabel}* invited you to join *${params.orgName}* as *${roleNice}*.`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Accept invite" },
              url: acceptUrl,
            },
          ],
        },
      ],
    });
  });
}

// ── Utilities ──────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}
