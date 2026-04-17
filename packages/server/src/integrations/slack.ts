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
  channel?: { id?: string; name?: string };
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

  const query = `${opts.query} after:${isoDaysAgo(opts.time_window_days)}`;
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
      return matches.map<ContextSearchHit>((m) => ({
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
