import type { ProjectAnatomy } from "@council/shared";
import { EMPTY_PROJECT_ANATOMY } from "@council/shared";

export function parseProjectAnatomy(raw: string | null | undefined): ProjectAnatomy {
  if (!raw) return { ...EMPTY_PROJECT_ANATOMY, internal: [], external: [] };
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return { ...EMPTY_PROJECT_ANATOMY, internal: [], external: [] };
    const o = v as Record<string, unknown>;
    const internalRaw = Array.isArray(o.internal) ? o.internal : [];
    const externalRaw = Array.isArray(o.external) ? o.external : [];
    const internal = internalRaw
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) => {
        const rec = x as Record<string, unknown>;
        const scopeId = typeof rec.scope_id === "string" ? rec.scope_id.trim() : "";
        const legacyRole = typeof rec.role_id === "string" ? rec.role_id.trim() : "";
        const id = scopeId || legacyRole;
        return id ? { scope_id: id } : null;
      })
      .filter((x): x is { scope_id: string } => x !== null);
    const external = externalRaw
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map(x => {
        const name = typeof x.name === "string" ? x.name.trim() : "";
        const role = typeof x.role === "string" ? x.role.trim() : "";
        const notes = typeof x.notes === "string" ? x.notes.trim() : undefined;
        return { name, role, ...(notes ? { notes } : {}) };
      })
      .filter(x => x.name.length > 0 && x.role.length > 0);
    return { internal, external };
  } catch {
    return { ...EMPTY_PROJECT_ANATOMY, internal: [], external: [] };
  }
}
