/**
 * Operator-owned visibility boundary for project-scoped Confluence evidence.
 * A project resource binding selects what to search; it does not prove that
 * every PIM project member can view the selected Confluence space/page.
 */

export interface ConfluenceVisibilityCandidate {
  id: string;
  space?: { key?: string };
}

export interface ConfluenceProjectVisibilityPolicy {
  space_keys: Set<string>;
  page_ids: Set<string>;
}

export function configuredConfluenceSourceInstance(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string | null {
  const raw = env.CONFLUENCE_BASE_URL;
  if (!raw) return null;
  try {
    const base = new URL(raw.endsWith("/") ? raw : `${raw}/`);
    if (env.NODE_ENV === "production" && base.protocol !== "https:") return null;
    return `${base.host}${base.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

function csvSet(value: string | undefined, normalize: (entry: string) => string): Set<string> {
  return new Set((value ?? "")
    .split(",")
    .map((entry) => normalize(entry.trim()))
    .filter(Boolean));
}

/** These allowlists are deployment assertions: every person who may search a
 * PIM project is entitled to view these spaces/pages. Content and ancestor
 * restrictions are still checked dynamically on every reconciliation. */
export function confluenceProjectVisibilityPolicy(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ConfluenceProjectVisibilityPolicy {
  return {
    space_keys: csvSet(env.CONFLUENCE_PROJECT_VISIBLE_SPACE_KEYS, (entry) => entry.toUpperCase()),
    page_ids: csvSet(env.CONFLUENCE_PROJECT_VISIBLE_PAGE_IDS, (entry) => entry),
  };
}

export function hasConfluenceProjectVisibilityPolicy(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const policy = confluenceProjectVisibilityPolicy(env);
  return policy.space_keys.size > 0 || policy.page_ids.size > 0;
}

export function isConfluenceCandidateProjectVisible(
  page: ConfluenceVisibilityCandidate,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const policy = confluenceProjectVisibilityPolicy(env);
  const spaceKey = page.space?.key?.trim().toUpperCase();
  return policy.page_ids.has(page.id) || (!!spaceKey && policy.space_keys.has(spaceKey));
}
