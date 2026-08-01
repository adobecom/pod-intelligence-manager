import path from "node:path";
import { normalizeSkillName } from "@pim/shared";
import { redactSecrets } from "./secret-scan.js";

interface FrontmatterResult {
  fields: Map<string, string>;
  body: string;
}

export interface ParsedSkillMarkdown {
  normalizedName: string;
  description: string | null;
}

export interface SkillEmbeddingTextOverrides {
  name?: string;
  description?: string;
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function parseFrontmatter(text: string): FrontmatterResult {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (!/^---[ \t]*$/.test(lines[0] ?? "")) {
    return { fields: new Map(), body: normalized };
  }
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && /^---[ \t]*$/.test(line),
  );
  if (closingIndex < 0) return { fields: new Map(), body: normalized };

  const fields = new Map<string, string>();
  const yamlLines = lines.slice(1, closingIndex);
  for (let index = 0; index < yamlLines.length; index += 1) {
    const match = /^([A-Za-z0-9_-]+):(?:[ \t]*(.*))?$/.exec(yamlLines[index] ?? "");
    if (!match) continue;
    const key = match[1].toLowerCase();
    const rawValue = match[2] ?? "";
    if (/^[>|][+-]?$/.test(rawValue.trim())) {
      const folded = rawValue.trim().startsWith(">");
      const block: string[] = [];
      while (index + 1 < yamlLines.length) {
        const next = yamlLines[index + 1] ?? "";
        if (next && !/^[ \t]/.test(next)) break;
        index += 1;
        block.push(next.replace(/^[ \t]+/, ""));
      }
      fields.set(
        key,
        folded
          ? block.map((line) => line.trim()).filter(Boolean).join(" ")
          : block.join("\n").trim(),
      );
      continue;
    }
    fields.set(key, unquoteYamlScalar(rawValue));
  }

  return {
    fields,
    body: lines.slice(closingIndex + 1).join("\n"),
  };
}

function headingText(body: string): string {
  const heading = body
    .split("\n")
    .find((line) => /^#\s+/.test(line));
  return heading?.replace(/^#\s+/, "").replace(/\s+#+\s*$/, "").trim() ?? "";
}

function firstParagraph(body: string): string {
  const lines = body.split("\n");
  const paragraph: string[] = [];
  let inFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!trimmed) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (
      /^#{1,6}\s/.test(trimmed) ||
      trimmed.startsWith("<!--") ||
      trimmed.startsWith(">") ||
      /^[-*_]{3,}$/.test(trimmed)
    ) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(trimmed);
  }
  return paragraph.join(" ").trim();
}

function secondaryHeadings(body: string): string[] {
  const headings: string[] = [];
  let inFence = false;

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = /^#{2,3}\s+(.+?)\s*$/.exec(trimmed);
    if (!match) continue;
    const text = match[1].replace(/\s+#+\s*$/, "").trim();
    if (text) headings.push(text);
  }

  return headings;
}

export function parseSkillMarkdown(repoPath: string, text: string): ParsedSkillMarkdown {
  const { fields, body } = parseFrontmatter(text);
  const heading = headingText(body);
  const rawName =
    fields.get("name")?.trim() ||
    heading ||
    path.posix.basename(repoPath).replace(/\.md$/i, "");
  const normalizedName = normalizeSkillName(rawName);
  const description =
    fields.get("description")?.trim() ||
    firstParagraph(body) ||
    heading ||
    null;

  return {
    normalizedName,
    description: description?.slice(0, 4_000) ?? null,
  };
}

/**
 * Build the single-vector retrieval text validated by the feasibility spike:
 * normalized name, H1/title, description, then H2/H3 headings.
 *
 * Instructions, examples, and other body paragraphs are intentionally omitted.
 * The returned value is already secret-redacted and is therefore the only form
 * callers should store or send to the embedding provider.
 */
export function buildRedactedSkillEmbeddingText(
  repoPath: string,
  text: string,
  overrides: SkillEmbeddingTextOverrides = {},
): string {
  const parsed = parseSkillMarkdown(repoPath, text);
  const { fields, body } = parseFrontmatter(text);
  const title = headingText(body);
  const overrideName = overrides.name?.trim()
    ? normalizeSkillName(overrides.name)
    : "";
  const overrideDescription = overrides.description?.trim() ?? "";
  const description = (
    overrideDescription ||
    fields.get("description")?.trim() ||
    firstParagraph(body)
  ).slice(0, 4_000);
  const embeddingText = [
    (overrideName || parsed.normalizedName).replace(/-/g, " "),
    title,
    description,
    ...secondaryHeadings(body),
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");

  return redactSecrets(embeddingText).text;
}
