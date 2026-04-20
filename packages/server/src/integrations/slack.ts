import { WebClient } from "@slack/web-api";
import type { ContextSearchHit } from "@pim/shared";
import { type IntegrationResult, type IntegrationSearchOpts, truncate, isoDaysAgo } from "./types.js";

// Per-workspace user tokens. Empty entries are skipped.
const WORKSPACES: { name: string; envVar: string }[] = [
  { name: "mwp", envVar: "SLACK_USER_TOKEN_MWP" },
  { name: "aem_eng", envVar: "SLACK_USER_TOKEN_AEM_ENG" },
  { name: "adobedotcom", envVar: "SLACK_USER_TOKEN_ADOBEDOTCOM" },
];

interface SlackMatch {
  permalink?: string;
  text?: string;
  user?: string;
  username?: string;
  ts?: string;
  channel?: { id?: string; name?: string; is_private?: boolean; is_im?: boolean; is_mpim?: boolean };
}

function buildSlackQuery(opts: IntegrationSearchOpts): string {
  const parts: string[] = [];

  let text = opts.query.trim();
  // When actor email / slack id is already encoded as from:<UXXX>, strip
  // it from the text-match so we don't also require the literal string.
  const actor = opts.actor;
  if (actor) {
    for (const token of [actor.email, actor.slack_user_id]) {
      if (token) text = text.replace(token, "");
    }
    text = text.replace(/\s+/g, " ").trim();
  }
  if (text) parts.push(text);

  const channels = opts.project_resources?.slack?.channels ?? [];
  for (const c of channels) {
    const clean = c.replace(/^#/, "");
    parts.push(`in:#${clean}`);
  }

  if (actor?.slack_user_id) parts.push(`from:<@${actor.slack_user_id}>`);

  parts.push(`after:${isoDaysAgo(opts.time_window_days)}`);
  return parts.join(" ");
}

export async function searchSlack(opts: IntegrationSearchOpts): Promise<IntegrationResult> {
  const configured = WORKSPACES.filter((w) => !!process.env[w.envVar]);
  if (configured.length === 0) {
    return {
      source: "slack",
      hits: [],
      missing: "No Slack workspace tokens set (SLACK_USER_TOKEN_MWP/AEM_ENG/ADOBEDOTCOM)",
    };
  }

  const query = buildSlackQuery(opts);
  const perWorkspace = Math.max(1, Math.ceil(opts.max_hits_per_source / configured.length));

  const results = await Promise.allSettled(
    configured.map(async (ws) => {
      const client = new WebClient(process.env[ws.envVar]!);
      const res = await client.search.messages({
        query,
        count: perWorkspace,
        sort: "timestamp",
        sort_dir: "desc",
      });
      const matches = (res.messages?.matches ?? []) as SlackMatch[];
      // Hard filter to public channels only, regardless of token scope.
      // search:read grants search across DMs/private channels the user is in;
      // we drop those server-side so only public-channel hits leave the server.
      const publicOnly = matches.filter(
        (m) => m.channel && m.channel.is_private !== true && !m.channel.is_im && !m.channel.is_mpim,
      );
      return publicOnly.map<ContextSearchHit>((m) => ({
        source: "slack",
        title: `#${m.channel?.name ?? "unknown"} (${ws.name})`,
        url: m.permalink,
        snippet: truncate(m.text ?? ""),
        author: m.username ?? m.user,
        timestamp: m.ts ? new Date(Number(m.ts) * 1000).toISOString() : undefined,
        metadata: { workspace: ws.name, channel_id: m.channel?.id },
      }));
    }),
  );

  const hits: ContextSearchHit[] = [];
  const errors: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      hits.push(...r.value);
    } else {
      errors.push(`${configured[i].name}: ${r.reason?.message ?? r.reason}`);
    }
  }

  return {
    source: "slack",
    hits: hits.slice(0, opts.max_hits_per_source),
    ...(errors.length && hits.length === 0 ? { missing: `All Slack workspaces failed: ${errors.join("; ")}` } : {}),
  };
}
