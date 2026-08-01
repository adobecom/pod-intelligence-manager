import { createHash } from "node:crypto";
import { normalizeSkillContent } from "./types/skill-catalog.js";

export {
  SKILL_MATCHER_VERSION,
  normalizeSkillContent,
  normalizeSkillName,
} from "./types/skill-catalog.js";

export type {
  SkillCatalogLayoutRule,
  SkillCatalogNamespace,
  SkillConflictCandidate,
  SkillConflictKind,
} from "./types/skill-catalog.js";

/** Return the v1 SHA-256 identity of normalized, pre-redaction Markdown. */
export function hashNormalizedSkillContent(content: string): string {
  return createHash("sha256").update(normalizeSkillContent(content), "utf8").digest("hex");
}
