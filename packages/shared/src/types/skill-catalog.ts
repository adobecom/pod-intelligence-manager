export const SKILL_MATCHER_VERSION = "v1";

export type SkillCatalogNamespace = "shared" | `project:${string}`;

/**
 * Canonical skill-name representation used by both catalog ingestion and
 * callers preparing candidates for deterministic validation.
 */
export function normalizeSkillName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[-_ ]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/\.md$/, "")
    .replace(/^-+|-+$/g, "");
}

function stripYamlFrontmatter(content: string): string {
  const lines = content.split("\n");
  if (!/^---[ \t]*$/.test(lines[0] ?? "")) return content;

  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && /^---[ \t]*$/.test(line),
  );
  if (closingIndex < 0) return content;
  return lines.slice(closingIndex + 1).join("\n");
}

/**
 * Normalize Markdown bytes for exact-content comparison.
 *
 * This function deliberately does not redact. Callers must hash the returned
 * value before applying any display/storage redaction so redaction cannot make
 * byte-distinct source files appear identical.
 */
export function normalizeSkillContent(content: string): string {
  const lineNormalized = content.replace(/\r\n?/g, "\n");
  const withoutFrontmatter = stripYamlFrontmatter(lineNormalized);
  return withoutFrontmatter
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n+$/g, "");
}

export interface SkillCatalogLayoutRule {
  glob: string;
  namespace: string;
}

export interface SkillConflictCandidate {
  candidateId: string;
  name: string;
  description?: string;
  proposedPath: string;
  targetNamespace: SkillCatalogNamespace;
  body: string;
  /**
   * Base-revision path replaced by a modified or renamed PR file. The base
   * entry at this path is excluded from self-comparisons. New files omit it.
   */
  replacesPath?: string;
}

export type SkillConflictKind =
  | "exact_path"
  | "same_namespace_name"
  | "exact_content"
  | "candidate_exact_path"
  | "candidate_same_namespace_name"
  | "candidate_exact_content";
