# PIM universal-ready memory: vertical slice plan

> **Superseded slice plan.** The final implementation removed its exposure-policy, release-gate,
> canary, benchmark, and kill-switch slices. Use [MEMORY_API.md](./MEMORY_API.md) for current code.

**Status:** historical implementation slicing of [UNIVERSAL_MEMORY_PLATFORM_PIM_CHANGES.md](./UNIVERSAL_MEMORY_PLATFORM_PIM_CHANGES.md) (the "spec"; section references below point there)
**Baseline:** `podFix` at `5161be7`
**Companion:** [Fiesta changes](./UNIVERSAL_MEMORY_PLATFORM_FIESTA_CHANGES.md) consume each slice; the Fiesta FU phases map at the bottom.

Each slice is a thin end-to-end loop demoable against a live server with the generated HTTP client
and its restricted PIM Memory MCP companion. HTTP remains canonical and Fiesta remains on HTTP,
but the safe MCP data plane is implemented and conformance-tested in lockstep so no later transport
retrofit is required. A slice is done when both its core and MCP companion exit tests pass, not
when its code merges. If MCP-A discovers a separate identity project, the HTTP release train may
advance while the MCP schedule is explicitly rebaselined; the platform cannot call itself
MCP-complete until the companion exits pass. Bounds are hard: anything under "Out" is deliberately
excluded even if it looks cheap to add. If a slice tempts you to build something listed in "Never
in this plan," stop and re-read spec §21.

---

## Never in this plan (any slice)

The spec's non-goals, restated as implementer tripwires. None of these are "while I'm here" items:

1. **No content or org anything.** No tables, columns, scopes, provider fields, resolvers,
   connectors, or seed data. Both planes exist only as contract names that return
   `plane_unavailable` (spec §5). If a PR adds a file with `content` or `policy` in its name,
   it is out of bounds.
2. **Never rebuild migration `008` tables.** No drop, rename, rebuild, column add, CHECK change, or
   FK toggle on the three tables actually rebuilt by `008`: `memory_records`,
   `memory_retrieval_packs`, and `memory_applicability_indexes`. `memory_record_versions` was
   created by `001`, not rebuilt by `008`, and also remains schema-frozen for this release. Normal
   data writes through the canonical record/lifecycle service are allowed and required. All v2
   schema state is additive (spec §14); CHECK removal is a separate future offline migration.
3. **V1 stays frozen.** V1 endpoints, semantics, and token scopes are unchanged. V1 harness is
   permanent shadow forever; v2 never writes the v1 `prompt_eligible` column (spec §4 invariant
   12, §8). Internal v1 writers must be refactored to call the shared atomic canonical writer; that
   does not change their public contract.
4. **Exact scopes only.** `memory:harness:search`, `memory:harness:receipt:write`,
   `memory:harness:candidate:read`, `memory:harness:review`. `memory:harness:*` must not appear
   anywhere, including tests. The new candidate-read scope is explicit and no new scope is
   provisioned to any existing token (spec §7).
5. **The kind CHECK is never widened.** New subkinds live in v2 facet metadata under the frozen
   mapping: `workflow_strategy -> decision`, `failure_pattern -> anti_pattern`,
   `verification_sequence -> test_strategy`, `tool_constraint | escalation_requirement ->
   constraint`. Unmappable subtypes fail closed (spec §8).
6. **Counts never manufacture authority.** From the moment evidence exists, retries, reruns,
   summaries, tool echoes, and anything sharing a corroboration domain collapse to one observation
   (spec §4 invariant 11, §9).
7. **No prompt or routing influence before slice 8's gate.** Every earlier slice is dark or shadow.
8. **No repo-native rendering, no dreaming changes, no graph or vector database, no new embedding
   infrastructure** (spec §9 delivery boundary, §21).
9. **No speculative generality.** No plugin frameworks, no "generic evidence resolver registry"
   beyond the two resolvers this plan needs, no config surface for planes that cannot be enabled.
   The contract seam is the flexibility; the implementation stays concrete.
10. **No MCP control plane or second memory implementation.** MCP may expose only the safe data
    plane defined below. It never reads the database directly, proxies HTTP or bearer tokens,
    reimplements authorization/ranking/lifecycle, accepts credentials as tool arguments, or
    exposes review/decision, activation, direct attestation adjudication, exposure/release policy,
    token/resource administration, kill-switch, or the broad pod/project/knowledge/admin catalog.

Spec §14 defines the authoritative additive migration order. Because working migrations `012`
through `018` are unregistered and unapplied at plan freeze, renumber the current files to match it
before registration: resources `012`, all facets `013`, packs `014`, scope/feedback `015`, origins
`016`, reverification `017`, and exposure `018`. Verify every target migration ledger first; once
any migration is applied, never repurpose its number. Every migration is additive-only.

The PIM Memory MCP companion follows spec §8. It adds no memory semantics, storage authority,
plane, fallback rule, or Fiesta dependency. HTTP v2 remains the canonical service contract.

---

## MCP companion delivery track (committed; Fiesta remains HTTP)

**Product decision at plan freeze:** PIM will ship the complete safe MCP data plane for MCP-native
coding and harness agents even though no concrete production pilot is yet admitted. This is an
explicit interoperability investment to avoid reopening every slice later. Fiesta remains the
named HTTP consumer and does not gain an MCP client. A named MCP host/team, product and operational
owners, bound resources, threat model, usage expectation, and success measure are still required
before production MCP credentials or tool enablement; “future agents” alone cannot authorize use.

PIM already has two reusable but different MCP foundations: a broad interactive stdio server and a
narrow service-token-protected Streamable HTTP `/mcp` route for hosted skills. The memory adapter
exposes neither catalog. It targets the stateless
[MCP 2026-07-28 protocol](https://blog.modelcontextprotocol.io/posts/2026-07-28/) and current split
TypeScript server SDK. It may reuse the hosted route's token verifier, body/logging/redaction,
rate-limit, audit, and negative-test patterns, but not its legacy initialization/session transport,
organization-wide skill authorization, or loopback HTTP/bearer-token forwarding.

**MCP-A machine-auth checkpoint:** immediately after slice 0, prove that the existing service-token
format and verifier establish an exact repository- or harness-bound principal on the dedicated
`/mcp/memory` Streamable HTTP endpoint; validate token audience/resource indicators and exact
scopes; call shared application services in-process; and pass modern-SDK, required-header,
auth-filtered discovery, negative-authorization, body-limit, private-cache, redaction, and audit
tests. Record whether the endpoint uses the standard
[MCP OAuth client-credentials extension](https://modelcontextprotocol.io/extensions/auth/oauth-client-credentials)
or a deliberately private PIM service-token profile. If this reveals a new identity provider,
credential format, token-issuance project, browser session, or token proxy, rebaseline the MCP
track explicitly. Never weaken the boundary or silently charge that work to the HTTP/harness
contingency.

**MCP-E production enablement gate:** building and staging conformance do not require a named pilot,
but production credential issuance and tool availability do. MCP-E records the concrete consumer
and owners, allowed read/write operations, exact resources/scopes, rate and retention limits,
incident owner, and measurable success criterion.

The shape is:

```text
Fiesta -> generated HTTP client -> /api/v2/memory/*
                                   |
MCP-native coding/harness host -> /mcp/memory
                                   |
                  shared authorization and memory services
                                   |
              canonical record/evidence/audit storage
```

Non-negotiable MCP rules:

1. HTTP v2 remains canonical. MCP uses the same generated schemas and shared application services;
   it owns no storage, authorization, validation, ranking, lifecycle, or fallback behavior. The
   adapter uses the stateless 2026-07-28 request model, `MCP-Protocol-Version`, required
   `Mcp-Method` / `Mcp-Name` headers, and required client `_meta`; it does not recreate legacy
   session IDs or initialization state.
2. Service-principal authentication fixes principal, organization, project, exact scopes, and
   resource bindings before tool dispatch. A standard client-credentials token may have a dedicated
   MCP audience, but it resolves to the same principal, resource bindings, and memory scopes; there
   are no MCP-only authorization semantics, credential arguments, interactive auth tools, or
   caller-supplied tenant/project authority.
3. Inputs may only narrow authenticated authority. One call selects one exact bound repository or
   harness resource; multi-repository results use separate calls and immutable packs. A code query
   includes its independently resolved base SHA.
4. Safe writes are receipts with bounded candidate proposals/evidence handles and pack-bound
   feedback. They cannot review or activate a candidate. Candidate status is read-only and
   non-enumerating; harness producer status is limited to candidates returned for the same
   principal, exact harness resource, and receipt.
5. Every write has a stable caller idempotency key and canonical request digest. Same key/same
   digest returns the original result; same key/different digest conflicts. After an ambiguous
   timeout the client retries the same MCP tool/key and never changes transport.
6. A model may invoke a tool in an MCP-native host, so security never depends on correct model
   behavior. Exact authorization, schema/size/secret validation, evidence resolution, hard filters,
   rate limits, and audit apply before any read or write effect.
7. Unknown fields fail closed. Conformance proves HTTP-equivalent authorization, results, errors,
   idempotency, audit effects, failure semantics, and bounded latency. Content/org have no runtime
   tools while unavailable; cross-plane and mixed-resource fallback are forbidden. Protocol
   discovery and tool/resource lists are authorization-filtered on every request. Record and pack
   resources use private cache scope with a TTL bounded by authorization, freshness, and pack
   expiry; every URI or handle is reauthorized because an identifier is not authority.
8. Record `transport = direct_http | mcp` as a bounded metric dimension for counts, outcomes,
   denials, latency, timeouts, idempotency conflicts, and parity mismatches. Transport is not an
   evaluation arm or memory-eligibility input.

The committed MCP surface lands with the backing HTTP behavior:

| Slice | MCP operation/resource | Backing v2 behavior |
|---|---|---|
| 0 | `pim_memory_capabilities` | known planes, available operations, contract versions |
| 1 | `pim_memory_binding` | authenticated non-secret binding introspection |
| 2 | `pim_code_memory_search` | exact-repository codebase search and immutable v2 pack |
| 2 | `pim-memory://records/{record_id}/versions/{version}` | immutable authorized record detail |
| 2 | `pim-memory://packs/{pack_id}` | immutable authorized retrieval-pack detail |
| 3 | `pim_run_receipt_submit` | idempotent code receipt carrying bounded candidate proposals |
| 3 | `pim_feedback_submit` | idempotent repository/pack-bound feedback |
| 3 | `pim_candidate_status` | non-enumerating code candidate status |
| 4 | `pim_harness_memory_search` | exact-harness shadow search and immutable pack |
| 5 | `pim_run_receipt_submit` harness branch | idempotent harness receipt with evidence handles/candidates |
| 5 | `pim_candidate_status` harness branch | non-enumerating exact-harness candidate status |
| 6 | `pim_memory_readiness` | bounded reverification and worker-health readiness |
| 7 | existing search/pack reads | resulting exposure/audit envelope, never policy mutation |
| 8 | no new operation | final transport conformance kept separate from memory-value evaluation |

Review/decision, activation, direct attestation adjudication, exposure/release-policy mutation,
token/resource administration, kill-switch mutation, and the broad interactive catalog remain
outside the MCP server.

Exact runtime scope mapping is fixed: code search/detail/pack uses `memory:search`; code receipts
and their candidate proposals use `memory:receipt:write`; code feedback uses
`memory:feedback:write`; code status uses `memory:candidate:read`; harness search/detail/pack uses
`memory:harness:search`; harness receipts/evidence handles/candidate proposals use
`memory:harness:receipt:write`; and harness status uses `memory:harness:candidate:read`. Readiness
and exposure/audit data are bounded fields on an already authorized plane read. No safe data-plane
tool accepts `memory:review`, `memory:admin`, or `memory:harness:review` as substitute authority.

---

## Slice 0: v2 contract spine and capabilities (dark)

**Goal (demo):** the generated HTTP client calls the capability service against a live server, and
the in-process/development restricted MCP seam returns the same capability result. Both learn that
four planes are *known* but only codebase and harness operations are *available*; a well-formed
HTTP content search returns a bounded `plane_unavailable` error and provably creates no record,
pack, receipt, or authorization side effect.

**Depends on:** nothing.

**In scope**

- Server-owned v2 JSON Schemas: common envelope, the four plane discriminants, stable
  codebase/harness applicability, `v2alpha1`-marked provisional content/org applicability
  (names only, no provider fields), typed `scope_snapshot` union, error envelope (spec §5, §8).
- Generated TS/Python artifacts and fixtures; unknown-field rejection at every trust boundary.
- `GET /api/v2/memory/capabilities` distinguishing known planes from available operations and,
  for each operation, canonical HTTP availability, restricted MCP exposure, or MCP control-plane
  exclusion. The HTTP and MCP capability calls return the same domain result.
- Deterministic `plane_unavailable` behavior with a side-effect-free test proving zero writes.
- Freeze all record/candidate/receipt/feedback facet schemas, the complete safe MCP tool/resource
  schemas, and stable harness-only root-origin/derivation handles. The handle schema includes the
  fields PIM uses to bind producer principal and corroboration domain; it does not change
  `fiesta.code-evidence.v2`.
- Freeze the exact harness scope strings and the subkind facet mapping as constants with tests
  that reject `memory:harness:*` and unmappable subtypes.
- Reconcile the in-flight foundation before treating it as implementation: add
  `memory:harness:candidate:read` to constants/generated contracts, remove the current
  candidate-read-to-review substitution, export generated v2 types from `@pim/shared`, and keep
  migrations `012`-`018` unregistered until their Slice-1 numbering and backfill tests are ready.
- Restricted in-process/development modern PIM Memory MCP profile, protocol discovery, generated
  MCP schemas, and `pim_memory_capabilities`, all delegating to the same capability service as
  HTTP. Domain capabilities carry the transport-surface distinction; separate protocol discovery
  remains authorization-filtered and lists only the MCP operations actually exposed. Its tool list
  contains no existing
  pod/project/knowledge/auth/admin operations. This is the first committed companion operation,
  but it exposes no memory data.

**Out (bounds)**

- No new tables, no migrations, no search, no binding endpoint, no registry.
- No content/org applicability detail beyond discriminant names.
- No SDK conveniences beyond generated types; no MCP operation beyond capabilities; no production
  `/mcp/memory` endpoint, authentication, or memory-data access.

**Code areas:** `packages/shared/contracts/` (new v2 schema + generation alongside
`memory-contracts.v1.schema.json`), new `packages/server/src/services/memory-v2-capabilities.ts`,
new `packages/server/src/routes/memory-v2-capabilities.ts`, `packages/sdk` (generated types only),
and a restricted modern-protocol entrypoint under `packages/mcp-server` that does not register the
broad existing tools. Existing v1 capability service/route files stay byte-identical.

**Exit tests:** live HTTP plus in-process MCP capability parity, including canonical-HTTP,
restricted-MCP, and excluded-control-plane distinctions; `server/discover` and restricted,
authorization-filtered `tools/list` / `resources/list`; required-header behavior; unknown
plane/field/version rejection; content and org searches fail closed with no side effects; v1
capabilities and routes byte-identical to before.

---

## Slice 1: resource registry, facets, atomic writers, and binding introspection

**Goal (demo):** every existing repository and harness authority row is projected one-to-one into
the generic resource registry; `GET /api/v2/memory/binding` and `pim_memory_binding` return the
caller's equivalent non-secret effective binding; the single authorization primitive answers
`principal + operation + plane + project + resource_row_id -> allow | deny` and every cross-tenant,
cross-project, cross-plane, and cross-resource negative control passes. With writers stopped, every
existing canonical object receives its losslessly derivable facet; after reopening, a simulated v1
write creates its canonical row and facet atomically or creates neither.

**Depends on:** slice 0.

**In scope**

- Migration `012` (additive): resource rows (`repository` and `harness` types only), alias rows,
  immutable service-token resource bindings (spec §6, §14.1-2).
- Migration `013` (additive): record, candidate, receipt, and feedback facet tables for all
  implemented planes. The tables exist before any v2 read/write route; plane-specific serving still
  waits for its reconciliation gate.
- Plan-freeze premise, to reverify against production metrics and the migration ledger immediately
  before cutover: the canonical v1 store contains only the newly migrated KG data, has had no
  subsequent consumer read/write traffic, and has no applied `012`-`018`. Stop writers, take the
  normal recoverable backup, backfill, reconcile, then reopen. If any premise is false, stop and
  design an explicit online cutover rather than improvising dual writes.
- Backfill from `memory-repository-registry.ts` and `memory-harness-bindings.ts` with
  row-count, identity, FK, and active-pointer reconciliation; v1 authority tables remain the
  source of truth and are not rewritten.
- Backfill every losslessly mappable canonical record/candidate/receipt/feedback facet. Missing or
  ambiguous plane/resource/subtype data is quarantined and fails v2 closed; the migration never
  guesses a subtype merely to reach a count.
- Shared transaction-owning canonical services for repository registration, harness binding, token
  binding, records, candidates, receipts, feedback, idempotency, and outbox effects. Surviving v1
  and new v2 adapters call these services; no asynchronous projection job or CDC is introduced.
- Before reopening writers, inventory every direct core-table write in the repository registry,
  harness binding, record, harness-record, candidate, receipt, feedback, and activation services.
  Every surviving entry point must delegate to the shared transaction-owning service; an unused v1
  entry point that cannot do so remains closed. The inventory and its disposition are an exit
  artifact, not an assumption based only on the one-time backfill.
- The one authz primitive in `middleware/service-authz.ts` and `services/service-tokens.ts`,
  resolving existing scopes through it without changing what any existing token can do.
- Recognize the newly frozen exact `memory:harness:candidate:read` scope for explicit future token
  issuance and exact harness binding; never infer it from receipt/review scopes or add it to an
  existing token.
- Registration/token-binding rejection for `content_space` and `policy_domain` (spec §6).
- `GET /api/v2/memory/binding`: non-secret introspection, never enumerating outside the principal.
- Complete MCP-A; add service-token authentication on `/mcp/memory` and
  `pim_memory_binding`, both delegating to the same verifier, resource bindings, and binding service
  as HTTP without interactive org selection or credential arguments. Use the modern stateless SDK,
  authorization-filter discovery, validate audience/resource indicators, and record the standard
  client-credentials versus private-token-profile decision.

**Out (bounds)**

- No additional new scope beyond `memory:harness:candidate:read`; no token auto-issuance or
  widening, admin CRUD/UI, rename/transfer tooling beyond required aliases, or fuzzy matching.
- No search or intake wired to the primitive yet; no token passthrough, auth proxy, browser auth,
  or broad PIM MCP catalog.
- No asynchronous projection daemon, CDC stream, online dual-write interval, or second source of
  truth. Unused v1 writers that cannot call the shared transaction remain closed.

**Code areas:** migrations `012` and `013`; `middleware/service-authz.ts`;
`services/service-tokens.ts`; new v2 registry, facet, and canonical-write services; binding route;
restricted modern MCP auth/context adapter; and hosted-MCP security-pattern tests only. Renumber
the current unregistered pack/scope/facet working files before registering any migration.

**Exit tests:** resource and facet backfill reconciliation (counts, digests, FKs, active pointers,
one-to-one); `foreign_key_check` and `integrity_check`; simulated new v1 repository/harness/token/
record/candidate/receipt/feedback writes create required companions in the same transaction;
injected companion failure rolls back the core row, idempotency row, and outbox effect; full §7
denial matrix over HTTP and MCP; binding introspection parity/redaction; MCP calls cannot select or
escape their authenticated org/project/resources; body/auth logging suppressed; content/org
registration rejected; existing v1 public-contract and authz suites unchanged and green. If MCP-A
discovers a separate identity project, record the rebaseline: the HTTP core may exit, but the slice
remains MCP-incomplete.

---

## Slice 2: codebase read path on v2 (parity)

**Goal (demo):** `POST /api/v2/memory/search` and `pim_code_memory_search` return equivalent
codebase results for the bound repository and independently resolved base SHA behind the slice-1
primitive, echo tenant/plane/resource/request/pack IDs, record the pack in the new v2 ledger, and
pass the v1 parity suite.

**Depends on:** slice 1.

**In scope**

- v2 search route dispatching exactly one plane; codebase delegates to the existing
  `services/memory-search.ts` internals unchanged behind the new authz + envelope.
- Codebase record-facet reconciliation reaches 100% before the route opens. V2 detail and search
  require the matching facet through a fail-closed join; a missing, ambiguous, wrong-plane, or
  wrong-resource facet returns a bounded consistency error and never falls back to v1 output.
- v2 immutable record detail/history with the same binding enforcement as v1.
- Migration `014` (additive): v2 retrieval-pack and pack-item ledgers (spec §14); codebase packs
  written there with request digest, effective binding, versions, eligibility, expiry.
- `pim_code_memory_search` plus authorized immutable record/pack resources, delegating to the same
  search/detail services. MCP input omits tenant/project and requires an exact repository selector
  when the credential has multiple bound repositories.
- Parity harness running the existing v1 quality/security/idempotency/latency/outage suites
  against HTTP v2 and MCP (spec U1), including structured MCP error mapping.

**Out (bounds)**

- Zero ranker, selector, budget, or scoring changes; if v2 needs a behavior change to pass parity,
  that is a finding, not a patch.
- No harness search, no temporal modes beyond `current`, no receipts, no model-autonomous memory
  invocation.
- V1 search route untouched.

**Code areas:** new `routes/memory-v2-search.ts` handler (do not fork the service),
`services/memory-records.ts` (read-only detail reuse), v2 facet service, migration `014`, restricted
MCP tools/resources, and parity test harness. Existing v1 search route stays byte-identical.

**Exit tests:** v1-vs-HTTP-v2-vs-MCP parity on results, packs, errors, audit effects, and latency
envelope; idempotent search replay and mismatch conflict; envelope echo validation; denial matrix;
multi-repo calls create separate packs with their own base SHA and cannot be blended; seed an
intentionally facetless low-level fixture in an isolated test database and prove both HTTP and MCP
v2 fail closed without returning the corresponding canonical record.

---

## Slice 3: codebase write path on v2 (parity)

**Goal (demo):** an idempotent v2 run receipt with a typed codebase `scope_snapshot` round-trips
through the same ledger over HTTP and MCP; feedback binds to a v2 pack and is rejected
cross-pack/cross-resource; a bounded candidate proposal flows through the existing governed
machinery and its status is readable without exposing review or activation.

**Depends on:** slice 2.

**In scope**

- `PUT /api/v2/memory/run-receipts/:producer_run_id` mapping the typed codebase snapshot onto the
  existing receipt service; replay idempotency preserved.
- v2 feedback validated against v2 packs (plane, resource, record version, snapshot digest).
- v2 candidate intake/status/decisions as thin adapters over `memory-candidates.ts`,
  `memory-decisions.ts`, `memory-activation.ts`.
- Candidate, receipt, and feedback facet reconciliation reaches 100% before the corresponding v2
  operation opens. Both surviving v1 intake and v2 intake use the slice-1 canonical transactions;
  no acknowledged object can exist without its required facet.
- MCP `pim_run_receipt_submit` (codebase branch), `pim_feedback_submit`, and read-only
  `pim_candidate_status`, delegating to the same services. Candidate proposals travel inside the
  receipt; MCP exposes no standalone ungoverned proposal or decision path.
- Stable receipt and feedback idempotency keys/digests across transports. After an ambiguous MCP
  timeout, retry the same tool/key; a payload mismatch conflicts and transport switching is
  forbidden.
- Migration `015` (additive): typed scope-snapshot and feedback-binding companion rows.

**Out (bounds)**

- No changes to activation logic, evidence resolvers, or the structural validator. MCP exposes no
  review/decision, activation, direct attestation, policy, or administrative tool.
- No harness snapshots or harness intake.
- V1 receipt/feedback routes untouched; existing outbox/acknowledgement semantics unchanged.

**Code areas:** v2 receipt/feedback/candidate routes as adapters over existing services;
`memory-receipts.ts` and `memory-feedback.ts` touched only where snapshot typing requires;
migration `015`; restricted MCP receipt/feedback/status adapters and cross-transport conformance
fixtures.

**Exit tests:** v1-vs-HTTP-v2-vs-MCP receipt/feedback/candidate-status parity; same-key replay and
different-payload conflict; ambiguous-timeout retry on MCP without transport switching; cross-pack
and cross-resource feedback rejection; candidate status is non-enumerating and pre-activation
candidates remain non-searchable; secret/PII/oversize rejection on both v2 transports; a new v1
receipt/candidate/feedback fixture creates the same required facets atomically and an injected facet
failure acknowledges nothing.

---

## Slice 4: harness read path in shadow on v2

**Goal (demo):** a harness-bound token searches `plane: harness` through HTTP v2 and MCP, receives
equivalent existing harness records through the common dispatcher with the spec §9 hard-filter
order, writes shadow packs to the v2 ledger, and leaves the v1 harness endpoint byte-identical.

**Depends on:** slice 2 (dispatcher), slice 1 (bindings).

**In scope**

- Complete the harness facet backfill and subtype mapping using the slice-1 tables and frozen
  mapping, without copying claim content. A broad v1 kind that has no unique inverse subtype is
  quarantined rather than guessed; v2 harness serving remains closed until every served row
  reconciles. An empty harness backfill is a valid, explicitly recorded result.
- Harness dispatch in the v2 search route using `memory-harness-search.ts` retrieval logic behind
  the common hard-filter order; harness selectors (workflow/configuration/stage/model/tool) from
  the existing columns.
- `pim_harness_memory_search` as a plane-specific MCP adapter over the same dispatcher.
- v2 harness immutable detail.
- All v2 harness packs written with shadow eligibility; nothing prompt-eligible.

**Out (bounds)**

- No intake, activation, evidence, or exposure state.
- No new harness selectors beyond what harness records already carry.
- V1 harness route and its permanent-shadow columns untouched.

**Code areas:** v2 facet/backfill service, v2 search dispatcher,
`services/memory-harness-search.ts` (read reuse only), and restricted harness-search MCP adapter.

**Exit tests:** harness facet backfill reconciles one-to-one for every served canonical record and
ambiguous mappings fail closed; HTTP/MCP hard-filter, result, error, audit, and latency parity with
cross-scope traps; harness packs are provably shadow; code and harness MCP selectors cannot cross;
v1 harness suite remains unchanged.

---

## Slice 5: harness intake with origin-bound evidence

**Goal (demo):** equivalent HTTP and MCP producer fixtures submit a harness receipt with a typed
snapshot and one candidate carrying runtime-evidence handles; PIM binds an authenticated root
origin and assigns `corroboration_domain_id`; a retry of the same producer provably collapses to
the same domain without manufacturing a repeated-outcome signal; independently verified outcomes
from distinct approved producer/corroboration domains may produce a review-only signal, never
activation; an authorized control-plane review activates the record into harness shadow search.

**Depends on:** slices 3 and 4.

**In scope**

- Harness `scope_snapshot` on v2 receipts; harness candidates through existing idempotent intake.
  The shared HTTP/MCP schema adds harness-only origin/derivation handles and does not change
  `fiesta.code-evidence.v2`.
- Enable the harness branch of `pim_run_receipt_submit` and the producer-bound harness branch of
  `pim_candidate_status`. Evidence handles and candidates travel inside the receipt; the MCP tool
  cannot self-declare authority, review, or activate them.
- Runtime-attestation evidence resolver recording origin ID, digest, provider identity, producer
  principal, occurrence/verification time, derivation parents (spec §9).
- Migration `016` (additive): origin/derivation/corroboration-domain state.
- Origin collapse: retries, reruns, summaries, tool echoes, descendants of one root, and multiple
  roots in one domain count once. A reviewed repeated-outcome signal requires observations from
  independent producer runs bound to distinct approved corroboration domains; repeats from one
  producer never qualify. Even qualifying repeated outcomes create a review-only signal;
  activation is `independently verified runtime or authorized review` only (spec §9 activation
  table).
- Activation writes harness shadow searchability via the existing activation service plus facets;
  no exposure state.

**Out (bounds)**

- **No quorum policy.** The Sybil-resistant origin-quorum is explicitly future work; building it
  now is over-engineering. Review-only is the shipped behavior.
- No second evidence resolver type; no generic resolver framework.
- No direct MCP attestation-adjudication, review, decision, or activation tool.
- No prompt/routing/exposure state of any kind.

**Code areas:** new `services/memory-v2-runtime-attestations.ts` (runtime resolver),
`memory-activation.ts` (harness policy branch), `memory-structural-validator.ts` (harness dispatch),
migration `016`, and restricted MCP harness receipt/status adapters. The existing large v1
`memory-attestations.ts` implementation remains separate.

**Exit tests:** HTTP/MCP harness-receipt, candidate-result, and producer-bound status parity;
same-key replay, different-payload conflict, and ambiguous MCP timeout retry; origin-collapse suite
(changed `producer_run_id`, derived artifacts, multi-root single-domain all count once and do not
create a repeated-outcome signal); independent-domain runs may open review but repeated outcomes
cannot activate; cross-principal or cross-harness candidate status is non-enumerating;
activated record retrievable in slice-4 shadow search; candidate remains non-searchable
pre-activation; code evidence fixtures remain byte-identical.

---

## Slice 6: scheduled reverification loop (shadow)

**Goal (demo):** every activated harness record and prompt-policy-relevant codebase record carries
a resolver policy with `last_verified_at` / `next_reverify_at`; the worker rechecks evidence on
schedule and records an immutable decision. On contradiction, withdrawal, expiry, or grace-period
exhaustion it invokes the canonical lifecycle transition and removes v2 influence in the same
transaction, so neither v1 nor v2 continues serving the retired active version. HTTP/MCP expose
equivalent bounded readiness while a simulated provider outage leaves records pending and then
fails them closed, never silently fresh (spec §9 reverification).

**Depends on:** slice 5.

**In scope**

- Migration `017` (additive): five new tables for reverification policies, per-version state,
  immutable decisions, jobs, and job attempts; it adds no columns to migration-`008` tables.
- Scheduler worker with retry, dead-letter, and the metrics in spec §15 (due/attempt/success/
  failure/dead-letter age, source-withdrawal lag).
- `GET /api/v2/memory/readiness` reporting bounded reverification capability/health for Fiesta; it
  exposes no raw jobs, evidence bodies, mutation, or administrative controls.
- `pim_memory_readiness` exposing the same bounded read model through MCP with equivalent binding,
  redaction, and failure semantics.
- Freeze and test the canonical outcome mapping: contradiction or authoritative withdrawal retires
  to `revoked`; effective-time expiry retires to `expired`; unresolved grace exhaustion retires to
  `stale`, unless an explicitly stricter plane policy selects `revoked`.
- The worker compares expected reverification `state_version` and canonical record version before
  committing. The immutable decision, v2 state/influence change, and canonical lifecycle transition
  commit atomically; a stale worker or any failed write changes nothing.
- Kill-switch interaction: pausing the worker never marks anything fresh.

**Out (bounds)**

- Scope is influence-relevant records only; no full-store sweeps, no batch re-embedding, no LLM
  anywhere in the loop.
- No consolidation, merging, or rewriting of claims; this loop verifies and retires, it does not
  author.
- No direct write to v1 `prompt_eligible`. V1 suppression comes from its existing
  `current_status = 'active'` lifecycle filter.
- Nothing here renders to prompts; eligibility state has no consumer until slice 7.

**Code areas:** `services/memory-v2-reverification.ts` (worker), `services/memory-records.ts`
(transaction-aware composition of the existing canonical lifecycle transition), migration `017`,
`memory-metrics.ts`, and the restricted MCP readiness adapter. Do not add a second direct record-
status writer in the worker.

**Exit tests:** schedule/overdue/grace behavior; contradiction, withdrawal, and expiry drills for
both codebase and harness; outage pending-then-fail-closed; dead-letter aging; stale-worker CAS
conflict; injected failure proves the decision/state/lifecycle transaction rolls back; a retired
codebase record disappears from both v1 and v2 active reads; HTTP and MCP readiness parity/redaction;
zero prompt/routing exposure effect beyond the required canonical lifecycle safety transition.

---

## Slice 7: v2 exposure policy, gates, canary, kill switches (dark)

**Goal (demo):** per-plane/resource exposure policy exists as v2-only state; a deterministic
canary assignment is computable; independent prompt and routing kill switches flip state and are
drillable; a v2 audit pack carries exposure snapshot, policy revision, gate decision, and
reverification state through equivalent HTTP/MCP reads; no MCP tool can mutate that control state,
and none of it changes a response because every gate is closed.

**Depends on:** slice 6 (reverification state is an input), slice 4 (packs).

**In scope**

- Migration `018` (additive): v2 exposure-policy, gate-decision, canary, and kill-switch state
  (spec §14 storage model and §16 implementation map); v2 exposure state as the sole authority for
  v2 eligibility.
- Extend `memory-prompt-policy.ts` / `memory-release-gates.ts` patterns to plane/resource keyed
  v2 state for both codebase and harness without touching v1 policy rows. V1 policy remains
  authoritative only for v1 reads; v2 policy is authoritative for v2 reads.
- Audit-pack assembly: packs record the exposure decision inputs at retrieval time.
- Existing MCP search results and immutable pack resources return the same read-only exposure/audit
  envelope as HTTP. No MCP operation mutates policy, gates, canaries, or kill switches.
- Kill-switch drill procedure (documented and scripted).

**Out (bounds)**

- Nothing enabled; no benchmark; no UI; no org-wide policy surface.
- V1 prompt policy for codebase continues to govern v1 behavior untouched.

**Code areas:** migration `018`, prompt-policy and release-gate services (v2 branches), pack
assembly in the v2 search path, and MCP search/pack exposure-envelope serialization parity.

**Exit tests:** with all gates closed, HTTP/MCP v2 search and pack exposure/audit envelopes are
equivalent to slice 6; canary determinism; kill-switch flip visible through read-only MCP packs;
v1 harness packs can never satisfy a v2 exposure check; no control-plane MCP tool is discoverable.

---

## Slice 8: harness earns influence (benchmark and enablement)

**Goal (demo):** the predeclared harness benchmark runs its four arms (normal-budget no-memory
baseline; no-memory control with the same total inference-token and permitted actor-step budget as
the memory arm; shadow; deterministic canary) under the predeclared repetition and confidence
rules; reverification health is green; rollback and both kill switches are drilled; and prompt or
routing influence turns on only through slice-7 state, or the plane remains shadow and the release
is still complete.

**Depends on:** slices 5, 6, 7.

**In scope**

- Benchmark definition and adjudication per spec §12, declared before results are observed.
- Run the Fiesta value experiment over canonical HTTP. Complete the MCP transport-conformance,
  authorization, idempotency, failure-semantics, audit, and latency report separately; never
  multiply transport into the four memory arms.
- Metric plumbing only: no new platform machinery. If the benchmark reveals missing machinery,
  that is a new slice, not scope creep here.
- Gate decision recorded through slice-7 state; canary rollout with rollback drill.

**Out (bounds)**

- No threshold tuning after observing results; the decision rule for inconclusive outcomes was
  predeclared.
- No expansion beyond the benchmarked workflow subset.
- Failure to pass leaves harness in shadow permanently without reopening earlier slices.

**Exit tests:** spec §20 acceptance criteria for harness influence, including the budget-matched
control, reverification-health precondition, and kill-switch drills; complete HTTP/MCP safe
data-plane conformance report with zero boundary divergence. MCP-E may remain closed until a named
production pilot exists, but the adapter and staging conformance cannot remain incomplete.

---

## Sequencing

```text
0 -> 1 -> 2 -> 3
          2 -> 4 -> 5 -> 6 -> 7 -> 8
```

Slices 3 and 4 can run in parallel after slice 2. Slice 7 can start once slice 6's state shape is
frozen. Nothing after slice 1 blocks Fiesta's FU0; FU1 needs slices 2-3; FU2 needs slices 4-6;
FU3 needs slices 7-8.

| Slice | Rough size |
|---|---|
| 0 | 4-6 days |
| 1 | 6-9 days, including the stopped-writer facet cutover rehearsal |
| 2 | 5-7 days |
| 3 | 4-6 days |
| 4 | 3-5 days |
| 5 | 5-7 days |
| 6 | 5-7 days |
| 7 | 3-5 days |
| 8 | 3-5 days plus benchmark runtime |

These are planning hints, not commitments. They include the complete safe MCP companion and assume
the hosted-MCP verifier/security patterns—but not its legacy transport/session implementation—are
reusable, PIM and Fiesta run in parallel, and MCP adds no Fiesta work. The no-traffic facet cutover
removes online-migration machinery, but the modern MCP adapter and canonical lifecycle retirement
add explicit correctness work. The plan can remain near the upper edge of the 4-8 week envelope
only if MCP-A does not uncover a separate identity project. If it does, rebaseline the MCP track
rather than cutting authorization, idempotency, failure-semantics, audit, or conformance tests; the
HTTP release train may continue, but the platform is not MCP-complete.

## Mapping to spec phases

- Slice 0-1 = U0. Slices 2-3 = U1. Slices 4-6 = U2. Slices 7-8 = U3.
- C0-C2 and O0 have no slices here by design. If someone asks for a content slice, the answer is
  the C0 admission checklist in spec §19, not a branch.

## Fiesta implementation impact

The complete PIM MCP companion does not change Fiesta's committed FU0-FU3 path:

- Fiesta keeps its generated v1/v2 HTTP clients. P1/P2 and FU0-FU3 do not add
  `PimMemoryTransport`, an MCP client, transport selection, or MCP fallback.
- Fiesta remains responsible for resolving tenant, project, repository, base SHA,
  harness/workflow identity, and `identity_status` before every HTTP call. Its deterministic
  coordinator validates each returned pack before prompt composition.
- FU1 performs v1-versus-v2 HTTP parity. FU2 remains the net-new Fiesta harness adapter over HTTP;
  harness-only origin/derivation fields enter there and `fiesta.code-evidence.v2` stays unchanged.
- FU3 runs the four-arm harness value benchmark over canonical HTTP. A separate MCP-native pilot
  cannot alter its arms, thresholds, gate result, or release timing.
- PIM unavailability still degrades to no new memory rather than blocking Fiesta work, and no
  cross-plane or cross-resource fallback is added.
- If a future proposal makes Fiesta itself an MCP-native consumer, it must name a concrete benefit
  beyond transport substitution and be admitted as separate follow-on work; this plan does not
  pre-authorize it.
