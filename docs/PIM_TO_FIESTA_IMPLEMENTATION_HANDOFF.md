# PIM-to-Fiesta implementation handoff for deployed Memory v2

**Audience:** the agent implementing the Fiesta side of PIM memory

**Status:** PIM Slices 1–7 are implemented and deployed; Fiesta Slices 8–9 remain

**Updated:** 2026-08-13

**Supersedes for Fiesta implementation:** the shadow, exposure, canary, four-arm benchmark,
HTTP-only, and pre-deployment guidance in the older PIM/Fiesta handoff and universal-memory
design documents

## 1. Read this first

Fiesta is the first real consumer of a deployed, harness-neutral PIM contract. It must consume
both repository-scoped codebase memory (beginning with Milo) and Fiesta workflow memory without
becoming the owner of either PIM plane. Fiesta must not require a PIM server change, schema change,
migration, literal Fiesta branch, or Fiesta-specific evidence type.

Implement the smallest complete Fiesta adapter:

1. one Fiesta-owned memory interface;
2. one HTTPS adapter and one MCP adapter behind that interface;
3. exact trusted Fiesta tenant, repository, and harness scope derivation;
4. at most one bounded retrieval/composition step per enabled plane per run;
5. durable, unchanged plane-specific terminal-receipt delivery;
6. `off | on` control and fail-open workflow behavior; and
7. deterministic, inspectable proof that Milo codebase memory and an approved harness memory can
   change a real Fiesta run.

If implementation appears to require a PIM production-code, contract, database, migration, AWS,
or shared-infrastructure change, stop and ask for explicit approval. Do not work around the
boundary with direct SQL, a private PIM branch, a broader credential, or a second governance
system.

## 2. Deployed PIM target and contract pin

Use these exact deployed facts:

| Item | Pinned value |
| --- | --- |
| Public base URL | `https://d1ygncl0yqo6sv.cloudfront.net` |
| HTTPS memory prefix | `/api/v2/memory` |
| Restricted MCP endpoint | `POST /mcp/memory` |
| MCP protocol | `2026-07-28` |
| MCP authentication profile | `private_pim_service_token` |
| Deployed PIM source commit | `5e2a81a5686044fce1d861d054cc6c1ccd6bac94` |
| Deployed image digest | `sha256:6e6c1dc038ef561aefb55f806413d24b984ea8da8054a2a0aaea1f73b962cfb2` |
| Contract revision | `memory-v2:033aee9df1a29ebc` |
| Full contract digest | `sha256:033aee9df1a29ebcdefd17c2119ce9e1448b36e8bdc0c3f43a928667a040a0d6` |
| Public v2 planes | `codebase`, `harness` |
| Fiesta planes for this work | `codebase`, `harness` |
| Initial codebase resource | `github.com/adobecom/milo` |

The stack is deployed, the database is at migrations `18/18`, startup reconciliation passed, the
ASG is healthy, and Memory v2 reports ready. Reverification is intentionally disabled by default.
`worker_status: "disabled"` is a healthy state and does not suppress trusted records.

Do not use `capabilities.server_build` as a provenance pin. The deployed launch template does not
set `PIM_BUILD_REVISION` or `GIT_SHA`, so that field currently reports `development`. Pin the
contract revision above in Fiesta and verify it from authenticated capabilities at startup.

The cutover preserved active Milo codebase records, but their exact deployed organization,
project, and resource binding must be discovered and verified rather than guessed. No
Fiesta-specific harness identity, harness binding, credential, or active harness lesson has been
provisioned yet. Do not put a credential in this document or source control.

## 3. Sources of truth

Use sources in this order:

1. `packages/shared/contracts/memory-contracts.v2.schema.json` — frozen wire contract.
2. `packages/shared/contracts/memory-contract-fixtures.v2.json` — valid neutral examples.
3. `packages/shared/src/types/memory-contracts-v2.generated.ts` — generated TypeScript types.
4. `packages/shared/src/canonical-json.ts` — exact canonical JSON and SHA-256 behavior.
5. `packages/sdk/src/memory-v2-client.ts` — strict HTTPS client and route mapping.
6. `packages/mcp-server/src/memory.ts` — MCP tools, resources, and envelope schemas.
7. `packages/server/src/routes/__tests__/memory-v2-conformance-live.test.ts` — executable
   HTTPS/MCP consumer lifecycle reference.
8. `docs/MCP_A_PRIVATE_PIM_SERVICE_TOKEN_PROFILE.md` — private MCP credential profile.
9. `docs/MEMORY_V2_SIMPLIFICATION_PLAN_2026-08-10.md`, Slices 8 and 9 — scope and exits.
10. `packages/server/src/routes/orgs.ts` and `packages/server/src/routes/projects.ts` — current
    user-authenticated org/project onboarding surface.
11. `packages/server/src/services/memory-repository-registry.ts` — immutable codebase repository
    registration boundary.
12. `packages/server/src/services/service-tokens.ts` — exact dual-plane token and resource binding.

If Fiesta is TypeScript, consume the matching `@pim/shared` contract parser/types and
`@pim/sdk` where practical. If Fiesta uses another language, generate strict models from the JSON
Schema and port the exact canonicalization vectors. Do not hand-copy a reduced schema and do not
accept unknown fields.

The following older documents are stale for implementation and must not override this handoff:

- `docs/UNIVERSAL_MEMORY_PLATFORM_FIESTA_CHANGES.md`;
- `docs/UNIVERSAL_MEMORY_PLATFORM_PIM_CHANGES.md`;
- the removed pre-simplification PIM-managed benchmark, exposure, canary, and kill-switch
  runbooks; and
- any document requiring shadow mode, exposure policy, a canary, prompt/routing eligibility,
  evaluation arms, a four-arm benchmark, a release gate, or HTTP-only Fiesta integration.

## 4. Ownership boundary

### Fiesta owns

- a single local consumer-memory interface;
- transport selection for a run (`https | mcp`) and enabled planes (`codebase | harness | both`);
- `off | on` control;
- trusted derivation of organization, project, repository, base SHA, harness, workflow, adapter,
  configuration, model, and tool identities;
- request IDs, producer-run IDs, client-candidate IDs, and idempotency keys;
- bounded client timeouts and lower local budgets;
- exact response validation and one bounded labeled context block with deterministic plane order;
- recording the plane plus exact record IDs and versions composed into a run;
- durable pre-delivery persistence of one terminal receipt per enabled plane;
- unchanged retries and resume behavior; and
- a bounded trace from activation through prompt/action/receipt.

### PIM owns

- credential verification and exact-resource authorization;
- tenant, project, resource, plane, and operation boundaries;
- search, ranking, trust, lifecycle, applicability, and freshness eligibility;
- immutable record versions and retrieval packs;
- receipt idempotency and candidate identity;
- candidate validation, review, activation, convergence, retention, and revocation;
- evidence verification and reverification policy; and
- all reviewer/admin control-plane mutations.

Fiesta must not add local ranking, a lifecycle engine, an authorization layer, an exposure system,
a release gate, a second adjudicator, or a second governance database. It may validate a PIM
response and fail closed to no memory; it may not broaden a PIM decision.

## 5. Tenant, organization, repository, and credential provisioning

### Recommended tenant mapping

PIM's security hierarchy is:

```text
organization -> project -> exact resource (repository or harness) -> service token
```

A repository name is not tenant authority. PIM derives the organization and project from the
verified credential and authorizes only exact resource bindings.

For Fiesta's current model, where each tenant is a repository, default to one PIM organization per
Fiesta tenant/repository. Only group several repositories into one PIM organization when Fiesta
explicitly defines them as the same tenant/security boundary. PIM supports that grouped model, but
repository ownership alone must never merge tenant authority. Fiesta must persist one explicit
tenant mapping and never infer an organization from a repo owner string:

```text
Fiesta tenant ID
  -> PIM organization ID and slug
  -> PIM project ID
  -> canonical repository ID
  -> Fiesta harness ID
  -> runtime credential reference
```

Service tokens cannot cross organizations. A multi-tenant Fiesta process must select the exact
tenant credential reference before a run and must never use a shared cross-tenant token.

### Can a Fiesta user create an organization?

Yes. An IMS-authenticated PIM user can use the existing PIM UI's **Create org** flow or call the
user-authenticated endpoint directly:

```http
POST /api/orgs
Authorization: Bearer <IMS-user-token>
Content-Type: application/json

{
  "slug": "<unique-tenant-slug>",
  "name": "<tenant-name>"
}
```

The slug must be globally unique, 2–40 lowercase alphanumeric/hyphen characters. Creation makes
the caller the organization owner. A PIM service token cannot call this user-control-plane route.
Do not create a new organization merely because the Milo repository is onboarded: first use
`GET /api/orgs`, select the existing organization that owns Milo, and retain its returned `org_id`
and slug.

For Milo, send `X-Pim-Org: <selected-slug>` to `GET /api/projects` and require exactly one intended
project whose configured GitHub resources include `adobecom/milo`. Retain that returned
`project_id`; do not choose a project by display name alone. The later service-token issuance and
authenticated Memory v2 binding handshake are the final proof that the project owns the exact
registered codebase resource.

All following user-control-plane calls should carry `X-Pim-Org: <exact-org-slug>` when the user can
belong to more than one organization. For a brand-new tenant only, create its project and configure
its GitHub repo as an owner/admin, retaining the returned project ID:

```http
POST /api/projects
Authorization: Bearer <IMS-user-token>
X-Pim-Org: <exact-org-slug>
Content-Type: application/json

{
  "name": "<tenant-repository-name>",
  "description": "Fiesta repository tenant",
  "resources": {
    "github": {
      "repos": ["<owner/repository>"]
    }
  }
}
```

Including or changing `resources` requires an org admin/owner. Project creation and connector
configuration do **not** by themselves create a Memory v2 codebase resource.

### Current codebase-registration boundary

Milo's canonical repository `github.com/adobecom/milo` is already registered and its existing
binding should be reused. Verify it through authenticated Memory v2 binding; do not recreate or
rename it.

For a new repository tenant, the deployed public API currently has no supported post-cutover route
that turns `projects.resources.github.repos` into the immutable
`memory_repository_registry`/Memory v2 codebase resource. The service-token issuer therefore
rejects a new `repository_id` until that exact registration already exists. The old
`prepare-reviewed-memory-repositories` command is a pre-cutover-only procedure and must not be used
for ordinary onboarding.

Consequently, a Fiesta user can self-create an org and project, and harness token issuance can
create the harness resource, but a brand-new codebase tenant is **not yet fully self-service**.
Stop at this boundary and obtain approval for either:

1. a reviewed, supported PIM repository-registration API; or
2. a narrowly scoped operator procedure that verifies GitHub's immutable repository ID and creates
   the canonical repository binding.

Do not call `registerMemoryRepository` directly from Fiesta, write SQLite, reuse another tenant's
binding, or treat project connector configuration as memory authorization.

### Stable tenant values

Choose these values outside the model and keep them stable:

- exact PIM organization;
- exact PIM project ID;
- exact canonical repository ID (`github.com/adobecom/milo` for the initial tenant);
- independently resolved base commit SHA for each codebase run;
- exact Fiesta harness ID, 1–64 characters;
- Fiesta harness build/version;
- workflow contract/version;
- adapter version;
- stable configuration ID; and
- SHA-256 digest of trusted, canonical Fiesta configuration.

### Dual-plane runtime token

After both exact resources exist, an authenticated PIM org admin/owner should mint one
least-privilege private MCP-profile service token per Fiesta tenant. That token is also a valid
HTTPS v2 service token, so one credential can exercise both transports and both planes with
identical tenant authority.

Provision through `POST /api/org/service-tokens` with an admin credential and an exact body shaped
like this:

```json
{
  "name": "fiesta-pim-memory-v2",
  "authentication_profile": "private_pim_service_token",
  "scopes": [
    "memory:search",
    "memory:receipt:write",
    "memory:candidate:read",
    "memory:harness:search",
    "memory:harness:receipt:write",
    "memory:harness:candidate:read"
  ],
  "project_id": "<exact-project-id>",
  "repository_ids": ["github.com/adobecom/milo"],
  "harness_ids": ["<exact-fiesta-harness-id>"],
  "expires_in_days": 30
}
```

Issuance atomically creates the service principal, repository/harness authority, the harness v2
resource, exact-resource operations, and private MCP profile. The referenced project and codebase
repository resource must already exist. A separate harness-registration API or PIM server edit is
not needed.

The raw `pim_svc_...` token is returned once in a `private, no-store` response. Put it in Fiesta's
existing secret mechanism and keep only a credential reference in configuration. Never log the
token, send it to a model, store it in a receipt, or place it under PIM's SSM namespace merely to
avoid a Fiesta infrastructure decision.

Do not add `memory:review`, `memory:harness:review`, admin, activation, or attestation scopes to the
runtime token. The private MCP profile rejects control-plane scopes. Approval and provider
attestation use separate PIM credentials over HTTPS and are never part of the Fiesta runtime.

If credential delivery requires new shared IAM, a new cross-stack secret, networking, or another
stack change, stop for explicit approval.

## 6. Startup handshake and contract freeze

When memory mode changes to `on`, and at process startup or after credential rotation while memory
mode is `on`:

1. call authenticated capabilities;
2. require `contract_revision === "memory-v2:033aee9df1a29ebc"`;
3. require every configured plane (`codebase`, `harness`, or both) to be `available`;
4. require MCP `production_enabled: true` and protocol `2026-07-28` when MCP is selected;
5. call binding;
6. find exactly one `codebase`/`repository` resource with the configured canonical repository ID
   and, when harness memory is enabled, exactly one `harness` resource with the configured harness
   ID;
7. require the expected organization, project, plane, resource type, and operations for each;
8. persist the non-secret validated binding metadata for outage-safe receipt construction; and
9. call readiness for each exact configured resource.

Required runtime operations are:

- codebase `search`, `detail`, `pack`, and `readiness` from `memory:search`;
- codebase `receipt_write` and `candidate_write` from `memory:receipt:write`;
- codebase `candidate_read` from `memory:candidate:read`;
- harness `search`, `detail`, `pack`, and `readiness` from `memory:harness:search`;
- harness `receipt_write`, `candidate_write`, and receipt-carried `runtime_attestation_write` from
  `memory:harness:receipt:write`; and
- harness `candidate_read` from `memory:harness:candidate:read`.

The binding projection may also contain `history` or `runtime_attestation_write`. Do not infer a
public Fiesta API from those names: harness history has no public route, and harness runtime
evidence is carried only inside a receipt. Use authenticated capabilities and the routes/tools in
this document as the public surface. MCP tool discovery is additionally filtered by the current
credential.

Treat readiness `status: "healthy"` as ready. `worker_status: "disabled"` remains healthy. A
degraded/unavailable readiness result disables that plane for the run but must not stop the other
plane or the Fiesta workflow.

If the contract revision, tenant, resource, or operation set is wrong, disable memory and emit a
bounded operator-facing configuration error. Do not adapt silently to a different revision.

## 7. Fiesta-local architecture

Implement one interface with transport-neutral domain inputs and outputs. The exact language and
module names should follow the Fiesta repository, but the responsibilities should resemble:

```text
FiestaMemoryConsumer
  initialize(config, trustedIdentity) -> capability/binding snapshot
  retrieve(trustedRunScope, enabledPlanes) -> PlaneMemoryUse[] | NoMemory
  persistTerminalReceipts(terminalRun, enabledPlanes) -> DurableOutboxEntry[]
  deliverPendingReceipts() -> accepted | replayed | retryable | terminal_error
  candidateStatus(pointer) -> typed candidate status
```

Adapters translate only envelopes:

```text
FiestaMemoryConsumer
  -> HttpsPimMemoryAdapter
  -> McpPimMemoryAdapter
```

Business rules, trusted-scope construction, response closure, composition, and receipt creation
must live above the adapters and run identically for both transports.

Persist at least these non-secret structures:

### Binding snapshot

- contract revision;
- tenant organization/project;
- exact codebase and harness `ResourceBindingV2` values;
- canonical repository ID, harness ID, and credential-reference version;
- permitted operations; and
- validation time.

### Retrieval/use trace

- Fiesta root run ID, plane, and plane-specific request/producer-run IDs;
- selected transport;
- retrieval pack ID and pack scope digest;
- exact record ID/version pairs in PIM order;
- exact rendered context-block digest;
- pack expiry; and
- whether each record was actually composed.

### Receipt outbox entry

- Fiesta root run ID, plane, and stable plane-specific producer-run ID;
- stable idempotency key;
- selected transport;
- exact serialized outbound body/tool arguments;
- credential reference, never the credential;
- attempt metadata and bounded typed error;
- PIM receipt ID/request digest after acceptance; and
- candidate pointers returned by PIM.

Persist IDs and exact bytes when first created. A retry or resumed run must never regenerate them
from mutable workflow state.

Receipt replay, candidate lookup, and feedback authority remain tied to the service principal that
created the original search/receipt. During credential rotation, keep the original credential
reference available until its receipt is acknowledged and its candidate tracking is complete.
Use the replacement credential for new runs. Do not revoke the old credential while it still owns
an undelivered outbox entry unless deliberately accepting that the entry will require operator
remediation.

## 8. Trusted scope construction

Build every authority-bearing field from trusted Fiesta runtime/configuration state, never from
model output:

- expected `organization_id`, expected `project_id`, and credential reference from the persisted
  Fiesta tenant map;
- `repository_id` from the tenant's exact canonical repository binding;
- `base_sha` from the trusted checked-out commit or verified provider event for that repository;
- codebase `components`, `paths`, `symbols`, and task classes from bounded trusted run inputs;
- `harness_id` from deployment configuration;
- `harness_version` from the Fiesta build;
- `workflow_version` from the workflow definition;
- `adapter_version` from this adapter's release;
- plane-specific `consumer_run_id` and `producer_run_id` from stable Fiesta root run identity;
- authoritative `project_id` and `resource_row_id` from the authenticated PIM binding, required to
  match the tenant map;
- `configuration_id` from a stable trusted configuration identity;
- `configuration_digest` from canonical trusted configuration;
- `model_ids` from the configured runtime model(s);
- `tool_ids` from the configured tool set; and
- timestamps from the runtime clock.

The model may propose bounded lesson content. It may not supply or override tenant, resource,
versions, selectors, evidence authority, record IDs, timestamps, request IDs, or idempotency keys.

Codebase search requires a non-null resolved commit SHA. Never let a model invent `base_sha`, fall
back to a branch name, use the latest default-branch SHA silently, or query a different repository.
If Fiesta cannot resolve the exact run commit, skip codebase memory for that run. The
`MemoryConsumerV2` harness/workflow identity remains required even for codebase searches because it
identifies Fiesta as the consumer; it does not change repository authority.

Sort and deduplicate selector arrays before the first request, then preserve them for retry. Treat
version/range strings as opaque contract selectors; do not invent a second compatibility engine.
The deployed harness matcher supports only `*` or an exact version string, not semantic-version
ranges.

### Important deployed configuration-digest behavior

For the deployed contract revision:

- harness search may send the exact trusted configuration ID in `configuration_ids`;
- harness search must send `configuration_digests: []`;
- a non-empty harness-search `configuration_digests` array is an intentional hard filter and
  currently returns no records because PIM has no canonical digest-selector column; and
- the terminal receipt still requires the singular trusted `configuration_id` and
  `configuration_digest`.

Do not drop the receipt digest and do not add a PIM change to make search digest-aware. If Fiesta
requires digest-specific retrieval rather than stable configuration-ID retrieval, stop and request
an explicit future contract revision.

## 9. HTTPS adapter

All calls use `Authorization: Bearer <token>`. `X-Pim-Org` is optional compatibility metadata; if
sent, it must match the token-bound organization and is not authority.

| Operation | HTTPS |
| --- | --- |
| Capabilities | `GET /api/v2/memory/capabilities` |
| Exact binding | `GET /api/v2/memory/binding` |
| Readiness | `GET /api/v2/memory/readiness?plane=<selected-plane>&resource_row_id=<id>` |
| Search | `POST /api/v2/memory/search` with `CodebaseMemorySearchV2` or `HarnessMemorySearchV2` |
| Record version | `GET /api/v2/memory/records/<record_id>?version=<n>` |
| Retrieval pack | `GET /api/v2/memory/packs/<pack_id>` |
| Terminal receipt | `PUT /api/v2/memory/run-receipts/<producer_run_id>` plus `Idempotency-Key` |
| Codebase candidate | `GET /api/v2/memory/candidates/<candidate_id>` |
| Harness candidate | `GET /api/v2/memory/candidates/<candidate_id>?plane=harness&resource_row_id=<id>&receipt_id=<id>&producer_run_id=<id>` |
| Reviewer decision | `POST /api/v2/memory/candidates/<candidate_id>/decisions` with a separate HTTPS reviewer credential |

The standalone `POST /api/v2/memory/feedback` operation is codebase-only, but the smallest shared
Fiesta path should carry both codebase and harness feedback in each plane's terminal receipt
`retrieval_feedback` array. Do not add `memory:feedback:write` unless a separately justified
standalone codebase-feedback workflow is implemented.

Use the strict `PimMemoryV2Client` where possible, but wrap calls with Fiesta-owned bounded
timeouts/cancellation. The current SDK does not choose timeout values for Fiesta.

## 10. MCP adapter

MCP is stateless and POST-only. Do not initialize a session, request SSE, send `Mcp-Session-Id`,
forward a raw credential through another service, or create a fallback loop through HTTPS.

For example, a harness-search request uses:

```http
POST /mcp/memory
Authorization: Bearer <private-profile-token>
Content-Type: application/json
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: pim_harness_memory_search
```

The JSON-RPC body is:

```json
{
  "jsonrpc": "2.0",
  "id": "<stable-request-id>",
  "method": "tools/call",
  "params": {
    "name": "pim_harness_memory_search",
    "arguments": {},
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": {
        "name": "fiesta-pim-memory",
        "version": "<adapter-version>"
      },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

`Mcp-Method` must match the JSON-RPC method. `Mcp-Name` must match the tool name or resource URI.

Fiesta uses these tools:

- `pim_memory_capabilities`;
- `pim_memory_binding`;
- `pim_memory_readiness`;
- `pim_code_memory_search`;
- `pim_harness_memory_search`;
- `pim_run_receipt_submit`; and
- `pim_candidate_status`.

Fiesta reads immutable details through:

- `pim-memory://records/{record_id}/versions/{version}`; and
- `pim-memory://packs/{pack_id}`.

For `resources/read`, set the JSON-RPC method and `Mcp-Method` to `resources/read`, set `Mcp-Name`
to the exact URI, and include `{ "uri": "...", "_meta": ... }` in params.

MCP search arguments omit `tenant`; PIM derives it from the verified token. MCP receipt arguments
omit `tenant` and omit `scope_snapshot.resource_binding`; PIM injects the exact frozen binding.
Build the transport-neutral canonical receipt first, compute its digest with the binding present,
then strip only those MCP-owned authority fields when creating MCP tool arguments. Do not compute a
different MCP receipt digest.

For `pim_candidate_status`, codebase arguments include `plane: "codebase"`, the exact resource
selector, and candidate ID. Harness arguments additionally include the exact receipt ID and
producer-run ID. Do not weaken the harness selector to look like the codebase form.

Decode both error locations:

- JSON-RPC `error.data` may contain `PimErrorV2`; and
- a tool result with `isError: true` may contain `PimErrorV2` in `structuredContent`.

For resources, parse `result.contents[0].text` as JSON and validate the named PIM contract.

The route limit is 512 KiB and 60 requests/minute. Published PIM limits are 256 KiB per receipt,
32 KiB per candidate, 8,000 search tokens, and 32 search items. Fiesta must choose lower bounded
budgets appropriate to one prompt.

## 11. One logical retrieval per enabled plane

When mode is `off`, make no PIM calls and compose no memory. The baseline remains ordinary Fiesta.

When mode is `on`, perform the following independently for each configured plane, with a hard
maximum of one fresh logical search for `codebase` and one for `harness`:

1. derive the trusted run scope;
2. use the cached validated binding and healthy readiness state;
3. create one stable plane-specific logical search request;
4. send one exact codebase or harness search through the selected adapter;
5. validate `MemorySearchResultV2` strictly;
6. fetch and validate the immutable retrieval pack;
7. fetch each selected record at its exact returned version;
8. validate the closure below;
9. retain the approved content in PIM order for deterministic composition; and
10. record the plane plus exact record/version pointers and rendered-block digest.

A network retry of the unchanged request is still the same logical search. Do not issue a wider
query, a second ranking pass, a cross-plane substitution, or a cross-transport fallback for the
same plane/run. Failure of one plane discards only that plane's result; it must not widen the other
plane or fail the primary Fiesta workflow.

Search request IDs are idempotency claims retained for 30 days. Reusing one with changed content
conflicts. An unchanged replay can return its original pack even after that pack's 15-minute
expiry, so generate one persisted request ID per fresh logical search, retry it only for delivery
uncertainty, and never compose an expired replayed pack.

### Common search request rules

Use `CodebaseMemorySearchV2`/`MemoryMcpCodeSearchInputV2` for codebase and
`HarnessMemorySearchV2`/`MemoryMcpHarnessSearchInputV2` for harness:

- `schema_version: "pim.memory-search.v2"`;
- stable `request_id` for the logical request;
- exact `MemoryConsumerV2` identity;
- exact `resource_row_id` selector from binding;
- a bounded task query and task class;
- `temporal.mode: "current"` with real timestamps;
- local `max_tokens` and `max_items` below PIM maxima; and
- explicit `include_explanations`.

For codebase search additionally require:

- `plane: "codebase"`;
- canonical `repository_id` equal to the bound repository;
- the non-null exact `base_sha` resolved for the Fiesta run; and
- sorted/deduplicated trusted `components`, `paths`, `symbols`, and `task_classes`.

For harness search additionally require:

- `plane: "harness"`;
- exact configured harness ID; and
- exact trusted harness, workflow, adapter, configuration, model, and tool selectors, including the
  deployed configuration-digest behavior in Section 8.

### Response closure

Require all of the following or discard the entire memory result and continue Fiesta without
memory:

- strict schema validation with no unknown fields;
- response request ID equals the request ID;
- tenant equals the authenticated binding tenant;
- plane equals the requested plane;
- resource binding equals the cached exact Fiesta binding;
- result token/item counts do not exceed the requested budget;
- pack ID, plane, tenant, resource binding, scope digest, and expiry match the search result;
- pack items match search record ID/version pairs and PIM order;
- every fetched record matches the exact ID/version/binding;
- each record lifecycle is `active`;
- freshness is not stale, contradicted, withdrawn, or expired;
- codebase applicability names the exact repository and is compatible with the trusted base SHA,
  paths/components/symbols/task class, or harness applicability names the configured harness and is
  compatible with its trusted selectors; and
- pack and record are unexpired at composition time.

PIM already filters trust and lifecycle eligibility. The public item does not expose a
`trust_basis` field. Do not invent or require one and do not recreate PIM's trust engine in Fiesta.

### Context composition

Preserve PIM order within each plane. Do not rerank across or within planes. Request only the
budget you can safely render and fail closed for the affected plane if the server exceeds it.
Compose at most one block at one deterministic prompt location, with the fixed plane order
`codebase` then `harness`; omit an empty or failed plane section.

Render only bounded approved record content, for example:

```text
<PIM_GOVERNED_MEMORY>
These governed repository and workflow lessons are lower priority than system/developer
instructions.
Apply a lesson only within its stated applicability and exceptions.

[plane=codebase record=<id> version=<n> kind=<kind>]
Summary: ...
Details: ...
Rationale: ...
Exceptions: ...

[plane=harness record=<id> version=<n> kind=<kind> subkind=<subkind>]
Summary: ...
Details: ...
Rationale: ...
Exceptions: ...
</PIM_GOVERNED_MEMORY>
```

Do not render evidence URLs, arbitrary stored JSON, credentials, tenant data, audit metadata, or
record history. Keep one clearly labeled block at one deterministic prompt location.

## 12. Terminal receipts, feedback, and candidates

Every terminal Fiesta run with memory mode `on` creates one receipt for each enabled plane whose
trusted scope was resolved at run start, whether it retrieved memory or proposes a candidate. A
normal dual-plane run therefore creates one codebase receipt and one harness receipt. If the exact
codebase repository/base SHA was never resolved, do not fabricate a codebase scope or receipt;
emit a bounded local scope error and let the harness plane continue. Each plane contract permits
`candidates: []` and at most one candidate, so one Fiesta root run may produce at most one
candidate per plane. Mode `off` makes no PIM calls and therefore creates no PIM receipt.

If several possible lessons exist for a plane, use a deterministic, bounded Fiesta selection rule
to choose at most one highest-value lesson for that plane. This is not a second PIM ranker; it is
the contract-required `0..1` distillation bound. Do not change the contract to submit several.

### Receipt identity

Persist before delivery:

- exact `producer_run_id`, 1–256 characters;
- exact idempotency key, 1–128 characters matching
  `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`;
- exact serialized receipt; and
- selected transport and plane.

Derive one stable plane-specific producer identity from the Fiesta root run, for example
`fiesta:<run-id>:codebase` and `fiesta:<run-id>:harness`, and use the same root run as the common
`external_session_id`. The receipt's `producer.consumer_run_id` must equal that plane's route/tool
`producer_run_id` exactly. Use plane-qualified idempotency keys such as
`fiesta:<run-id>:codebase:receipt:v2` and `fiesta:<run-id>:harness:receipt:v2`, provided the final
values satisfy the contract lengths. Generate them once and persist them. Never create a new
identity merely because a request timed out.

An identical retry returns `status: "replayed"` and `duplicate: true`; treat that as success. A
changed payload under the same producer/key returns `idempotency_conflict`; stop that outbox entry
and alert an operator. Do not mutate the body or bypass the conflict with a new key.

### Receipt scope digest

For HTTPS, construct the exact plane-specific scope snapshot.

Codebase:

```text
schema_version
plane
resource_binding
repository_id
base_sha
scope_snapshot_digest
```

Harness:

```text
schema_version
plane
resource_binding
harness_id
harness_version
workflow_version
adapter_version
configuration_id
configuration_digest
scope_snapshot_digest
```

Compute `scope_snapshot_digest` as PIM `canonicalJsonSha256` over the snapshot with the
`scope_snapshot_digest` property omitted. PIM canonical JSON sorts object keys, preserves array
order, rejects invalid Unicode/non-finite numbers/cycles, serializes compact UTF-8 JSON, and prefixes
the lowercase SHA-256 hex digest with `sha256:`.

Codebase search and receipt scope both close over the exact resource binding, repository, and base
SHA; when a codebase search occurred, its pack and receipt scope digests must therefore match.
Harness search/pack and terminal-receipt scope digests are different by design: search closes
over selector arrays while the receipt closes over the singular runtime configuration and
resource binding. Never copy a digest across planes or recompute feedback from a receipt snapshot:

- feedback uses the exact search/pack scope digest;
- the receipt candidate uses the exact receipt scope digest.

### Retrieval feedback

For every retrieved record, retain whether it was composed and the observed disposition. Receipt
feedback must reference the exact:

- retrieval pack ID;
- pack scope digest;
- record ID;
- record version;
- disposition (`helpful | harmful | stale | conflicting | not_used | unknown`); and
- bounded reason code.

Feedback-only receipts with no candidate are valid. Never reference a record/version that was not
in the exact pack.

### Harness candidate rules

The smallest Slice 8/9 path should use a successful-run lesson with:

- a generic harness subkind;
- the required mapped broad kind;
- `validation.strategy: "authorized_review"`;
- `validation.failure_fingerprint: null`;
- `activation_requirement_requested: "authorized_review"`; and
- no fabricated runtime evidence.

PIM publishes the current subtype mapping in capabilities:

| Harness subkind | Broad kind |
| --- | --- |
| `workflow_strategy` | `decision` |
| `failure_pattern` | `anti_pattern` |
| `verification_sequence` | `test_strategy` |
| `tool_constraint` | `constraint` |
| `escalation_requirement` | `constraint` |

A failure-derived lesson is stricter: it needs an exact stable failure fingerprint and genuine,
provider-verifiable immutable runtime evidence. The fingerprint must agree across terminal outcome,
validation, and evidence. Never turn model prose into authoritative evidence.

The deployed harness writer also enforces these cross-field invariants beyond the generic JSON
Schema:

- `receipt.producer.consumer_run_id` must equal the route/tool `producer_run_id` exactly;
- candidate `source_run_ids` must include that same `producer_run_id`;
- candidate resource, receipt scope, and harness applicability must match the authenticated receipt
  and exact binding;
- a successful `authorized_review` lesson requires terminal outcome `status: "completed"`,
  `verification_status: "passed"`, and `failure_fingerprint: null`;
- its `validation.anchor_refs` must be empty; and
- candidate configuration IDs, when present, must include the receipt configuration ID, while a
  supplied configuration digest must exactly equal the receipt digest and there may be at most one.

Every receipt-carried runtime evidence handle must be referenced by the one submitted candidate,
and derivation references must be acyclic and resolve within that receipt. Do not send an
evidence-only zero-candidate receipt. For the deployed default provider path, use
`authorized_review` for the Slice 8/9 lesson; do not request `runtime_attestation` unless a real
verified evidence provider is already configured and proven.

The canonical harness writer enforces stricter effective limits than some generic schema roots:

- candidate summary: 10–500 characters;
- details: 30–8,000 characters;
- rationale: 10–4,000 characters;
- source runs: at most 16;
- evidence references: at most 64;
- model/tool identity lists: at most 32 entries, each at most 160 characters;
- terminal stage: at most 64 characters; and
- a present failure fingerprint: at least 8 characters.

An inconclusive receipt verification result is rejected. Writes also reject secret-shaped values,
SSNs, and hidden-reasoning field names. Send a bounded governed lesson and evidence references,
not raw transcripts, credentials, or chain of thought.

### Codebase candidate rules

Milo's already-active codebase records require no candidate step to retrieve. If Fiesta also
proposes new codebase memory, the codebase receipt uses `CodebaseRunReceiptV2`, an exact
`CodebaseScopeSnapshotV2`, and a `CodeEvidenceManifestV2`. Even a zero-candidate receipt carries a
valid evidence manifest, whose `refs` may be empty.

Every codebase candidate must have `subkind: null`, the exact receipt resource/scope/base SHA, and
genuine evidence references resolvable inside that receipt's manifest. Then apply this lifecycle:

| Codebase candidate | Required validation | Requested activation | Result after structural validation |
| --- | --- | --- | --- |
| Positive lesson (`kind` other than `anti_pattern`) | `repository_anchors` with real path/symbol anchors | `verified_merge` | `pending_merge` until an independently verified matching GitHub merge activates it |
| Failure/anti-pattern | `stable_failure_fingerprint` with matching failure evidence | `authorized_review` | `pending_review` until a separate codebase reviewer approves it |

`verified_merge_and_test` is not available in this deployed revision. Positive activation must
match the authenticated repository, base/head/merge state, manifest, and authoritative final-diff
digest. It is fail-closed unless a PIM operator has explicitly included the canonical repository in
`MEMORY_ACTIVATION_REPOSITORIES`. Fiesta must not assume Milo is allowlisted, change that setting,
or submit the separate GitHub attestation itself with its runtime credential.

This verified-merge path is the only governed automatic activation relevant to Fiesta. It is not
confidence-based or model-decided auto-promotion. Harness candidates do not auto-promote in the
deployed revision, and codebase anti-patterns always require authorized review.

Candidates are proposals, not active memory until their plane's activation requirement is
satisfied. The PIM candidate worker validates asynchronously. Poll candidate status out of band
with a bound; never block the completed Fiesta workflow waiting for review, merge evidence, or
activation.

## 13. Reviewer and lifecycle control

Ordinary Fiesta runtime credentials cannot review. A separate PIM reviewer uses HTTPS
`POST /api/v2/memory/candidates/<candidate_id>/decisions` with exact resource authority and either
`memory:review` for a codebase anti-pattern or `memory:harness:review` for a harness candidate to
submit `approve | reject`.

The Fiesta runtime may observe candidate status but must not hold or invoke reviewer or GitHub
attestation authority. There is no MCP review or attestation tool.

An independently verified GitHub revert can revoke a codebase record that was activated by the
matching verified-merge path. That does not provide generic revocation for migrated Milo records,
review-activated codebase anti-patterns, or harness records.

The deployed public v2 surface does not expose a generic record-lifecycle revocation endpoint, and
the deployed repository has no approved operator CLI or runbook for that action. Before Slice 9's
lesson-revocation proof, stop and obtain explicit approval for one narrowly scoped PIM operator
procedure. Fiesta must only re-run search afterward and prove the revoked record is no longer
composed. Do not add a PIM endpoint, call an internal service, or update SQLite from the Fiesta
implementation. Until that procedure is named, reviewed, and authorized, the revocation step—and
therefore Slice 9 completion—remains blocked rather than silently waived.

Token revocation is different and already public to the PIM admin: `POST
/api/org/service-tokens/<token_id>/revoke`. It denies the next request but does not cancel a request
that already passed request-start authorization.

## 14. Failure and retry behavior

PIM availability must never determine whether Fiesta completes its primary workflow.

| Condition | Fiesta behavior |
| --- | --- |
| Mode `off` | Make no PIM calls; ordinary Fiesta behavior |
| Timeout/network error | Skip the affected plane; finish workflow; queue exact plane receipt(s) |
| HTTP `429`/`5xx` or `PimErrorV2.retryable=true` | Bounded backoff; unchanged request/body only |
| Readiness `degraded`/`unavailable` | Skip that plane for the run; do not treat workflow as failed |
| `worker_status=disabled` with healthy readiness | Normal healthy operation |
| `authentication_required` | Configuration/rotation failure; do not blind-retry |
| `scope_required` or `resource_binding_mismatch` | Authority/configuration failure; disable memory and alert |
| `resource_not_found` for exact configured resource | Fail closed to no memory; alert; do not enumerate alternatives |
| Missing/unregistered tenant repository | Onboarding error; do not substitute a repo, org, project, or harness binding |
| Missing trusted codebase `base_sha` | Make no codebase call or receipt; harness may continue |
| `contract_version_unsupported` or schema mismatch | Disable memory; require compatible adapter/contract |
| `idempotency_conflict` | Terminal outbox error; preserve body/key for diagnosis |
| `evidence_unresolvable`/`evidence_mismatch` | Do not weaken evidence; retain for explicit remediation |
| Candidate rejected/failed | Record status; never fail or retry the primary Fiesta work |

Use explicit bounded timeouts selected according to Fiesta's operational conventions. PIM defines
no Fiesta timeout values. Keep the chosen transport stable for a run and for its receipt outbox
entry; do not automatically fall back across transports and accidentally change the wire body.

To prove outage resume, first complete a successful capabilities/binding bootstrap and persist the
non-secret bindings. Then make PIM unavailable, complete the Fiesta run with no memory, persist the
exact plane receipt bodies and keys, restore PIM, and deliver the unchanged outbox entries.

## 15. Slice 8 implementation sequence

Keep changes reviewable and small:

### PR 1 — contract pin, configuration, and trusted identity

- consume/generate strict v2 contracts;
- add the deployed revision pin;
- add the trusted Fiesta-tenant-to-PIM mapping, enabled planes, `off | on`, transport, endpoint,
  credential reference, timeouts, and per-plane budgets;
- implement canonical JSON/hash parity tests; and
- implement trusted repository/base-SHA and harness run-scope derivation with no model authority.

**Exit:** mode `off` causes zero PIM calls; an invalid tenant mapping, revision, or resource binding
safely disables the affected memory plane.

### PR 2 — HTTPS retrieval and composition

- implement capabilities/binding/readiness;
- implement exact Milo codebase and harness searches, pack/detail reads, closure validation, and
  one deterministically ordered bounded block;
- persist plane plus exact record/version use trace; and
- prove ordinary Fiesta completion on PIM timeout.

**Exit:** one HTTPS Milo run retrieves eligible codebase memory at the exact repository/base SHA,
one harness run retrieves only the exact harness resource, and outage produces ordinary Fiesta
behavior.

### PR 3 — durable receipts and governed candidate loop

- add a durable exact-body outbox with separate codebase and harness entries;
- submit zero-candidate, one-candidate, and feedback-only receipts on both planes;
- implement unchanged replay and typed conflict handling;
- expose bounded candidate status to operators;
- prove codebase `verified_merge` versus `authorized_review` behavior; and
- keep review/attestation HTTPS-only and outside runtime.

**Exit:** reviewed harness/codebase anti-pattern candidates become active, a positive codebase
candidate remains pending until independently verified merge evidence, and duplicate delivery
replays.

### PR 4 — MCP parity

- add the stateless MCP adapter;
- run both plane scenarios through MCP;
- add record/pack resource reads and MCP error decoding; and
- prove the interface/business behavior is shared with HTTPS.

**Exit:** the real Fiesta workflow passes through both transports and both planes without a PIM
code/schema change.

### Slice 8 final failure matrix

- mode off;
- PIM unavailable before search;
- PIM unavailable during receipt delivery;
- unchanged receipt replay after restart;
- expired/revoked runtime credential;
- wrong org/project/repository/base SHA/resource/harness;
- contract revision mismatch;
- malformed/unknown response field;
- pack/detail closure mismatch;
- cross-repository and cross-harness access attempts; and
- candidate rejection without workflow failure.

## 16. Slice 9 deterministic influence proof

Do not build a statistical benchmark or multi-arm experiment. Prove the two enabled planes with
bounded real workflows and predefined observable actions.

### Milo codebase influence

1. Select a safe Milo workflow with an exact checked-out commit SHA and identify an eligible
   already-active Milo codebase record before the test.
2. Run with memory `off`; capture the bounded prompt/context trace and predefined action.
3. Run with codebase memory `on` through HTTPS using the exact
   `github.com/adobecom/milo` binding and base SHA.
4. Assert that exact record ID/version appears in the codebase search, fetched pack, record detail,
   rendered `codebase` section, and model input.
5. Assert the predefined action changes as expected and the codebase terminal receipt references
   the exact pack/record/version.
6. Repeat codebase retrieval and receipt delivery through MCP using the same Fiesta interface.
7. Retain a bounded trace linking:

```text
Milo codebase resource -> active record/version -> retrieval pack
-> rendered block digest -> model input location -> observable action -> codebase receipt
```

### Harness learning influence

1. Select a safe, bounded real Fiesta workflow and define the expected observable action before
   running the test.
2. Run with memory `off`; capture the bounded prompt/context trace and actions.
3. Run a terminal learning case and submit one uniquely tagged `authorized_review` lesson for the
   exact workflow/configuration.
4. Let PIM validate it; have an authorized PIM reviewer approve it over HTTPS.
5. Record candidate ID, decision, activated record ID/version, and activation time.
6. Run with memory `on` through HTTPS.
7. Assert that exact record ID/version appears in the fetched pack, record detail, rendered context
   block, and model input.
8. Assert the predefined observable action changes as expected and the run ends with a terminal
   receipt referencing the exact pack/record/version.
9. Repeat harness retrieval and receipt delivery through MCP using the same Fiesta interface.
10. At the explicit Slice 9 revocation gate, obtain approval for the narrowly scoped PIM operator
    procedure described above; use it to revoke the lesson, then re-run and prove the record is
    absent from new composition.
11. Simulate PIM outage after prior dual-plane bootstrap; prove Fiesta completes and keeps both
    exact plane receipts queued for unchanged retry.
12. Retain one bounded trace linking:

```text
candidate -> reviewer decision -> active record/version -> retrieval pack
-> rendered block digest -> model input location -> observable action -> terminal receipt
```

The trace must be inspectable without retaining credentials, full unrestricted prompts, arbitrary
model transcripts, or unrelated tenant data.

## 17. Required tests

### Unit/contract tests

- frozen revision and schema digest;
- strict unknown-field rejection;
- canonical JSON/hash parity with PIM vectors;
- deterministic plane-qualified request/run/idempotency identity across resume;
- tenant mapping, repository ID, base SHA, and harness identity cannot be overridden by model
  output;
- configuration-ID search versus receipt configuration-digest behavior;
- exact codebase scope digest plus distinct harness search/pack and receipt scope digests;
- plane-specific response/pack/detail closure;
- bounded deterministic `codebase`-then-`harness` rendering and no local reranking;
- at most one search and exact `0..1` candidate selection per enabled plane;
- secret redaction; and
- typed error/retry classification.

### Adapter conformance, once per plane/transport pair

- capabilities, dual-resource binding, and healthy readiness per plane;
- exact codebase and harness searches;
- zero-candidate receipt per plane;
- one-candidate receipt per plane;
- unchanged receipt replay;
- candidate status;
- separate HTTPS review/activation and codebase verified-merge status;
- active search plus exact record and pack reads;
- feedback-only receipt;
- wrong/cross-repository and wrong/cross-harness denial;
- revocation visible on the next request; and
- PIM outage with an unchanged durable receipt.

### Real workflow tests

- memory off baseline;
- PIM unavailable baseline equivalence;
- Milo codebase memory on with exact repository/base SHA and record/version in prompt;
- harness memory on with exact record/version in prompt;
- observable action change;
- alternate transport parity;
- revoked lesson no longer composed; and
- retained bounded influence trace.

Use a local disposable PIM server/database for broad write, approval, denial, and fault-injection
tests. Use the deployed endpoint only for a bounded operator-approved scenario with dedicated
Fiesta credentials and no unrelated production data.

## 18. Definition of done

Slice 8 is complete only when:

- Fiesta owns one memory interface with HTTPS and MCP adapters;
- it pins and validates the deployed contract revision;
- all tenant, repository/base-SHA, and harness scope comes from trusted Fiesta runtime state;
- codebase and harness search are exact, bounded to one per enabled plane, and composed without
  local ranking;
- Milo active codebase memory is retrieved through its exact existing binding;
- plane plus exact record/version use is durable and inspectable;
- one terminal receipt per enabled plane is persisted before delivery and replayed unchanged;
- zero/one candidate and feedback-only outcomes work on both planes;
- ordinary Fiesta credentials cannot approve;
- mode off and PIM outage never block Fiesta; and
- no Fiesta-specific PIM server/schema/migration change was made.

Slice 9 is complete only when:

- one exact Milo codebase record and one approved exact-workflow harness lesson each change one
  predefined observable Fiesta action;
- both plane retrieval/receipt paths work through both transports;
- revocation removes the lesson from new composition;
- PIM outage preserves Fiesta completion and receipt retry; and
- one bounded influence trace per plane is retained.

Reusing Milo's existing codebase binding is in scope without a PIM change. General self-service
codebase onboarding for brand-new repository tenants is not complete until the registration gap in
Section 5 has an approved public API or operator procedure; do not silently count org/project
creation alone as codebase onboarding.

Anything broader—multi-run statistical evaluation, new planes, a plugin registry, a new PIM
control plane, mid-request cancellation, generalized ranking, or another governance system—is
outside Slices 8–9 and requires a separate decision.
