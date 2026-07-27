export interface SkillCatalogGitSource {
  apiBaseUrl: string;
  owner: string;
  repo: string;
  credentialAlias: string;
}

export interface ResolvedGitCommit {
  commitSha: string;
  treeSha: string;
}

export interface SkillCatalogTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit" | string;
  sha: string;
  size?: number;
}

export interface SkillCatalogGitClient {
  resolveCommit(ref: string): Promise<ResolvedGitCommit>;
  getRecursiveTree(treeSha: string): Promise<SkillCatalogTreeEntry[]>;
  getBlob(blobSha: string): Promise<string>;
}

export type SkillCatalogGitClientFactory = (
  source: SkillCatalogGitSource,
) => SkillCatalogGitClient;

export class SkillCatalogGitError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "SkillCatalogGitError";
  }
}

interface GitHubCommitResponse {
  sha?: string;
  commit?: { tree?: { sha?: string } };
}

interface GitHubTreeResponse {
  truncated?: boolean;
  tree?: SkillCatalogTreeEntry[];
}

interface GitHubBlobResponse {
  encoding?: string;
  content?: string;
}

const REQUEST_TIMEOUT_MS = 20_000;

class GitHubSkillCatalogClient implements SkillCatalogGitClient {
  private readonly repoBaseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(source: SkillCatalogGitSource) {
    const token = process.env[source.credentialAlias]?.trim();
    if (!token) {
      throw new SkillCatalogGitError(
        `Credential alias ${source.credentialAlias} is not configured`,
      );
    }
    const base = source.apiBaseUrl.replace(/\/+$/, "");
    this.repoBaseUrl = `${base}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`;
    this.headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  private async requestJson<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.repoBaseUrl}${path}`, {
        headers: this.headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => ""))
          .replace(/\s+/g, " ")
          .slice(0, 300);
        throw new SkillCatalogGitError(
          `Git API request failed (${response.status})${detail ? `: ${detail}` : ""}`,
          response.status,
        );
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof SkillCatalogGitError) throw error;
      const message =
        error instanceof Error && error.name === "AbortError"
          ? "Git API request timed out"
          : `Git API request failed: ${error instanceof Error ? error.message : String(error)}`;
      throw new SkillCatalogGitError(message);
    } finally {
      clearTimeout(timer);
    }
  }

  async resolveCommit(ref: string): Promise<ResolvedGitCommit> {
    const response = await this.requestJson<GitHubCommitResponse>(
      `/commits/${encodeURIComponent(ref)}`,
    );
    const commitSha = response.sha;
    const treeSha = response.commit?.tree?.sha;
    if (!commitSha || !treeSha) {
      throw new SkillCatalogGitError("Git API commit response omitted its SHA or tree SHA");
    }
    return { commitSha, treeSha };
  }

  async getRecursiveTree(treeSha: string): Promise<SkillCatalogTreeEntry[]> {
    const response = await this.requestJson<GitHubTreeResponse>(
      `/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
    );
    if (response.truncated) {
      throw new SkillCatalogGitError(
        "Git API recursive tree response was truncated; catalog snapshot is incomplete",
      );
    }
    if (!Array.isArray(response.tree)) {
      throw new SkillCatalogGitError("Git API tree response omitted entries");
    }
    return response.tree;
  }

  async getBlob(blobSha: string): Promise<string> {
    const response = await this.requestJson<GitHubBlobResponse>(
      `/git/blobs/${encodeURIComponent(blobSha)}`,
    );
    if (response.encoding !== "base64" || typeof response.content !== "string") {
      throw new SkillCatalogGitError("Git API blob response was not base64 encoded");
    }
    return Buffer.from(response.content.replace(/\s+/g, ""), "base64").toString("utf8");
  }
}

export const createGitHubSkillCatalogClient: SkillCatalogGitClientFactory = (source) =>
  new GitHubSkillCatalogClient(source);

