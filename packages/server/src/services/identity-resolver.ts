// Identity resolver — detects person tokens in a free-text query (email,
// Slack user id, "what has <name> been up to") and resolves to a unified
// { email, slack_user_id, github_login, display_name } shape per-integration
// authorship filters can use. Results are cached in SQLite with a 7-day TTL
// so repeat queries don't re-hit the Slack/GitHub APIs.

import { WebClient } from "@slack/web-api";
import type { ContextSearchActor } from "@pim/shared";
import db from "../db/connection.js";

const TTL_SEC = 7 * 24 * 3600;

export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const SLACK_ID_RE = /\bU[A-Z0-9]{8,}\b/;

// Two phrasings that mark a query as person-activity:
//   "what has <person> been up to / working on / doing / done"
//   "<person> recent activity / latest work / activity this week"
const ACTIVITY_VERB_PHRASE_RE =
  /\bwhat\s+(has|is|have)\s+.+?\s+(been\s+up\s+to|working\s+on|doing|done)\b/i;
const ACTIVITY_NOUN_PHRASE_RE =
  /\b(recent|latest|current|today's|this\s+week's?)\s+(activity|work|contributions?|commits?|prs?|tickets?)\b/i;

export interface DetectedTokens {
  email?: string;
  slack_user_id?: string;
  cleaned_query: string;      // query with tokens stripped — useful for text-search fallback
  is_activity_query: boolean; // "what has X been up to" / "X recent activity"
}

export function detectPersonTokens(query: string): DetectedTokens {
  const email = query.match(EMAIL_RE)?.[0];
  const slack_user_id = query.match(SLACK_ID_RE)?.[0];
  const is_activity_query =
    ACTIVITY_VERB_PHRASE_RE.test(query) || ACTIVITY_NOUN_PHRASE_RE.test(query);

  let cleaned = query;
  if (email) cleaned = cleaned.replace(email, "");
  if (slack_user_id) cleaned = cleaned.replace(slack_user_id, "");
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  return {
    email,
    slack_user_id,
    cleaned_query: cleaned,
    is_activity_query,
  };
}

// Strip activity phrasing and the actor's tokens from a query so per-source
// integrations can rely on authorship filters alone (`from:<@UXXX>`,
// `assignee = "..."`, `author:<gh_login>`) without anchoring text-match on
// filler words like "recent" or "activity". Returns the residual subject —
// often empty for pure activity queries, which is the desired signal.
export function stripActivityPhrasing(
  query: string,
  actor?: { email?: string; slack_user_id?: string; display_name?: string },
): string {
  let q = query;
  if (actor) {
    for (const tok of [actor.email, actor.slack_user_id, actor.display_name]) {
      if (tok) q = q.replace(tok, " ");
    }
  }
  q = q
    .replace(ACTIVITY_VERB_PHRASE_RE, " ")
    .replace(ACTIVITY_NOUN_PHRASE_RE, " ")
    .replace(/\b(what|who|when|where|why|how)\b/gi, " ")
    .replace(/\b(recent|latest|current|today|today's|this\s+week|this\s+sprint)\b/gi, " ")
    .replace(/\b(activity|activities|work|contributions?|commits?)\b/gi, " ")
    .replace(/\bbeen\s+up\s+to\b/gi, " ")
    .replace(/\bworking\s+on\b/gi, " ")
    .replace(/[?!.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return q;
}

function readCache(kind: string, value: string): ContextSearchActor | null {
  try {
    const row = db
      .prepare(
        "SELECT email, slack_user_id, github_login, display_name, resolved_at FROM identity_cache WHERE kind = ? AND value = ?",
      )
      .get(kind, value) as
      | {
          email: string | null;
          slack_user_id: string | null;
          github_login: string | null;
          display_name: string | null;
          resolved_at: string;
        }
      | undefined;
    if (!row) return null;
    const ageSec = (Date.now() - new Date(row.resolved_at).getTime()) / 1000;
    if (ageSec > TTL_SEC) return null;
    return {
      email: row.email ?? undefined,
      slack_user_id: row.slack_user_id ?? undefined,
      github_login: row.github_login ?? undefined,
      display_name: row.display_name ?? undefined,
    };
  } catch {
    return null;
  }
}

function writeCache(kind: string, value: string, actor: ContextSearchActor): void {
  try {
    db.prepare(
      `INSERT OR REPLACE INTO identity_cache
         (kind, value, email, slack_user_id, github_login, display_name, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      kind,
      value,
      actor.email ?? null,
      actor.slack_user_id ?? null,
      actor.github_login ?? null,
      actor.display_name ?? null,
      new Date().toISOString(),
    );
  } catch (err) {
    console.error("[identity-resolver] cache write failed:", (err as Error).message);
  }
}

function firstSlackClient(): WebClient | null {
  const envs = [
    "SLACK_USER_TOKEN_MWP",
    "SLACK_USER_TOKEN_AEM_ENG",
    "SLACK_USER_TOKEN_ADOBEDOTCOM",
  ];
  for (const e of envs) {
    const token = process.env[e];
    if (token) return new WebClient(token);
  }
  return null;
}

async function slackLookupByEmail(email: string): Promise<{
  slack_user_id?: string;
  display_name?: string;
} | null> {
  const client = firstSlackClient();
  if (!client) return null;
  try {
    const res = await client.users.lookupByEmail({ email });
    const user = res.user as { id?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } | undefined;
    if (!user) return null;
    return {
      slack_user_id: user.id,
      display_name: user.profile?.real_name ?? user.profile?.display_name ?? user.real_name,
    };
  } catch {
    return null;
  }
}

async function slackUserInfo(
  slackUserId: string,
): Promise<{ email?: string; display_name?: string } | null> {
  const client = firstSlackClient();
  if (!client) return null;
  try {
    const res = await client.users.info({ user: slackUserId });
    const user = res.user as
      | { real_name?: string; profile?: { email?: string; real_name?: string; display_name?: string } }
      | undefined;
    if (!user) return null;
    return {
      email: user.profile?.email,
      display_name: user.profile?.real_name ?? user.profile?.display_name ?? user.real_name,
    };
  } catch {
    return null;
  }
}

async function githubLookupByEmail(email: string): Promise<string | undefined> {
  const token = process.env.GH_TOKEN;
  if (!token) return undefined;
  try {
    const res = await fetch(
      `https://api.github.com/search/users?q=${encodeURIComponent(`${email} in:email`)}&per_page=1`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!res.ok) return undefined;
    const data = (await res.json()) as { items?: Array<{ login?: string }> };
    return data.items?.[0]?.login;
  } catch {
    return undefined;
  }
}

export async function resolveActor(
  tokens: DetectedTokens,
): Promise<ContextSearchActor | undefined> {
  if (!tokens.email && !tokens.slack_user_id) return undefined;

  const cacheKind = tokens.email ? "email" : "slack_id";
  const cacheValue = tokens.email ?? tokens.slack_user_id!;
  const cached = readCache(cacheKind, cacheValue);
  if (cached) return cached;

  const actor: ContextSearchActor = {};

  if (tokens.email) {
    actor.email = tokens.email;
    const [slack, gh] = await Promise.all([
      slackLookupByEmail(tokens.email),
      githubLookupByEmail(tokens.email),
    ]);
    if (slack?.slack_user_id) actor.slack_user_id = slack.slack_user_id;
    if (slack?.display_name) actor.display_name = slack.display_name;
    if (gh) actor.github_login = gh;
  } else if (tokens.slack_user_id) {
    actor.slack_user_id = tokens.slack_user_id;
    const info = await slackUserInfo(tokens.slack_user_id);
    if (info?.email) {
      actor.email = info.email;
      actor.github_login = await githubLookupByEmail(info.email);
    }
    if (info?.display_name) actor.display_name = info.display_name;
  }

  writeCache(cacheKind, cacheValue, actor);
  return actor;
}
