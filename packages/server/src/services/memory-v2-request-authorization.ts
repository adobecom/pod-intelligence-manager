import type {
  MemoryOperationV2,
  MemoryScopeV2,
  ResourceBindingV2,
  ResourceSelectorV2,
} from "@pim/shared";
import db, { withTransaction } from "../db/connection.js";
import type { MembershipRecord, OrgRecord } from "./orgs.js";
import { findOrgById, getMembership } from "./orgs.js";
import type { MemoryHarnessPrincipalBinding } from "./memory-harness-bindings.js";
import type { MemoryRepositoryBinding } from "./memory-repository-registry.js";
import { resolveMemoryRepository } from "./memory-repository-registry.js";
import {
  requiredMemoryV2Scope,
  type ImplementedMemoryV2Plane,
  type MemoryV2Operation,
} from "./memory-v2-constants.js";
import {
  listMemoryV2ResourceBindings,
  memoryV2RepositoryResourceRowId,
  type MemoryV2Resource,
  type MemoryV2ResourceBinding,
} from "./memory-v2-resources.js";
import type {
  ServiceTokenAuthMetadata,
  ServiceTokenRepositoryBinding,
  ServiceTokenScope,
  VerifiedServiceToken,
} from "./service-tokens.js";

export type MemoryV2AuthorizationErrorCode =
  | "authentication_required"
  | "resource_not_found"
  | "resource_binding_mismatch"
  | "temporarily_unavailable";

export class MemoryV2RequestAuthorizationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: MemoryV2AuthorizationErrorCode,
  ) {
    super(message);
    this.name = "MemoryV2RequestAuthorizationError";
  }
}

export type MemoryV2DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly MemoryV2DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: MemoryV2DeepReadonly<T[Key]> }
      : T;

export type MemoryV2FrozenSourceBinding =
  | {
      readonly kind: "repository";
      readonly repository: Readonly<MemoryRepositoryBinding>;
    }
  | {
      readonly kind: "harness";
      readonly harness: Readonly<MemoryHarnessPrincipalBinding>;
    };

export interface MemoryV2FrozenResourceBinding {
  readonly bindingId: string;
  readonly tokenId: string;
  readonly servicePrincipalId: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly resourceRowId: string;
  readonly operations: readonly MemoryV2Operation[];
  readonly canonicalAliases: readonly string[];
  readonly resource: Readonly<MemoryV2Resource>;
  readonly contract: MemoryV2DeepReadonly<ResourceBindingV2>;
  readonly source: MemoryV2FrozenSourceBinding;
}

/**
 * The complete credential and exact-resource authority proven at request
 * entry. Every nested collection/object is frozen before this value leaves
 * the synchronous verification transaction.
 */
export interface MemoryV2RequestAuthorizationSnapshot {
  readonly kind: "memory_v2_request_authorization";
  readonly tokenId: string;
  readonly servicePrincipalId: string;
  readonly userId: string;
  readonly scopes: readonly ServiceTokenScope[];
  readonly orgId: string;
  readonly projectId?: string;
  readonly podId?: string;
  readonly expiresAt?: string;
  readonly org: Readonly<OrgRecord>;
  readonly membership: Readonly<MembershipRecord>;
  readonly repositoryBindings: readonly Readonly<ServiceTokenRepositoryBinding>[];
  readonly harnessBindings: readonly Readonly<MemoryHarnessPrincipalBinding>[];
  readonly resources: readonly MemoryV2FrozenResourceBinding[];
}

export interface AuthorizedMemoryV2ResourceContext {
  readonly principal: MemoryV2RequestAuthorizationSnapshot;
  readonly operation: MemoryV2Operation;
  readonly canonicalAliases: readonly string[];
  readonly binding: MemoryV2DeepReadonly<ResourceBindingV2>;
  readonly resource: MemoryV2DeepReadonly<MemoryV2Resource>;
  readonly source: MemoryV2DeepReadonly<MemoryV2FrozenSourceBinding>;
}

export type MemoryV2AuthorizationDecision =
  | {
      readonly decision: "allow";
      readonly context: AuthorizedMemoryV2ResourceContext;
    }
  | {
      readonly decision: "deny";
      readonly reason:
        | "principal_unavailable"
        | "project_binding_mismatch"
        | "operation_unavailable"
        | "scope_missing"
        | "resource_binding_mismatch";
    };

function frozenRepository(
  principal: ServiceTokenAuthMetadata,
  binding: MemoryV2ResourceBinding,
): Readonly<MemoryRepositoryBinding> {
  const repository = resolveMemoryRepository(
    principal.orgId,
    binding.projectId,
    binding.resource.canonicalResourceId,
  );
  const authenticated = principal.repositoryBindings.find((candidate) => (
    memoryV2RepositoryResourceRowId(candidate.repositoryRowId) === binding.resourceRowId
  ));
  if (!repository || !authenticated
      || repository.repository_row_id !== authenticated.repositoryRowId
      || repository.repository_id !== authenticated.repositoryId) {
    throw new MemoryV2RequestAuthorizationError(
      "Memory repository authority is temporarily unavailable",
      503,
      "temporarily_unavailable",
    );
  }
  return Object.freeze({ ...repository });
}

function frozenHarness(
  principal: ServiceTokenAuthMetadata,
  binding: MemoryV2ResourceBinding,
): Readonly<MemoryHarnessPrincipalBinding> {
  const source = principal.harnessBindings?.find((candidate) => (
    candidate.servicePrincipalId === principal.servicePrincipalId
    && candidate.orgId === principal.orgId
    && candidate.projectId === binding.projectId
    && candidate.harnessId === binding.resource.canonicalResourceId
  ));
  if (!source) {
    throw new MemoryV2RequestAuthorizationError(
      "Memory harness authority is temporarily unavailable",
      503,
      "temporarily_unavailable",
    );
  }
  return Object.freeze({ ...source });
}

function contractBinding(binding: MemoryV2ResourceBinding): ResourceBindingV2 {
  return Object.freeze({
    resource_row_id: binding.resource.resourceRowId,
    organization_id: binding.resource.orgId,
    project_id: binding.resource.projectId,
    plane: binding.resource.plane,
    resource_type: binding.resource.resourceType,
    canonical_resource_id: binding.resource.canonicalResourceId,
    provider: binding.resource.provider,
    provider_resource_id: binding.resource.providerResourceId,
    display_label: binding.resource.displayLabel,
    permitted_operations: Object.freeze([...binding.operations]) as MemoryOperationV2[],
  });
}

function frozenCanonicalAliases(binding: MemoryV2ResourceBinding): readonly string[] {
  if (binding.resource.plane !== "codebase") return Object.freeze([]);
  const rows = db.prepare(
    `SELECT alias_canonical_resource_id
     FROM memory_v2_resource_aliases
     WHERE resource_row_id = ? AND org_id = ? AND project_id = ?
       AND valid_until IS NULL
     ORDER BY alias_canonical_resource_id`,
  ).all(
    binding.resourceRowId,
    binding.orgId,
    binding.projectId,
  ) as unknown as Array<{ alias_canonical_resource_id: string }>;
  return Object.freeze(rows.map((row) => row.alias_canonical_resource_id));
}

function frozenResourceBinding(
  principal: ServiceTokenAuthMetadata,
  binding: MemoryV2ResourceBinding,
): MemoryV2FrozenResourceBinding {
  const resource = Object.freeze({ ...binding.resource });
  const operations = Object.freeze([...binding.operations]);
  const canonicalAliases = frozenCanonicalAliases(binding);
  const source: MemoryV2FrozenSourceBinding = binding.resource.plane === "codebase"
    ? Object.freeze({
        kind: "repository" as const,
        repository: frozenRepository(principal, binding),
      })
    : Object.freeze({
        kind: "harness" as const,
        harness: frozenHarness(principal, binding),
      });
  return Object.freeze({
    bindingId: binding.bindingId,
    tokenId: binding.tokenId,
    servicePrincipalId: binding.servicePrincipalId,
    orgId: binding.orgId,
    projectId: binding.projectId,
    resourceRowId: binding.resourceRowId,
    operations,
    canonicalAliases,
    resource,
    contract: contractBinding(binding),
    source,
  });
}

function buildMemoryV2RequestAuthorizationSnapshot(
  verified: VerifiedServiceToken,
): MemoryV2RequestAuthorizationSnapshot {
  const principal = verified.auth;
  const org = findOrgById(principal.orgId);
  if (!org) {
    throw new MemoryV2RequestAuthorizationError(
      "Organization is unavailable",
      404,
      "resource_not_found",
    );
  }
  const membership = getMembership(principal.orgId, verified.user.user_id);
  if (!membership) {
    throw new MemoryV2RequestAuthorizationError(
      "Service principal is not a member of the authenticated organization",
      403,
      "resource_binding_mismatch",
    );
  }

  let currentBindings: MemoryV2ResourceBinding[] = [];
  if (principal.projectId && !principal.podId) {
    try {
      currentBindings = listMemoryV2ResourceBindings({
        tokenId: principal.tokenId,
        servicePrincipalId: principal.servicePrincipalId,
        orgId: principal.orgId,
        projectId: principal.projectId,
      });
    } catch {
      throw new MemoryV2RequestAuthorizationError(
        "Memory resource binding store is temporarily unavailable",
        503,
        "temporarily_unavailable",
      );
    }
  }

  const scopes = Object.freeze([...principal.scopes]);
  const repositoryBindings = Object.freeze(principal.repositoryBindings.map((binding) => (
    Object.freeze({ ...binding })
  )));
  const harnessBindings = Object.freeze((principal.harnessBindings ?? []).map((binding) => (
    Object.freeze({ ...binding })
  )));
  const resources = Object.freeze(currentBindings.map((binding) => (
    frozenResourceBinding(principal, binding)
  )));
  return Object.freeze({
    kind: "memory_v2_request_authorization" as const,
    tokenId: principal.tokenId,
    servicePrincipalId: principal.servicePrincipalId,
    userId: verified.user.user_id,
    scopes,
    orgId: principal.orgId,
    ...(principal.projectId ? { projectId: principal.projectId } : {}),
    ...(principal.podId ? { podId: principal.podId } : {}),
    ...(principal.expiresAt ? { expiresAt: principal.expiresAt } : {}),
    org: Object.freeze({ ...org }),
    membership: Object.freeze({ ...membership }),
    repositoryBindings,
    harnessBindings,
    resources,
  });
}

/**
 * Runs credential proof plus snapshot construction inside one short,
 * synchronous transaction. The transaction ends before request parsing,
 * provider access, or any business-core work begins.
 */
export function verifyAndSnapshotMemoryV2Request(
  verify: () => VerifiedServiceToken | null,
): MemoryV2RequestAuthorizationSnapshot | null {
  return withTransaction(() => {
    const verified = verify();
    return verified ? buildMemoryV2RequestAuthorizationSnapshot(verified) : null;
  });
}

/** Builds a frozen snapshot for an already-verified test/internal principal. */
export function snapshotVerifiedMemoryV2Principal(
  verified: VerifiedServiceToken,
): MemoryV2RequestAuthorizationSnapshot {
  return withTransaction(() => buildMemoryV2RequestAuthorizationSnapshot(verified));
}

/** Pure exact-resource authorization. This function never reads storage. */
export function authorizeMemoryV2Request(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  operation: MemoryV2Operation;
  plane: ImplementedMemoryV2Plane;
  orgId: string;
  projectId: string;
  resourceRowId: string;
}): MemoryV2AuthorizationDecision {
  const principal = input.principal;
  if (!principal) return { decision: "deny", reason: "principal_unavailable" };
  if (principal.orgId !== input.orgId
      || !principal.projectId
      || principal.podId
      || principal.projectId !== input.projectId) {
    return { decision: "deny", reason: "project_binding_mismatch" };
  }
  const requiredScope = requiredMemoryV2Scope(input.plane, input.operation);
  if (!requiredScope) return { decision: "deny", reason: "operation_unavailable" };
  if (!principal.scopes.includes(requiredScope as ServiceTokenScope)) {
    return { decision: "deny", reason: "scope_missing" };
  }
  const resource = principal.resources.find((candidate) => (
    candidate.orgId === input.orgId
    && candidate.projectId === input.projectId
    && candidate.resource.resourceRowId === input.resourceRowId
    && candidate.resource.plane === input.plane
  ));
  if (!resource || !resource.operations.includes(input.operation)) {
    return { decision: "deny", reason: "resource_binding_mismatch" };
  }
  return {
    decision: "allow",
    context: Object.freeze({
      principal,
      operation: input.operation,
      canonicalAliases: resource.canonicalAliases,
      binding: resource.contract,
      resource: resource.resource,
      source: resource.source,
    }),
  };
}

/**
 * Resolve one selector only within the frozen request authority, then perform
 * the operation authorization exactly once. No global resource lookup occurs,
 * so foreign, retired, and unknown selectors are indistinguishable.
 */
export function authorizeSelectedMemoryV2Resource(input: {
  principal: MemoryV2RequestAuthorizationSnapshot | null | undefined;
  operation: MemoryV2Operation;
  plane: ImplementedMemoryV2Plane;
  projectId: string;
  selector: ResourceSelectorV2;
}): MemoryV2AuthorizationDecision {
  const principal = input.principal;
  if (!principal) return { decision: "deny", reason: "principal_unavailable" };
  const matches = principal.resources.filter((candidate) => (
    candidate.projectId === input.projectId
    && candidate.resource.plane === input.plane
    && (input.plane === "codebase"
      ? candidate.resource.resourceType === "repository"
      : candidate.resource.resourceType === "harness")
    && (input.selector === null
      || ("resource_row_id" in input.selector
        ? candidate.resourceRowId === input.selector.resource_row_id
        : candidate.resource.canonicalResourceId === input.selector.canonical_resource_id
          || candidate.canonicalAliases.includes(input.selector.canonical_resource_id)))
  ));
  if (matches.length !== 1) {
    return { decision: "deny", reason: "resource_binding_mismatch" };
  }
  return authorizeMemoryV2Request({
    principal,
    operation: input.operation,
    plane: input.plane,
    orgId: principal.orgId,
    projectId: input.projectId,
    resourceRowId: matches[0]!.resourceRowId,
  });
}

export function memoryV2ContractScopes(
  principal: MemoryV2RequestAuthorizationSnapshot,
  supported: readonly MemoryScopeV2[],
): MemoryScopeV2[] {
  const granted = new Set<string>(principal.scopes);
  return supported.filter((scope) => granted.has(scope));
}
