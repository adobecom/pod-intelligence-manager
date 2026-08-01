import type { SkillCatalogLayoutRule, SkillCatalogNamespace } from "@pim/shared";

const NAMESPACE_RE = /^project:[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/;

export class SkillCatalogLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillCatalogLayoutError";
  }
}

interface CompiledGlob {
  glob: string;
  regex: RegExp;
  wildcardCount: number;
}

export interface CompiledLayoutRule extends CompiledGlob {
  namespace: string;
}

export interface CompiledSkillLayout {
  rules: CompiledLayoutRule[];
  excludes: CompiledGlob[];
}

export function isSkillCatalogNamespace(value: string): value is SkillCatalogNamespace {
  return value === "shared" || NAMESPACE_RE.test(value);
}

export function normalizeCatalogPath(value: string): string {
  const path = value.trim();
  if (
    !path ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new SkillCatalogLayoutError(`Invalid repository path: ${value}`);
  }
  return path;
}

function escapeRegexCharacter(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

function compileGlob(globValue: string): CompiledGlob {
  const glob = normalizeCatalogPath(globValue);
  let source = "^";
  let wildcardCount = 0;

  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      wildcardCount += 1;
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          source += "(?:(.*)/)?";
          index += 1;
        } else {
          source += "(.*)";
        }
      } else {
        source += "([^/]*)";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegexCharacter(char);
  }

  return { glob, regex: new RegExp(`${source}$`), wildcardCount };
}

function validateNamespaceTemplate(template: string, wildcardCount: number): void {
  if (!template || template.length > 160) {
    throw new SkillCatalogLayoutError("Layout-rule namespace must be 1-160 characters");
  }
  const placeholders = [...template.matchAll(/\{(\d+)\}/g)];
  for (const match of placeholders) {
    const capture = Number(match[1]);
    if (!Number.isInteger(capture) || capture < 1 || capture > wildcardCount) {
      throw new SkillCatalogLayoutError(
        `Namespace placeholder {${match[1]}} has no matching wildcard`,
      );
    }
  }
  const sample = template.replace(/\{\d+\}/g, "sample");
  if (!isSkillCatalogNamespace(sample)) {
    throw new SkillCatalogLayoutError(
      `Namespace template must resolve to "shared" or "project:<id>": ${template}`,
    );
  }
}

export function compileSkillLayout(
  layoutRules: SkillCatalogLayoutRule[],
  excludeGlobs: string[] = [],
): CompiledSkillLayout {
  if (layoutRules.length === 0) {
    throw new SkillCatalogLayoutError("At least one layout rule is required");
  }

  const rules = layoutRules.map((rule) => {
    const compiled = compileGlob(rule.glob);
    validateNamespaceTemplate(rule.namespace, compiled.wildcardCount);
    return { ...compiled, namespace: rule.namespace };
  });
  const excludes = excludeGlobs.map(compileGlob);
  return { rules, excludes };
}

function renderNamespace(template: string, captures: string[]): SkillCatalogNamespace | null {
  const namespace = template.replace(/\{(\d+)\}/g, (_match, index: string) => {
    return captures[Number(index) - 1] ?? "";
  });
  return isSkillCatalogNamespace(namespace) ? namespace : null;
}

export function deriveSkillNamespace(
  pathValue: string,
  layout: CompiledSkillLayout,
): SkillCatalogNamespace | null {
  const path = normalizeCatalogPath(pathValue);
  if (layout.excludes.some((exclude) => exclude.regex.test(path))) return null;

  for (const rule of layout.rules) {
    const match = rule.regex.exec(path);
    if (!match) continue;
    return renderNamespace(rule.namespace, match.slice(1));
  }
  return null;
}

