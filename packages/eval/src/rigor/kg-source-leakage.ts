export type KgLeakageSeverity = "error" | "warning";

export interface KgLeakageFinding {
  severity: KgLeakageSeverity;
  code: string;
  message: string;
  path?: string;
  token?: string;
}

export interface KgSourceFileEntry {
  path: string;
  bytes?: number;
  sha256?: string;
}

export interface KgSourceManifestLike {
  kind?: string;
  claimability?: string;
  files?: KgSourceFileEntry[];
  policy?: {
    includeRoots?: string[];
    excludeRoots?: string[];
    deniedPathPrefixes?: string[];
    deniedPathSubstrings?: string[];
    deniedTextTokens?: string[];
    warningTextTokens?: string[];
  };
}

export interface KgCandidateLike {
  source_label?: string;
  source_url?: string;
  source_kind?: string;
  summary?: string;
  details?: string;
  changed_files?: string[];
  path?: string;
  content?: string;
  body?: string;
  title?: string;
}

export const CLAIMABLE_KG_INCLUDE_ROOTS = [
  "packages/server/",
  "packages/shared/",
  "packages/sdk/",
  "packages/ui/",
  "packages/cli/",
  "packages/mcp-server/",
  "prompts/",
] as const;

export const CLAIMABLE_KG_EXCLUDE_ROOTS = [
  "packages/eval/",
  ".scout/",
  ".codex/",
  ".agents/",
] as const;

export const CLAIMABLE_KG_DENIED_PATH_PREFIXES = [
  "packages/eval/",
  "packages/eval/runs/",
  "packages/eval/fixtures/",
  "packages/eval/src/tasks/",
] as const;

export const CLAIMABLE_KG_DENIED_PATH_SUBSTRINGS = [
  "/packages/eval/",
  "/fixtures/lic/",
  "/fixtures/session-contexts/",
  "/runs/kg-future",
  "kg-future",
  "future-emc-",
] as const;

export const CLAIMABLE_KG_DENIED_TEXT_TOKENS = [
  "packages/eval/",
  "future-emc-",
  "kg-future",
  "kgExpectations",
  "groundTruth",
  "LIC fixture",
  "show_confirmation",
  "kg-only failed",
  "expected waitlist/blocked",
] as const;

export const CLAIMABLE_KG_WARNING_TEXT_TOKENS = [
  "rubric",
  "expected output",
  "pass rate",
  "harness",
] as const;

export function normalizeKgSourcePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");
}

export function isUnderAnyRoot(path: string, roots: readonly string[]): boolean {
  const normalized = normalizeKgSourcePath(path);
  return roots.some((root) => {
    const normalizedRoot = normalizeKgSourcePath(root);
    if (normalizedRoot.endsWith("/")) return normalized.startsWith(normalizedRoot);
    return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
  });
}

export function isClaimableKgSourcePath(path: string, includeRoots: readonly string[] = CLAIMABLE_KG_INCLUDE_ROOTS): boolean {
  return isUnderAnyRoot(path, includeRoots) && deniedKgSourcePathReason(path) === null;
}

export function deniedKgSourcePathReason(
  path: string,
  options?: {
    deniedPathPrefixes?: readonly string[];
    deniedPathSubstrings?: readonly string[];
    excludeRoots?: readonly string[];
  },
): string | null {
  const normalized = normalizeKgSourcePath(path);
  const deniedPrefixes = options?.deniedPathPrefixes ?? CLAIMABLE_KG_DENIED_PATH_PREFIXES;
  const deniedSubstrings = options?.deniedPathSubstrings ?? CLAIMABLE_KG_DENIED_PATH_SUBSTRINGS;
  const excludeRoots = options?.excludeRoots ?? CLAIMABLE_KG_EXCLUDE_ROOTS;

  const excludedRoot = excludeRoots.find((root) => isUnderAnyRoot(normalized, [root]));
  if (excludedRoot) return `path is under excluded root ${excludedRoot}`;

  const deniedPrefix = deniedPrefixes.find((prefix) => normalized.startsWith(normalizeKgSourcePath(prefix)));
  if (deniedPrefix) return `path is under denied prefix ${deniedPrefix}`;

  const lower = normalized.toLowerCase();
  const deniedSubstring = deniedSubstrings.find((fragment) => lower.includes(fragment.toLowerCase()));
  if (deniedSubstring) return `path contains denied fragment ${deniedSubstring}`;

  return null;
}

export function validateKgSourceFiles(
  files: Iterable<KgSourceFileEntry | string>,
  options?: {
    includeRoots?: readonly string[];
    excludeRoots?: readonly string[];
    deniedPathPrefixes?: readonly string[];
    deniedPathSubstrings?: readonly string[];
  },
): KgLeakageFinding[] {
  const findings: KgLeakageFinding[] = [];
  const includeRoots = options?.includeRoots ?? CLAIMABLE_KG_INCLUDE_ROOTS;
  for (const file of files) {
    const path = typeof file === "string" ? file : file.path;
    const normalized = normalizeKgSourcePath(path);
    const deniedReason = deniedKgSourcePathReason(normalized, options);
    if (deniedReason) {
      findings.push({
        severity: "error",
        code: "kg-source-denied-path",
        path: normalized,
        message: deniedReason,
      });
      continue;
    }
    if (!isUnderAnyRoot(normalized, includeRoots)) {
      findings.push({
        severity: "warning",
        code: "kg-source-outside-allowlist",
        path: normalized,
        message: `path is outside claimable include roots: ${includeRoots.join(", ")}`,
      });
    }
  }
  return findings;
}

export function validateKgSourceManifestObject(manifest: KgSourceManifestLike): KgLeakageFinding[] {
  const policy = manifest.policy ?? {};
  const findings = validateKgSourceFiles(manifest.files ?? [], {
    includeRoots: policy.includeRoots ?? CLAIMABLE_KG_INCLUDE_ROOTS,
    excludeRoots: policy.excludeRoots ?? CLAIMABLE_KG_EXCLUDE_ROOTS,
    deniedPathPrefixes: policy.deniedPathPrefixes ?? CLAIMABLE_KG_DENIED_PATH_PREFIXES,
    deniedPathSubstrings: policy.deniedPathSubstrings ?? CLAIMABLE_KG_DENIED_PATH_SUBSTRINGS,
  });

  if (manifest.claimability && manifest.claimability !== "claimable") {
    findings.push({
      severity: "warning",
      code: "kg-source-diagnostic-manifest",
      message: `manifest claimability is ${manifest.claimability}, not claimable`,
    });
  }

  return findings;
}

export function validateKgCandidatePayload(
  candidate: KgCandidateLike,
  options?: {
    deniedTextTokens?: readonly string[];
    warningTextTokens?: readonly string[];
  },
): KgLeakageFinding[] {
  const findings: KgLeakageFinding[] = [];

  for (const path of candidate.changed_files ?? []) {
    const reason = deniedKgSourcePathReason(path);
    if (reason) {
      findings.push({
        severity: "error",
        code: "kg-candidate-denied-path",
        path: normalizeKgSourcePath(path),
        message: reason,
      });
    }
  }

  if (candidate.path) {
    const reason = deniedKgSourcePathReason(candidate.path);
    if (reason) {
      findings.push({
        severity: "error",
        code: "kg-candidate-denied-path",
        path: normalizeKgSourcePath(candidate.path),
        message: reason,
      });
    }
  }

  const text = [
    candidate.source_label,
    candidate.source_url,
    candidate.summary,
    candidate.details,
    candidate.content,
    candidate.body,
    candidate.title,
  ]
    .filter((part): part is string => typeof part === "string")
    .join("\n");

  findings.push(
    ...findDeniedTextTokens(
      text,
      options?.deniedTextTokens ?? CLAIMABLE_KG_DENIED_TEXT_TOKENS,
    ).map((token) => ({
      severity: "error" as const,
      code: "kg-candidate-denied-token",
      token,
      message: `candidate text contains denied eval-leakage token ${token}`,
    })),
  );

  findings.push(
    ...findDeniedTextTokens(
      text,
      options?.warningTextTokens ?? CLAIMABLE_KG_WARNING_TEXT_TOKENS,
    ).map((token) => ({
      severity: "warning" as const,
      code: "kg-candidate-suspicious-token",
      token,
      message: `candidate text contains suspicious benchmark token ${token}`,
    })),
  );

  return findings;
}

export function findDeniedTextTokens(text: string, tokens: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return tokens.filter((token) => lower.includes(token.toLowerCase()));
}

export function hasKgLeakageErrors(findings: readonly KgLeakageFinding[]): boolean {
  return findings.some((finding) => finding.severity === "error");
}

export function formatKgLeakageFindings(findings: readonly KgLeakageFinding[]): string {
  if (findings.length === 0) return "no KG source leakage findings";
  return findings
    .map((finding) => {
      const location = finding.path ? ` path=${finding.path}` : finding.token ? ` token=${finding.token}` : "";
      return `[${finding.severity}] ${finding.code}${location}: ${finding.message}`;
    })
    .join("\n");
}
