import { randomUUID } from "node:crypto";

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Six lowercase hex characters derived from a UUID (same style as ctx-/pcu- ids elsewhere). */
export function randomSuffix6(): string {
  return randomUUID().replace(/-/g, "").slice(0, 6);
}

/**
 * Human-readable prefix + slug + short uid so repeated names and slug collisions get distinct ids.
 */
export function allocateUniqueResourceId(
  prefix: "pod" | "project",
  displayName: string,
  isTaken: (id: string) => boolean,
): string {
  const base = slugify(displayName) || "unnamed";
  const maxAttempts = 16;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const id = `${prefix}-${base}-${randomSuffix6()}`;
    if (!isTaken(id)) return id;
  }
  throw new Error(`Failed to allocate unique ${prefix} id after ${maxAttempts} attempts`);
}
