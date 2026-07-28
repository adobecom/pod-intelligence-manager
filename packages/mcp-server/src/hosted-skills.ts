import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type HostedSkillsApiPath =
  | "/api/skill-search"
  | "/api/skill-conflicts";

/**
 * The hosted registration is deliberately transport- and auth-agnostic. Callers
 * inject the API boundary so this module never reads process environment,
 * credentials, the current working directory, or `.pim.json`.
 */
export interface HostedSkillsApiClient {
  post<T = unknown>(path: HostedSkillsApiPath, body: unknown): Promise<T>;
}

export interface HostedSkillToolOptions {
  /**
   * Standalone stdio supplies its existing resolver here. Hosted HTTP leaves
   * this unset so only an explicit tool argument is forwarded.
   */
  resolveProjectId?: (explicitProjectId?: string) => string | undefined;
  projectContext?: "hosted" | "stdio";
}

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const ProjectId = z.string().describe("Project ID (e.g. 'project-emc')");

const SkillSourceId = z
  .string()
  .min(1)
  .max(128)
  .describe(
    "Advanced override for a configured skill catalog source ID, e.g. 'mimir-main'. Normally omit this so PIM uses the project mapping or org default.",
  );

const SkillNamespace = z
  .string()
  .refine(
    (value) =>
      value === "shared" ||
      /^project:[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/.test(value),
    "Must be shared or project:<id>",
  )
  .describe("Skill namespace: 'shared' or 'project:<id>'");

const FullGitSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/i, "Must be a full Git SHA")
  .describe("Full 40-character base commit SHA");

const SkillConflictCandidateInputSchema = z.object({
  candidate_id: z.string().min(1).max(200).describe("Stable ID for this candidate"),
  name: z.string().min(1).max(500).describe("Final skill name"),
  description: z.string().max(4_000).optional(),
  proposed_path: z
    .string()
    .min(1)
    .max(1_024)
    .describe("Final repository-relative path for the skill"),
  target_namespace: SkillNamespace,
  body: z
    .string()
    .describe("Complete final Markdown bytes. The API enforces 256 KiB per candidate."),
  replaces_path: z
    .string()
    .min(1)
    .max(1_024)
    .optional()
    .describe("Base-revision path replaced by a modified or renamed skill"),
});

function explicitProjectId(explicit?: string): string | undefined {
  return explicit?.trim() || undefined;
}

/**
 * Register the complete hosted skill surface. This intentionally exposes only
 * advisory search and authoritative deterministic conflict detection.
 */
export function registerHostedSkillTools(
  server: McpServer,
  apiClient: HostedSkillsApiClient,
  options: HostedSkillToolOptions = {},
): void {
  const resolveProjectId = options.resolveProjectId ?? explicitProjectId;
  const stdio = options.projectContext === "stdio";

  server.tool(
    "search_skills",
    stdio
      ? "Search the skill catalog configured for the current project before drafting a new skill. Normally provide project context and omit source_id; PIM resolves explicit project_id, PIM_PROJECT_ID, or .pim.json projectId, then uses the stored project mapping or org default. source_id remains an advanced override. Results are advisory reading suggestions, not a conflict verdict: an empty or unavailable result never means the draft is clear."
      : "Search the hosted skill catalog before drafting a new skill. Supply project_id for an explicit project mapping or omit it to use the organization's configured default catalog. source_id is an advanced override. Results are advisory reading suggestions, not a conflict verdict: an empty or unavailable result never means the draft is clear.",
    {
      project_id: ProjectId.optional().describe(
        "Explicit project context. If omitted, configured caller context is used when available; otherwise PIM uses the organization's default catalog.",
      ),
      source_id: SkillSourceId.optional(),
      query: z
        .string()
        .min(1)
        .max(16_000)
        .describe("Plain-language description of the skill you intend to create"),
      tentative_name: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe("Tentative skill name, used to highlight name collisions"),
      target_namespace: SkillNamespace.optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Maximum results; defaults to 5"),
    },
    async ({ project_id, source_id, query, tentative_name, target_namespace, limit }) => {
      const projectId = resolveProjectId(project_id);
      return json(await apiClient.post("/api/skill-search", {
        ...(projectId !== undefined ? { projectId } : {}),
        ...(source_id !== undefined ? { sourceId: source_id } : {}),
        query,
        ...(tentative_name !== undefined ? { tentativeName: tentative_name } : {}),
        ...(target_namespace !== undefined ? { targetNamespace: target_namespace } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }));
    },
  );

  server.tool(
    "check_skill_conflicts",
    stdio
      ? "Run the required deterministic conflict check on complete final skill Markdown before creation or submission. Normally provide project context plus candidates and omit source_id/base_commit_sha; PIM uses the mapped source's newest ready default-branch snapshot. Keep explicit source_id and base_commit_sha for Mimir pull-request checks, CI, and replay. Deterministic conflicts are the verdict; related skills are advisory only. A response with error='catalog_building' means an explicitly pinned snapshot is still being built; retry shortly. API failures are not a clear verdict."
      : "Run the required deterministic conflict check on complete final skill Markdown before creation or submission. Supply project_id for an explicit project mapping or omit it to use the organization's configured default catalog. Keep source_id and base_commit_sha for advanced CI or replay use. Deterministic conflicts are the verdict; related skills are advisory only. A response with error='catalog_building' is retryable. API failures are never a clear verdict.",
    {
      project_id: ProjectId.optional().describe(
        "Explicit project context. If omitted, configured caller context is used when available; otherwise PIM uses the organization's default catalog.",
      ),
      source_id: SkillSourceId.optional(),
      base_commit_sha: FullGitSha.optional().describe(
        "Advanced exact-snapshot pin for PR checks, CI, or replay. Omit for the selected source's latest ready default-branch snapshot.",
      ),
      candidates: z
        .array(SkillConflictCandidateInputSchema)
        .min(1)
        .max(20)
        .describe("One to 20 final skill candidates; aggregate Markdown is limited to 1 MiB"),
    },
    async ({ project_id, source_id, base_commit_sha, candidates }) => {
      const projectId = resolveProjectId(project_id);
      return json(await apiClient.post("/api/skill-conflicts", {
        ...(projectId !== undefined ? { projectId } : {}),
        ...(source_id !== undefined ? { sourceId: source_id } : {}),
        ...(base_commit_sha !== undefined
          ? { baseCommitSha: base_commit_sha }
          : {}),
        candidates: candidates.map((candidate) => ({
          candidateId: candidate.candidate_id,
          name: candidate.name,
          ...(candidate.description !== undefined
            ? { description: candidate.description }
            : {}),
          proposedPath: candidate.proposed_path,
          targetNamespace: candidate.target_namespace,
          body: candidate.body,
          ...(candidate.replaces_path !== undefined
            ? { replacesPath: candidate.replaces_path }
            : {}),
        })),
      }));
    },
  );
}
