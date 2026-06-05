import type { OrgConfig, OrgScopeDefinition, OrgTuning } from "@pim/shared";
import { DEFAULT_ORG_CONFIG, DEFAULT_ORG_TUNING } from "@pim/shared";
import db from "../db/connection.js";
import { ORG_CONFIG_ROW_KEY, ORG_TUNING_ROW_KEY } from "../db/schema.js";

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

function readRow(orgId: string): string | null {
  const row = db
    .prepare("SELECT value_json FROM org_settings WHERE org_id = ? AND key = ?")
    .get(orgId, ORG_CONFIG_ROW_KEY) as { value_json: string } | undefined;
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

export function getOrgConfig(orgId: string): OrgConfig {
  const raw = readRow(orgId);
  if (!raw) {
    return { scopes: [...DEFAULT_ORG_CONFIG.scopes] };
  }
  return safeParseOrgConfig(raw) ?? { scopes: [...DEFAULT_ORG_CONFIG.scopes] };
}

export function setOrgConfig(orgId: string, config: unknown): OrgConfig {
  const normalized = parseAndValidateOrgConfig(config);
  const existing = db
    .prepare("SELECT key FROM org_settings WHERE org_id = ? AND key = ?")
    .get(orgId, ORG_CONFIG_ROW_KEY) as { key: string } | undefined;
  if (existing) {
    db.prepare("UPDATE org_settings SET value_json = ? WHERE org_id = ? AND key = ?").run(
      JSON.stringify(normalized),
      orgId,
      ORG_CONFIG_ROW_KEY,
    );
  } else {
    db.prepare("INSERT INTO org_settings (org_id, key, value_json) VALUES (?, ?, ?)").run(
      orgId,
      ORG_CONFIG_ROW_KEY,
      JSON.stringify(normalized),
    );
  }
  return normalized;
}

export function ensureOrgConfig(orgId: string): void {
  const existing = db
    .prepare("SELECT key FROM org_settings WHERE org_id = ? AND key = ?")
    .get(orgId, ORG_CONFIG_ROW_KEY);
  if (!existing) {
    db.prepare("INSERT INTO org_settings (org_id, key, value_json) VALUES (?, ?, ?)").run(
      orgId,
      ORG_CONFIG_ROW_KEY,
      JSON.stringify(DEFAULT_ORG_CONFIG),
    );
  }
}

export function getOrgScopeIds(orgId: string): Set<string> {
  return new Set(getOrgConfig(orgId).scopes.map((s) => s.id));
}

export function getOrgScopeIdsOrdered(orgId: string): string[] {
  return getOrgConfig(orgId).scopes.map((s) => s.id);
}

// --- OrgTuning: autonomous per-org threshold state ---

const tuningCache = new Map<string, { v: OrgTuning; ts: number }>();
const TUNING_CACHE_TTL_MS = 30_000;

export function getOrgTuning(orgId: string): OrgTuning {
  const cached = tuningCache.get(orgId);
  if (cached && Date.now() - cached.ts < TUNING_CACHE_TTL_MS) return cached.v;
  const row = db
    .prepare("SELECT value_json FROM org_settings WHERE org_id = ? AND key = ?")
    .get(orgId, ORG_TUNING_ROW_KEY) as { value_json: string } | undefined;
  let v: OrgTuning;
  if (row) {
    try {
      const overrides = JSON.parse(row.value_json) as Partial<OrgTuning>;
      v = deepMergeTuning(DEFAULT_ORG_TUNING, overrides);
    } catch {
      v = structuredClone(DEFAULT_ORG_TUNING);
    }
  } else {
    v = structuredClone(DEFAULT_ORG_TUNING);
  }
  tuningCache.set(orgId, { v, ts: Date.now() });
  return v;
}

export function setOrgTuning(orgId: string, tuning: OrgTuning): void {
  // Store only the delta so that un-nudged parameters pick up future default changes
  const delta = computeTuningDelta(tuning);
  const deltaJson = JSON.stringify(delta);

  const exists = db
    .prepare("SELECT key FROM org_settings WHERE org_id = ? AND key = ?")
    .get(orgId, ORG_TUNING_ROW_KEY);
  if (exists) {
    db.prepare("UPDATE org_settings SET value_json = ? WHERE org_id = ? AND key = ?").run(
      deltaJson, orgId, ORG_TUNING_ROW_KEY,
    );
  } else {
    db.prepare("INSERT INTO org_settings (org_id, key, value_json) VALUES (?, ?, ?)").run(
      orgId, ORG_TUNING_ROW_KEY, deltaJson,
    );
  }
  tuningCache.delete(orgId);
}

export function deleteOrgTuning(orgId: string): void {
  db.prepare("DELETE FROM org_settings WHERE org_id = ? AND key = ?").run(orgId, ORG_TUNING_ROW_KEY);
  tuningCache.delete(orgId);
}

function computeTuningDelta(tuning: OrgTuning): Partial<OrgTuning> {
  const delta: Partial<OrgTuning> = {};
  for (const groupKey of Object.keys(DEFAULT_ORG_TUNING) as (keyof OrgTuning)[]) {
    const defaultGroup = DEFAULT_ORG_TUNING[groupKey] as Record<string, number>;
    const currentGroup = tuning[groupKey] as Record<string, number>;
    const groupDelta: Record<string, number> = {};
    for (const field of Object.keys(defaultGroup)) {
      if (Math.abs((currentGroup[field] ?? 0) - defaultGroup[field]) > 1e-9) {
        groupDelta[field] = currentGroup[field];
      }
    }
    if (Object.keys(groupDelta).length > 0) {
      (delta as Record<string, unknown>)[groupKey] = groupDelta;
    }
  }
  return delta;
}

function deepMergeTuning(defaults: OrgTuning, overrides: Partial<OrgTuning>): OrgTuning {
  return {
    pressure:        { ...defaults.pressure,        ...(overrides.pressure        ?? {}) },
    pressureWeights: { ...defaults.pressureWeights, ...(overrides.pressureWeights ?? {}) },
    conflictLic:   { ...defaults.conflictLic,   ...(overrides.conflictLic   ?? {}) },
    graphScoring:    { ...defaults.graphScoring,     ...(overrides.graphScoring    ?? {}) },
    lint:            { ...defaults.lint,             ...(overrides.lint            ?? {}) },
    classifier:      { ...defaults.classifier,       ...(overrides.classifier      ?? {}) },
  };
}
