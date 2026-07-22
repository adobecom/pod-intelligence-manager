import { WebClient } from "@slack/web-api";
import type { SearchDocument } from "@pim/shared";
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

function bindingForWorkspace(binding: string, workspace: string): string | null {
  const trimmed = binding.trim();
  const colon = trimmed.indexOf(":");
  if (colon < 0) return trimmed.replace(/^#/, "");
  if (trimmed.slice(0, colon) !== workspace) return null;
  return trimmed.slice(colon + 1).replace(/^#/, "");
}

function buildSlackQuery(opts: IntegrationSearchOpts, allowedChannels: string[]): string {
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

  for (const channel of allowedChannels) {
    // Slack's search modifier accepts names, not stable C... IDs. Stable IDs
    // are enforced again on returned channel metadata below.
    if (!/^C[A-Z0-9]+$/.test(channel)) parts.push(`in:#${channel}`);
  }

  if (actor?.slack_user_id) parts.push(`from:<@${actor.slack_user_id}>`);

  parts.push(`after:${isoDaysAgo(opts.time_window_days)}`);
  return parts.join(" ");
}

export async function searchSlack(opts: IntegrationSearchOpts): Promise<IntegrationResult> {
  const configuredBindings = opts.project_resources?.slack?.channels ?? [];
  if (opts.project_id && !["1", "true", "yes", "on"].includes(
    (process.env.PROJECT_SLACK_SEARCH_ENABLED ?? "").trim().toLowerCase(),
  )) {
    return { source: "slack", documents: [], missing: "Slack connector is disabled" };
  }
  if (opts.project_id && configuredBindings.length === 0) {
    return { source: "slack", documents: [], missing: "No Slack channels are bound to this project" };
  }
  const configured = WORKSPACES.filter((w) => !!process.env[w.envVar]);
  if (configured.length === 0) {
    return {
      source: "slack",
      documents: [],
      missing: "No Slack workspace tokens set (SLACK_USER_TOKEN_MWP/AEM_ENG/ADOBEDOTCOM)",
    };
  }
  if (opts.project_id && configured.length > 1 && configuredBindings.some((binding) => !binding.includes(":"))) {
    return {
      source: "slack",
      documents: [],
      missing: "Slack channel bindings must include a workspace when multiple workspaces are configured",
    };
  }

  const perWorkspace = Math.max(1, Math.ceil(opts.max_hits_per_source / configured.length));

  const results = await Promise.allSettled(
    configured.map(async (ws) => {
      const allowedChannels = configuredBindings
        .map((binding) => bindingForWorkspace(binding, ws.name))
        .filter((channel): channel is string => !!channel && /^C[A-Z0-9]+$/.test(channel));
      if (opts.project_id && allowedChannels.length === 0) return [];
      const client = new WebClient(process.env[ws.envVar]!);
      const res = await client.search.messages({
        query: buildSlackQuery(opts, allowedChannels),
        count: perWorkspace,
        sort: "timestamp",
        sort_dir: "desc",
      });
      const matches = (res.messages?.matches ?? []) as SlackMatch[];
      // Hard filter to public channels only, regardless of token scope.
      // search:read grants search across DMs/private channels the user is in;
      // we drop those server-side so only public-channel hits leave the server.
      const publicOnly = matches.filter(
        (m) => m.channel
          && m.channel.is_private === false
          && !m.channel.is_im
          && !m.channel.is_mpim
          && (!opts.project_id
            || allowedChannels.some((allowed) => m.channel?.id === allowed)),
      );
      return publicOnly.map<SearchDocument>((m) => ({
        org_id: opts.org_id,
        project_id: opts.project_id,
        source: "slack",
        source_type: "message",
        source_id: m.permalink ?? `${ws.name}:${m.ts ?? "unknown"}`,
        source_url: m.permalink,
        title: `#${m.channel?.name ?? "unknown"} (${ws.name})`,
        snippet: truncate(m.text ?? ""),
        author: m.username ?? m.user,
        timestamp: m.ts ? new Date(Number(m.ts) * 1000).toISOString() : undefined,
        metadata: { workspace: ws.name, channel_id: m.channel?.id },
      }));
    }),
  );

  const documents: SearchDocument[] = [];
  const errors: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      documents.push(...r.value);
    } else {
      errors.push(`${configured[i].name}: slack_search_failed`);
    }
  }

  return {
    source: "slack",
    documents: documents.slice(0, opts.max_hits_per_source),
    ...(errors.length && documents.length === 0 ? { missing: `All Slack workspaces failed: ${errors.join("; ")}` } : {}),
  };
}
