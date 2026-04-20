import { WebClient } from "@slack/web-api";
import type { Conflict } from "@pim/shared";
import db from "../db/connection.js";

// ── Configuration ──────────────────────────────────────────────────
// Env vars:
//   SLACK_BOT_TOKEN   – xoxb-... token from a Slack app with chat:write scope
//   SLACK_CHANNEL_ID  – default channel for all notifications
//
// Both are required. If either is missing the service silently no-ops
// so the server works fine without Slack configured.

const token = process.env.SLACK_BOT_TOKEN;
const defaultChannel = process.env.SLACK_CHANNEL_ID;

const slack = token ? new WebClient(token) : null;

function isEnabled(): boolean {
  return slack !== null && !!defaultChannel;
}

// Fire-and-forget — never block the pipeline on Slack delivery
function send(fn: () => Promise<unknown>): void {
  if (!isEnabled()) return;
  fn().catch((err) => {
    console.error("[slack] Failed to send message:", err?.message ?? err);
  });
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

// ── Public API ─────────────────────────────────────────────────────

export function notifyConflictCreated(conflict: Conflict): void {
  send(async () => {
    const pod = podName(conflict.pod_id);
    const sideNames = conflict.sides.map((s) => s.contributor).join(" vs ");
    const url = conflictUrl(conflict.pod_id, conflict.id);

    await slack!.chat.postMessage({
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
): void {
  send(async () => {
    const pod = podName(podId);
    const url = conflictUrl(podId, conflictId);

    await slack!.chat.postMessage({
      channel: defaultChannel!,
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

export function notifyConflictResolved(conflict: Conflict): void {
  send(async () => {
    const pod = podName(conflict.pod_id);
    const url = conflictUrl(conflict.pod_id, conflict.id);

    await slack!.chat.postMessage({
      channel: defaultChannel!,
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
): void {
  // Only notify when crossing into degraded (0.6) or critical (0.8)
  const crossedDegraded = previousPressure < 0.6 && pressure >= 0.6;
  const crossedCritical = previousPressure < 0.8 && pressure >= 0.8;

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

// ── Utilities ──────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}
