import type { MemoryOperationV2 as MemoryOperationV2Contract } from "@pim/shared";

export const MEMORY_V2_PLANES = ["codebase", "harness"] as const;
export type MemoryV2Plane = typeof MEMORY_V2_PLANES[number];

export type ImplementedMemoryV2Plane = MemoryV2Plane;

export type MemoryV2ResourceType = "repository" | "harness";
export type ImplementedMemoryV2ResourceType = MemoryV2ResourceType;

export const MEMORY_V2_HARNESS_SCOPES = [
  "memory:harness:search",
  "memory:harness:receipt:write",
  "memory:harness:candidate:read",
  "memory:harness:review",
] as const;

export const MEMORY_V2_SUBTYPE_KIND = {
  workflow_strategy: "decision",
  failure_pattern: "anti_pattern",
  verification_sequence: "test_strategy",
  tool_constraint: "constraint",
  escalation_requirement: "constraint",
} as const;

export type MemoryV2Subtype = keyof typeof MEMORY_V2_SUBTYPE_KIND;
export type MemoryV2BroadKind = typeof MEMORY_V2_SUBTYPE_KIND[MemoryV2Subtype];

export type MemoryV2Scope =
  | "memory:search"
  | "memory:receipt:write"
  | "memory:candidate:read"
  | "memory:attest"
  | "memory:feedback:write"
  | "memory:review"
  | "memory:admin"
  | typeof MEMORY_V2_HARNESS_SCOPES[number];

export type MemoryV2Operation = MemoryOperationV2Contract;

export interface MemoryV2OperationScopeRule {
  operation: MemoryV2Operation;
  scopeByPlane: Readonly<Record<ImplementedMemoryV2Plane, MemoryV2Scope | null>>;
}

/** The single ordered operation-to-scope authority for runtime and migration projection. */
export const MEMORY_V2_OPERATION_SCOPE_RULES = [
  {
    operation: "search",
    scopeByPlane: { codebase: "memory:search", harness: "memory:harness:search" },
  },
  {
    operation: "detail",
    scopeByPlane: { codebase: "memory:search", harness: "memory:harness:search" },
  },
  {
    operation: "history",
    scopeByPlane: { codebase: "memory:search", harness: "memory:harness:search" },
  },
  {
    operation: "pack",
    scopeByPlane: { codebase: "memory:search", harness: "memory:harness:search" },
  },
  {
    operation: "receipt_write",
    scopeByPlane: {
      codebase: "memory:receipt:write",
      harness: "memory:harness:receipt:write",
    },
  },
  {
    operation: "candidate_read",
    scopeByPlane: {
      codebase: "memory:candidate:read",
      harness: "memory:harness:candidate:read",
    },
  },
  {
    operation: "candidate_write",
    scopeByPlane: {
      codebase: "memory:receipt:write",
      harness: "memory:harness:receipt:write",
    },
  },
  {
    operation: "feedback_write",
    scopeByPlane: { codebase: "memory:feedback:write", harness: null },
  },
  {
    operation: "readiness",
    scopeByPlane: { codebase: "memory:search", harness: "memory:harness:search" },
  },
  {
    operation: "review",
    scopeByPlane: { codebase: "memory:review", harness: "memory:harness:review" },
  },
  {
    operation: "activation",
    scopeByPlane: { codebase: "memory:review", harness: "memory:harness:review" },
  },
  {
    operation: "runtime_attestation_write",
    // Harness runtime evidence is receipt-carried and shares the exact receipt-write scope.
    scopeByPlane: {
      codebase: "memory:attest",
      harness: "memory:harness:receipt:write",
    },
  },
] as const satisfies readonly MemoryV2OperationScopeRule[];

export const MEMORY_V2_OPERATIONS: readonly MemoryV2Operation[] =
  MEMORY_V2_OPERATION_SCOPE_RULES.map((rule) => rule.operation);

export class MemoryV2SubtypeMappingError extends Error {
  readonly code = "schema_invalid";
  readonly statusCode = 422;

  constructor(subtype: string) {
    super(`Memory v2 subtype is not mapped: ${subtype}`);
    this.name = "MemoryV2SubtypeMappingError";
  }
}

export function memoryV2KindForSubtype(subtype: string): MemoryV2BroadKind | null {
  return Object.prototype.hasOwnProperty.call(MEMORY_V2_SUBTYPE_KIND, subtype)
    ? MEMORY_V2_SUBTYPE_KIND[subtype as MemoryV2Subtype]
    : null;
}

export function requireMemoryV2KindForSubtype(subtype: string): MemoryV2BroadKind {
  const kind = memoryV2KindForSubtype(subtype);
  if (!kind) throw new MemoryV2SubtypeMappingError(subtype);
  return kind;
}

/** A v1 broad kind has a lossless inverse only when exactly one v2 subtype maps to it. */
export function losslessMemoryV2SubtypeForLegacyKind(
  kind: MemoryV2BroadKind,
): MemoryV2Subtype | null {
  const matches = Object.entries(MEMORY_V2_SUBTYPE_KIND)
    .filter(([, mapped]) => mapped === kind)
    .map(([subtype]) => subtype as MemoryV2Subtype);
  return matches.length === 1 ? matches[0]! : null;
}

export function requiredMemoryV2Scope(
  plane: ImplementedMemoryV2Plane,
  operation: MemoryV2Operation,
): MemoryV2Scope | null {
  return MEMORY_V2_OPERATION_SCOPE_RULES
    .find((rule) => rule.operation === operation)
    ?.scopeByPlane[plane] ?? null;
}

/** Canonical scope-to-operation projector for migration parity and every runtime binding writer. */
export function memoryV2OperationsForScopes(
  plane: ImplementedMemoryV2Plane,
  scopes: readonly string[],
): MemoryV2Operation[] {
  const present = new Set(scopes);
  return MEMORY_V2_OPERATION_SCOPE_RULES
    .filter((rule) => {
      const required = rule.scopeByPlane[plane];
      return required !== null && present.has(required);
    })
    .map((rule) => rule.operation);
}
