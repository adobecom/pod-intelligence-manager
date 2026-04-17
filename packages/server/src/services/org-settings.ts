import type { OrgConfig, OrgScopeDefinition } from "@council/shared";
import { DEFAULT_ORG_CONFIG } from "@council/shared";
import db from "../db/connection.js";
import { ORG_CONFIG_ROW_KEY } from "../db/schema.js";

function normalizeScopes(rows: OrgScopeDefinition[], label: string): OrgScopeDefinition[] {
  const seen = new Set<string>();
  const out: OrgScopeDefinition[] = [];
  for (const row of rows) {
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const lbl = typeof row.label === "string" ? row.label.trim() : "";
    if (!id || !lbl) {
      throw new Error(`${label}: each entry needs non-empty id and label`);
    }
    if (seen.has(id)) {
      throw new Error(`${label}: duplicate id "${id}"`);
    }
    seen.add(id);
    out.push({ id, label: lbl });
  }
  return out;
}

/**
 * Validate PATCH/PUT body: `{ scopes }` only.
 * Legacy payloads with `roles` (same shape as scopes) are accepted only if `scopes` is missing or empty —
 * then `roles` is treated as the scope list for migration.
 */
export function parseAndValidateOrgConfig(input: unknown): OrgConfig {
  if (!input || typeof input !== "object") {
    throw new Error("Body must be an object with a scopes array");
  }
  const o = input as Record<string, unknown>;
  let source: unknown = o.scopes;
  if (!Array.isArray(source) || source.length < 1) {
    if (Array.isArray(o.roles) && o.roles.length >= 1) {
      source = o.roles;
    }
  }
  if (!Array.isArray(source)) {
    throw new Error("scopes must be a non-empty array");
  }
  const scopes = normalizeScopes(source as OrgScopeDefinition[], "scopes");
  if (scopes.length < 1) {
    throw new Error("At least one scope is required");
  }
  return { scopes };
}

function readRow(): string | null {
  const row = db.prepare("SELECT value_json FROM org_settings WHERE key = ?").get(ORG_CONFIG_ROW_KEY) as
    | { value_json: string }
    | undefined;
  return row?.value_json ?? null;
}

function safeParseOrgConfig(json: string): OrgConfig | null {
  try {
    const v = JSON.parse(json) as unknown;
    return parseAndValidateOrgConfig(v);
  } catch {
    return null;
  }
}

export function getOrgConfig(): OrgConfig {
  const raw = readRow();
  if (!raw) {
    return { scopes: [...DEFAULT_ORG_CONFIG.scopes] };
  }
  const parsed = safeParseOrgConfig(raw);
  if (parsed) {
    return parsed;
  }
  return { scopes: [...DEFAULT_ORG_CONFIG.scopes] };
}

export function setOrgConfig(config: unknown): OrgConfig {
  const normalized = parseAndValidateOrgConfig(config);
  const existing = db.prepare("SELECT key FROM org_settings WHERE key = ?").get(ORG_CONFIG_ROW_KEY) as
    | { key: string }
    | undefined;
  if (existing) {
    db.prepare("UPDATE org_settings SET value_json = ? WHERE key = ?").run(JSON.stringify(normalized), ORG_CONFIG_ROW_KEY);
  } else {
    db.prepare("INSERT INTO org_settings (key, value_json) VALUES (?, ?)").run(ORG_CONFIG_ROW_KEY, JSON.stringify(normalized));
  }
  return normalized;
}

export function getOrgScopeIds(): Set<string> {
  return new Set(getOrgConfig().scopes.map(s => s.id));
}

export function getOrgScopeIdsOrdered(): string[] {
  return getOrgConfig().scopes.map(s => s.id);
}
