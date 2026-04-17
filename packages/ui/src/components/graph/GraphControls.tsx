import { useEffect } from "react";
import { SearchField, Switch } from "@react-spectrum/s2";
import { style } from "@react-spectrum/s2/style" with { type: "macro" };
import type { KnowledgeQueryFilters, KnowledgeNodeType } from "@council/shared";
import { DEFAULT_ORG_CONFIG } from "@council/shared";
import { useOrgStore } from "../../stores/orgStore";

const controlsContainer = style({
  display: "flex",
  flexDirection: "column",
  gap: 12,
});

const NODE_TYPES: { value: KnowledgeNodeType; label: string }[] = [
  { value: "decision", label: "Decisions" },
  { value: "pattern", label: "Patterns" },
  { value: "anti_pattern", label: "Anti-Patterns" },
  { value: "resolved_conflict", label: "Resolved Conflicts" },
  { value: "scope_insight", label: "Scope Insights" },
];

interface GraphControlsProps {
  filters: KnowledgeQueryFilters;
  onChange: (filters: KnowledgeQueryFilters) => void;
}

export function GraphControls({ filters, onChange }: GraphControlsProps) {
  const orgConfig = useOrgStore((s) => s.orgConfig);
  const loadOrgConfig = useOrgStore((s) => s.loadOrgConfig);

  useEffect(() => {
    void loadOrgConfig();
  }, [loadOrgConfig]);

  const domainScopes = orgConfig?.scopes ?? DEFAULT_ORG_CONFIG.scopes;

  const toggleType = (type: KnowledgeNodeType) => {
    const current = filters.types ?? [];
    const next = current.includes(type)
      ? current.filter((t) => t !== type)
      : [...current, type];
    onChange({ ...filters, types: next.length > 0 ? next : undefined });
  };

  const toggleDomain = (domain: string) => {
    const current = filters.domains ?? [];
    const next = current.includes(domain)
      ? current.filter((d) => d !== domain)
      : [...current, domain];
    onChange({ ...filters, domains: next.length > 0 ? next : undefined });
  };

  return (
    <div className={controlsContainer}>
      <SearchField
        label="Search"
        value={filters.text_search ?? ""}
        onChange={(value) =>
          onChange({ ...filters, text_search: value || undefined })
        }
      />

      <div>
        <div style={{ fontWeight: 600, fontSize: "12px", marginBottom: "4px" }}>Node Types</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
          {NODE_TYPES.map(({ value, label }) => (
            <label key={value} style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "13px", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={!filters.types || filters.types.includes(value)}
                onChange={() => toggleType(value)}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div>
        <div style={{ fontWeight: 600, fontSize: "12px", marginBottom: "4px" }}>Domains</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
          {domainScopes.map((d) => (
            <label key={d.id} style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "13px", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={!filters.domains || filters.domains.includes(d.id)}
                onChange={() => toggleDomain(d.id)}
              />
              {d.label}
            </label>
          ))}
        </div>
      </div>

      <Switch
        isSelected={filters.curated_only ?? false}
        onChange={(val) =>
          onChange({ ...filters, curated_only: val || undefined })
        }
      >
        Curated only
      </Switch>
    </div>
  );
}
