# MCP-A decision: private PIM service-token profile

**Status:** Slice 4 production issuer and restricted data-plane MCP surface enabled

## Decision

The dedicated PIM Memory MCP endpoint uses a deliberately private PIM service-token profile, not
the MCP OAuth client-credentials extension. The existing opaque `pim_svc_...` credential and
constant-time verifier already establish token identity, expiry/revocation, service principal,
organization, project, exact scopes, and existing resource bindings. MCP-A therefore did not
discover a new identity provider or credential-format project.

This is not an inference from a token's scopes. A token is MCP-eligible only when its verified
token id has an immutable companion row in `memory_v2_service_token_mcp_profiles` containing all of
these exact values:

| Field | Fixed value |
|---|---|
| `authentication_profile` | `private_pim_service_token` |
| `audience` | `urn:pim:audience:mcp-memory` |
| `resource_indicator` | `urn:pim:resource:mcp-memory` |
| `endpoint_path` | `/mcp/memory` |

The row is one-to-one with `service_tokens`, is deleted when its token is deleted, and cannot be
updated. Existing tokens have no row and remain ineligible; the migration does not backfill,
widen, or otherwise change their authority.

## Issuance posture

Ordinary calls to `POST /api/org/service-tokens` use `createServiceToken` and never create an MCP
profile. An org admin or owner must explicitly request
`authentication_profile: "private_pim_service_token"`; that request uses
`createPrivateMemoryMcpServiceToken`, which:

- is available in production through the authenticated org-admin route;
- requires one exact project binding, forbids pod binding, and requires at least one exact
  registered repository or harness binding;
- accepts only safe memory data-plane scopes;
- creates the token, legacy exact bindings, v2 binding companions, and profile in one transaction;
- returns the raw credential only in the private, non-cacheable creation response. Subsequent list
  and revoke operations never return it.

The allowed profile scopes are `memory:search`, `memory:receipt:write`,
`memory:candidate:read`, `memory:feedback:write`, `memory:harness:search`,
`memory:harness:receipt:write`, and `memory:harness:candidate:read`. Review, administration,
attestation adjudication, activation, exposure/release policy, kill-switch, hosted-skill, project,
and other non-memory scopes make a credential ineligible. A safe scope never substitutes for a
different scope.

Omitting `authentication_profile` deliberately creates an ordinary non-MCP service token, even if
the request includes memory scopes and exact memory resources. Existing credentials are never
upgraded or backfilled into this profile.

## Per-request verification

`POST /mcp/memory` performs one v2-only verification-and-snapshot phase for every stateless
request, in a short synchronous transaction before tool dispatch. That phase:

1. Parses one strict Bearer credential and proves the canonical PIM service token, including its
   expiry and revocation state, enabled service principal, and service user.
2. Looks up the immutable MCP profile by verified token id, compares all four fixed values, and
   rejects every scope outside the safe data-plane allowlist.
3. Proves the token's exact organization and project with no pod binding, the service principal's
   current organization membership, and its current exact v2 resource bindings matching token,
   principal, organization, and project.
4. After that credential/profile proof succeeds, captures the effective credential identity,
   tenant, membership, scope, and exact-resource authority in one deep-frozen request
   authorization snapshot and uses it as the application authority during dispatch.

Application and tool execution authorize against the snapshot with pure in-memory checks. They do
not recheck expiry, revocation, disabled-principal state, membership, profile, or resource bindings
mid-request. A revocation or other authority change after the snapshot is created takes effect on
the next request; it does not cancel work already admitted by the current request. Client input can
narrow snapshot authority, but cannot supply or replace tenant, project, credential, or resource
authority.

Audience and resource are thus cryptographically tied to the verified opaque token through its
token-id companion row. They are not caller headers, tool arguments, scope conventions, or values
deduced from a repository or harness binding.

## Transport and application boundary

The endpoint uses the split `@modelcontextprotocol/server` SDK and only the stateless 2026-07-28
request model. It is POST-only, rejects legacy initialization/session traffic, requires
`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, and modern client `_meta`, rejects unknown fields,
has a 512 KiB body limit and route-specific rate limit, and returns `private, no-store` with
`Vary: Authorization`. It creates no loopback HTTP request, forwards no Bearer token, and exposes no
session id, SSE route, credential argument, broad interactive catalog, or memory resource URI in
Slice 1.

Authorized discovery contains the eight published safe tools:
`pim_memory_capabilities`, `pim_memory_binding`, `pim_code_memory_search`,
`pim_run_receipt_submit`, `pim_feedback_submit`, `pim_candidate_status`,
`pim_harness_memory_search`, and `pim_memory_readiness`. The restricted surface also publishes the
record-version and retrieval-pack resource templates. Discovery remains filtered to the current
principal's exact scopes and resources; review, activation, and standalone runtime-attestation
mutation are not MCP operations.

HTTP `GET /api/v2/memory/binding` and MCP `pim_memory_binding` both project the same deep-frozen
request authorization snapshot. The projection returns only the principal id, tenant, effective
memory scopes, and exact request-start resources/operations. It does not return the raw token,
token id, profile row, internal binding id, or any resource outside the authenticated principal.

## Logging, audit, and metrics

Authorization and request-body logging suppression are marked on the route. Route-generated logs
use a bounded audit vocabulary and never include the authorization header, raw body, arbitrary
protocol name, database error, or service error message. Tests capture actual Fastify logs and
prove that valid/invalid credentials and unknown-field body secrets do not appear.

Transport counts/outcomes and latency reuse the existing `SearchOutcome` and `SearchLatency`
metric names with bounded `transport=mcp`, operation, outcome, reason, and status-class dimensions.
Principal ids are optional fields, never metric dimensions. Transport is observability metadata;
it is not an evaluation arm or memory eligibility input.

## Integration

The server registers the v2 memory routes and `memoryMcpRoutes`. `/mcp/memory` is an exact
public-path bypass for the general IMS/org middleware because it performs its own stricter
v2-only service-token/profile/membership snapshot once at request start, and it remains behind the
registered Fastify rate-limit plugin. Generic v1 service-token verification remains independent of
migration 012 and later v2 tables. There is no wildcard public prefix, OAuth metadata route,
browser session, or token proxy. `MemoryCapabilitiesV2.mcp_surface.production_enabled` is true
because both the org-admin credential path and the restricted endpoint are production-usable.

## Conformance evidence

Focused tests cover existing-token ineligibility, fixed target validation, expiry metadata,
production issuance, immutable profiles, unsafe-scope rejection, exact binding and
membership denial, atomic token/binding rollback, HTTP/MCP binding parity, authorization-filtered
catalogs and resources, required modern headers/meta, legacy and unknown-field rejection,
POST-only/stateless behavior, body limit, private caching, error redaction, and real log/metric
safety. A migration-011 regression also proves that authenticated generic v1 service-token
verification does not query migration-012-or-later tables.
