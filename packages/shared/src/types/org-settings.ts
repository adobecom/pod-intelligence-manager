/** Single workstream / context-update scope (id is stable; label is UI). Also used for project anatomy internal slots. */
export interface OrgScopeDefinition {
  id: string;
  label: string;
}

/** Persisted org-level configuration (single-tenant: one row per deployment). */
export interface OrgConfig {
  scopes: OrgScopeDefinition[];
}

const LEGACY_SCOPES: OrgScopeDefinition[] = [
  { id: "frontend", label: "Frontend" },
  { id: "backend", label: "Backend" },
  { id: "design", label: "Design" },
  { id: "qa", label: "QA" },
  { id: "infra", label: "Infra" },
  { id: "pm", label: "PM" },
];

/** Default six scopes (legacy behavior). */
export const DEFAULT_ORG_CONFIG: OrgConfig = {
  scopes: LEGACY_SCOPES.map(s => ({ ...s })),
};
