# Fiesta changes for universal-ready PIM memory

> **Superseded design plan.** Current Fiesta implementation requirements are in
> [PIM_TO_FIESTA_IMPLEMENTATION_HANDOFF.md](./PIM_TO_FIESTA_IMPLEMENTATION_HANDOFF.md).

**Status:** historical proposed implementation plan
**Owner:** Fiesta harness
**Companion:** [PIM changes for a universal-ready Fiesta memory platform](./UNIVERSAL_MEMORY_PLATFORM_PIM_CHANGES.md)
**Baseline:** finish the current checkout-bound codebase P1/P2 integration first. Preserve shadow
mode, the generated v1 client, and existing behavior while v2 is built additively.

## 1. Executive decision

Fiesta should finish P1/P2, then generalize the proven seam instead of restarting or extending the
repository-shaped design into every workflow.

The initial Fiesta commitment is:

1. keep the current codebase integration as a compatibility implementation;
2. prove codebase behavior on the v2 common contract;
3. complete one harness/workflow memory adapter end to end, initially with no prompt or routing
   influence;
4. consume v2-only exposure/audit state and enforce scheduled-reverification status before harness
   memory can earn prompt or routing influence;
5. leave a typed, disabled content adapter seam and a deterministic unavailable path;
6. defer real content and organization integration until authoritative providers, demand,
   governance, and benchmarks exist.

This is not a four-plane big-bang rollout. Fiesta understands a common memory lifecycle and asks
PIM which plane operations are actually available. Initially, only codebase and harness are built.

## 2. Fiesta's product boundary

Fiesta owns:

- live orchestration, retries, interrupts, and terminal outcome;
- LangGraph checkpoint and resume;
- task/run identity;
- current checkout, source assets, provider context, and workflow configuration;
- local validation against current authoritative state;
- the final prompt/routing exposure decision;
- durable receipt delivery through its outbox.

Fiesta does not:

- decide that a proposed lesson is active truth;
- claim a merge, publication, approval, policy revision, or runtime attestation it cannot prove;
- copy checkpoints, full transcripts, hidden reasoning, or source assets into PIM;
- use PIM as a Git store, CMS, DAM, brand graph, policy system, or workflow engine.

## 3. Ownership hierarchy and memory meaning

Every Fiesta/PIM memory interaction is organization-owned and normally project-bound:

```text
organization
  -> project
    -> plane
      -> exact resource
        -> record versions and retrieval packs
```

The future `org` plane means governed cross-workflow policy; it does not mean that other planes are
outside organization isolation.

The plane decision can be made with four questions:

- Is the lesson about repository implementation? Use `codebase`.
- Is it about how Fiesta should execute, recover, verify, or escalate? Use `harness`.
- Is it about the suitability of generated output for a content context? Use future `content`.
- Is it a mandatory organization-wide rule? Use the authoritative policy system and, if admitted,
  the future `org` plane.

Harness memory is durable operational know-how about Fiesta. Examples include:

- resume from validation after a publishing timeout to avoid duplicate side effects;
- run accessibility evaluation before localization;
- reject an incompatible workflow/adapter/configuration combination;
- recognize a known failure fingerprint;
- require a human approval before a specific tool action.

It is not a transcript, model trace, checkpoint, retry counter, or live workflow state.

## 4. Non-negotiable invariants

1. Every PIM call occurs after Fiesta resolves authoritative runtime context for that plane.
2. Credential metadata is the authorization ceiling. Ticket, caller, configuration text, and model
   output cannot establish or widen a binding.
3. Fiesta independently resolves the actual resource and compares it with the credential binding.
4. Each search requests one available plane and preserves a separate retrieval pack.
5. Empty, failed, or unavailable retrieval never falls back to another plane.
6. PIM is optional for task execution; an outage degrades memory, not Fiesta readiness.
7. Malformed, cross-boundary, incompatible, stale, or unvalidated records never reach a model or
   routing decision.
8. Current authoritative state and deterministic policy override advisory memory.
9. Candidate extraction never activates a lesson or sends hidden reasoning, credentials, or
   unbounded source data.
10. Activation, prompt exposure, and routing influence are separate gates with independent
    switches.
11. Code retains its repository/SHA validation, ranker inputs, and regression suite.
12. Content and org create no search, receipt, candidate, prompt, or storage effect while PIM
    advertises them unavailable.
13. V1 harness search remains permanent shadow. Fiesta may expose harness memory to a prompt or
    route only from a v2 pack carrying independently validated v2 exposure state.
14. A producer run ID is correlation, not independent authority. Retries, reruns, summaries, tool
    echoes, descendants of one root origin, and multiple roots controlled by one producer or
    corroboration domain count as one independent observation.
15. Fiesta enforces read-time freshness, but PIM's healthy scheduled-reverification loop is a
    prerequisite for any prompt/routing influence.

## 5. Typed memory scope contexts

Introduce a strict `MemoryScopeContext` discriminated union. Codebase and harness are stable v2
variants. Content and org remain provisional, disabled adapter contracts until admitted.

### 5.1 Codebase context

```text
plane: codebase
project_id
repository_id
base_sha
checkout_root (runtime-only; never sent to PIM)
components / paths / symbols / task_class
identity_status
```

Repository identity comes from a trusted remote and the full SHA from the pinned checkout.

### 5.2 Harness/workflow context

```text
plane: harness
project_id
harness_id / harness_version
workflow_id / workflow_version
adapter_version
configuration_ids / configuration digest
stage_id
model_ids / tool_ids
identity_status
```

This is the first non-code context implemented end to end. It supports arbitrary Fiesta workflows
without pretending they have repositories.

### 5.3 Future content context

```text
plane: content
project_id
content_space_id
brand / product / audience / channel / locale selectors
content type / campaign selectors
source_refs: provider + immutable resource ID + revision/digest
identity_status
```

The exact provider-facing schema remains provisional until a real consumer validates it. A task
may request a locale or channel, but only trusted configuration and authoritative provider metadata
can turn those values into a memory scope.

### 5.4 Future organization-policy context

```text
plane: org
project_id
policy_domain_id
audiences / jurisdictions
policy_revision / effective_at
identity_status
```

Organization policy memory is advisory current-context guidance, never a replacement for the
authoritative policy system or mandatory local gates.

## 6. Credential binding model

Generalize non-secret `PimCredentialBinding` metadata into:

```text
credential_ref
organization_id
project_id
resources[]:
  plane
  resource_type
  canonical_resource_id
  optional immutable provider resource ID
  permitted operations
```

The token secret stays separate from logs, state, receipts, and outbox rows. Binding resolution is:

```text
credential resource == independently resolved runtime resource
```

A mismatch disables memory for that plane and emits a bounded security signal. Fiesta never asks a
model to choose or fuzzy-match an identity.

Keep `repository_ids` compatibility for the current v1 code path. V2 consumes generic non-secret
metadata or PIM binding introspection. The existing code token keeps its current repository-bound
permissions; content or org permissions are not added speculatively.

The exact implemented/planned scope strings are:

- `memory:search`, `memory:receipt:write`, `memory:candidate:read`, and
  `memory:feedback:write` for repository-bound codebase operations;
- `memory:harness:search`, `memory:harness:receipt:write`,
  `memory:harness:candidate:read`, and `memory:harness:review` for exact
  project/principal/harness-bound operations.

`memory:harness:*` is never a real scope. A single credential may contain several exact scopes and
resource bindings only when PIM intentionally provisions them; Fiesta does not infer a wildcard
from a shared prefix. The runtime must not receive `memory:harness:review` unless it actually owns
an authorized reviewer flow. `memory:harness:candidate:read` is new for the full safe data-plane
commitment and is never inferred from receipt or review permission or added to an existing token.

## 7. Plane-specific version anchors

There is no universal `base_sha`:

| Plane | Current-state anchor resolved by Fiesta |
|---|---|
| Codebase | full Git base SHA and candidate tree/diff identities |
| Harness | harness/workflow/adapter versions and configuration digest |
| Content, future | authoritative asset/document revisions and digests |
| Org, future | policy revision and effective time |

An anchor is not authorization. It records the exact state against which Fiesta validated and used
a memory. Fiesta derives it from authoritative runtime state; operators do not type it into normal
runs.

## 8. Adapter model and content boundary

Each implemented workflow adapter can:

1. resolve authoritative scope;
2. produce bounded search selectors;
3. validate returned applicability and version anchors;
4. create bounded evidence references;
5. propose typed candidates;
6. summarize terminal outcome for the receipt.

For every evidence reference, an adapter also preserves the trusted provider event/reference,
digest, occurrence time, producer principal context, and derivation parent handles needed for PIM
to bind an authenticated root origin. Fiesta cannot self-declare a trusted authority domain.
Retries reuse their correlation and origin handles; changing `producer_run_id` does not create an
independent witness. Multiple events or roots from the same PIM-assigned
`corroboration_domain_id` may prove recurrence but do not provide independent corroboration.
This producer behavior supports the origin-bound, Sybil-resistant threat model described in
[TMA-NM](https://arxiv.org/abs/2606.24322); Fiesta never asks a model to decide whether two origins
are independent.

Adapters are versioned and registered. An unknown or unavailable adapter disables that plane rather
than emitting an untyped payload.

The initial content seam is an interface and disabled configuration, not a content store or
provider connector. If content is later admitted, Fiesta must fetch current brand voice,
terminology, product facts, approved claims, legal rules, and policy directly from their
authoritative systems during generation.

PIM content memory initially contains only run-derived learning, such as:

- rejected output patterns and their verified reasons;
- recurring evaluation failures;
- channel, locale, publishing, template, or tool limitations;
- corrective strategies that repeatedly passed evaluation.

Fiesta must not send full prior drafts or mirror authoritative brand documents into PIM. A lesson
about orchestration or recovery belongs in harness even if it occurred during content generation.

## 9. Runtime and search ordering

Every enabled memory interaction follows:

```text
resolve stable producer_run_id and trusted run configuration
  -> resolve authoritative runtime resource and version anchor
  -> resolve non-secret credential metadata
  -> compare runtime resource with credential resource
  -> negotiate PIM capabilities and operation availability
  -> issue one explicit search per enabled and available plane
  -> validate tenant, project, plane, resource, request, and pack envelope
  -> fetch immutable record details
  -> validate records against current authoritative state and PIM reverification status
  -> retain bounded dispositions and pack identities
  -> optionally render an independently gated prompt block
  -> execute the workflow normally
  -> create bounded evidence/candidates if enabled
  -> commit one terminal receipt to the durable outbox if enabled
```

Independent searches may run concurrently only after all participating scopes are verified. Their
results, budgets, feedback, and prompts remain separate.

Use the generated v2 client only for operations advertised by capabilities. Continue using v1 for
code until v2 parity. If content or org is unavailable, record a bounded availability status and do
not send a search, receipt, candidate, or generic fallback request. Treat PIM's bounded
`plane_unavailable` response as an expected fail-closed capability result, not as permission to
retry through another plane or endpoint.

The initial Fiesta release uses the generated HTTP clients only. Do not add an MCP client,
`PimMemoryTransport`, runtime transport selection, or MCP fallback merely for protocol symmetry.
PIM's complete safe MCP data-plane companion is a separate surface for MCP-native consumers and
cannot block FU0-FU3 or add Fiesta implementation work. Fiesta records outbound telemetry with
bounded `transport = direct_http` and `contract_version = v1 | v2`; neither value changes
authorization or evaluation-arm assignment. A future proposal to make Fiesta an MCP consumer must
name a concrete benefit beyond replacing HTTP and pass the PIM MCP-E production-enablement gate.

Before consuming a pack, validate HTTP/content/schema limits, request and pack IDs, echoed tenant
and binding, item/token limits, unique immutable record versions, lifecycle, classification,
compatibility, and detail identity. A boundary mismatch rejects the whole pack. A stale local
anchor rejects the item while preserving other boundary-safe items.

V1 harness packs are accepted only for shadow measurement. Prompt composition and routing reject
them regardless of local flags. Harness influence requires a v2 pack whose exposure snapshot,
policy revision, gate decision, and reverification state all validate independently.

## 10. State, receipts, candidates, and evidence

Generalized memory state contains only bounded interaction metadata:

- stable producer run ID;
- verified binding handles, never token material;
- per-plane request IDs and retrieval packs;
- exact record ID/version and disposition;
- exposure/use/utility fields;
- typed scope-snapshot digest;
- candidate IDs and evidence-manifest handles;
- terminal receipt/outbox status.

Reducers remain deterministic across resume, retry, subgraphs, HITL, and repair loops. A replay
with the same request ID preserves one pack; a deliberate refresh gets a new immutable pack.

The universal receipt carries tenant/project from the verified binding, typed scope snapshots,
terminal outcome, per-pack feedback, evidence handles, and bounded candidates. Repository/base-SHA
fields appear only in codebase snapshots. Harness snapshots carry workflow/configuration versions.

The initial evidence manifests are:

- code: base/head/tree/diff/test/PR references;
- harness: workflow/configuration versions, failure fingerprints, bounded tool results, and
  independently checkable runtime attestation with stable origin/derivation handles.

Content and org evidence manifests remain contract placeholders until those planes are admitted.
Fiesta proposes; PIM verifies and activates. Harness activation still cannot influence a prompt or
route until separate gates pass.

### 10.1 Scheduled reverification and local freshness

PIM owns scheduled truth reverification and the authoritative stale/revoked/expired transition.
Fiesta validates the returned lifecycle, `last_verified_at`, `next_reverify_at`, maximum age,
policy revision, and current workflow/configuration anchor before each use. An overdue, failed,
contradicted, withdrawn, or unresolved record is excluded from prompts and routing and receives a
bounded disposition/feedback signal. PIM unavailability degrades Fiesta to no new memory; it never
causes expired evidence to be treated as fresh.

FU2 exercises expiry, contradiction, source withdrawal, provider outage, retry/dead-letter, and
stale-transition behavior in shadow. FU3 cannot start until PIM reports a healthy reverification
capability and the local rejection path has passed its drills.

### 10.2 Repo-native delivery boundary

The initial release injects bounded memory at run time through the v2 API. Fiesta does not write
active memory into repository instruction files, `AGENTS.md`, or skills. A future Fiesta renderer
may produce a reviewed derived artifact containing record/version IDs and a manifest digest, but
the artifact is never authority and must be regenerated or removed after revocation. That future
delivery path must name a repository owner and independently earn value under
[the graph retrieval enablement pattern](./FIESTA_MEMORY_GRAPH_ARCHITECTURE_REVIEW.md#8-how-graph-retrieval-should-earn-production-use).

Legacy graph synthesis or "dreaming" remains owned by
[the PIM architecture overview](./ARCHITECTURE_OVERVIEW.md) and
[the canonical-memory producer plan](./PLAN_POD_LEARNINGS_TO_CANONICAL_MEMORY.md); Fiesta does not
treat it as truth reverification or repo-native delivery.

## 11. Prompt composition and rollout modes

Every plane has an independent feature flag, policy result, token budget, labeled rendered block,
canary assignment, and kill switch. Never flatten different planes into unlabeled prose.

For harness, `canary` and `active` modes require the v2 endpoint and v2 audit pack. V1 harness
responses remain shadow even if a local operator accidentally enables a prompt or routing flag.

The global `mode` enum is:

| Mode | Maximum permitted behavior |
|---|---|
| `disabled` | no PIM memory calls |
| `contract_only` | capabilities and non-secret binding checks only; no search, detail, receipt, candidate, prompt, or routing use |
| `shadow` | enabled search/detail/validation/metrics and explicitly enabled receipts/candidates; never prompt or routing influence |
| `canary` | shadow behavior plus independently gated prompt or routing exposure for a deterministic subset |
| `active` | broader production use, still limited by capabilities, credential scope, plane flags, PIM policy, and kill switches |

A representative configuration is:

```yaml
values:
  pim:
    memory_enabled: true
    mode: contract_only
    planes:
      codebase:
        search_enabled: false
        prompt_exposure_enabled: false
        routing_influence_enabled: false
        candidate_extraction_enabled: false
        receipt_enabled: false
      harness:
        search_enabled: false
        prompt_exposure_enabled: false
        routing_influence_enabled: false
        candidate_extraction_enabled: false
        receipt_enabled: false
      content:
        search_enabled: false
        prompt_exposure_enabled: false
        routing_influence_enabled: false
        candidate_extraction_enabled: false
        receipt_enabled: false
      org:
        search_enabled: false
        prompt_exposure_enabled: false
        routing_influence_enabled: false
        candidate_extraction_enabled: false
        receipt_enabled: false
```

Effective permission is the intersection of global enablement, mode ceiling, server capability,
credential operation/resource binding, plane operation flag, PIM policy/gate, and kill-switch
state. A lower layer may restrict behavior; no layer may exceed the global mode ceiling.

Current authoritative state and mandatory policy always beat advisory memory. Conflicts receive
bounded feedback; a model never resolves an authorization or policy conflict silently.

## 12. Per-plane evaluation and enablement gates

Fiesta uses the pattern in
[How graph retrieval should earn production use](./FIESTA_MEMORY_GRAPH_ARCHITECTURE_REVIEW.md#8-how-graph-retrieval-should-earn-production-use)
for every plane.

Before results are examined, declare:

- a benchmark with representative tasks, negative controls, stale/inactive examples, and
  cross-scope authorization traps;
- variants: normal-budget no-memory baseline; no-memory control with the same total inference-token
  and permitted actor-step budget as the memory arm; shadow retrieval with no behavioral influence;
  and deterministic memory canary;
- numerical thresholds for relevance, task success, rework, harmful/distracting context, latency,
  tokens, and cost;
- repetition count, model/configuration strata, variance reporting, confidence intervals, and the
  decision rule for inconclusive results;
- rollback ownership and the kill-switch drill.

The budget-matched arm follows
[the budget-constrained agent-memory study](https://arxiv.org/abs/2606.15017): Fiesta memory must
beat a vanilla agent allowed to spend the same total inference budget, not merely a cheaper
baseline.

Production influence requires zero authorization/inactive exposure, credible lift on intended
tasks, no material ordinary-work regression, acceptable latency/cost/outage behavior, and improved
outcomes rather than merely more context.

Gates are plane- and operation-specific. Search activation does not approve prompt exposure;
prompt exposure does not approve routing influence. Codebase results do not approve harness, and
harness does not approve future content or org.

## 13. Failure behavior and safety

| Failure | Fiesta behavior |
|---|---|
| PIM unavailable or timeout | continue without new memory; preserve queued receipt |
| Plane or operation unavailable | disable it and record a bounded status; no fallback |
| Credential unresolved | disable memory; never use caller-supplied authority |
| Resource mismatch | fail closed for memory and emit a security signal |
| Authorized empty result | continue with `success_empty`; no fallback |
| Malformed or cross-boundary pack | reject the whole pack and continue |
| Stale/unresolved item anchor | reject the item; retain other safe items |
| Reverification overdue, failed, or unhealthy | reject influence; continue without that memory and emit bounded disposition |
| Receipt delivery failure | queue and retry; never fail completed work solely for PIM |
| Evidence unresolved | leave the candidate pending |

Before transport or persistence, reject credentials, authenticated URLs, hidden reasoning, full
model traces, unnecessary personal data, unbounded logs/transcripts, complete source assets,
unlicensed content, and workstation-identifying paths. Use opaque IDs, digests, references, bounded
summaries, and reason codes.

## 14. Implementation map

| Area | Initial required direction |
|---|---|
| Contracts | consume PIM-owned v2 schema; keep strict v1 code fallback |
| Transport | generated HTTP v1/v2 clients only; bounded `direct_http` telemetry; no initial MCP client or fallback |
| Credentials | generic repository/harness resource metadata, exact non-wildcard scopes, and safe introspection |
| Runtime/readiness | negotiate known planes and available operations; implement the mode ceiling |
| Binding | compare typed checkout or harness runtime resource with credential resource |
| State | per-plane codebase/harness packs, snapshots, dispositions, and candidates |
| Search/detail | dispatch only available codebase/harness operations; never mix or fall back |
| Validation | retain repository checks; add workflow/configuration/runtime and scheduled-reverification validation |
| Origin authority | preserve producer/provider/derivation handles; never count run IDs as independent corroboration |
| Prompt/routing | v2-only, independently labeled and gated codebase/harness influence; v1 harness remains shadow |
| Candidates/receipts | typed codebase/harness manifests and scope snapshots through the existing durable outbox |
| Content/org seam | provisional context and adapter interfaces, disabled config, deterministic unavailable behavior, fixture/negative tests only |
| Tests/evals | v1/v2 code parity plus budget-matched harness benchmark, origin-collapse, reverification, negative controls, outage, resume, and kill-switch proof |

Likely Fiesta files remain `contracts/pim-memory`, the generated PIM client,
`packages/memory/pim_credentials.py`, `pim_runtime.py`, `pim_receipt.py`, the durable outbox,
`resolve_pim_binding.py`, PIM graph nodes, memory state models/reducers, configuration schema, prompt
rendering, and memory/evaluation suites.

## 15. Build commitment and planning guardrail

| Scope | Commitment | Rough planning range |
|---|---|---|
| Current P1/P2 | finish and preserve as compatibility baseline | days, unless another contract defect appears |
| V2 codebase parity plus harness end to end | initial committed release, including v2 exposure audit and reverification enforcement | about 4–8 calendar weeks with PIM and Fiesta in parallel |
| Content-ready contract/interface seam | included, disabled, and unavailable | roughly 1–2 engineer-weeks across both sides within foundation work |
| Fiesta MCP client | not committed; requires a separately named benefit and PIM MCP admission | deferred and outside the initial release critical path |
| Real production content plane | separately approved future project | roughly 4–8+ additional weeks, depending on providers and governance |
| Organization-policy plane | not estimated until demand and an owner exist | deferred |

The readiness seam prevents a redesign later; it does not justify implementing speculative
provider connectors, content storage, or prompt behavior now.

## 16. Delivery phases

These align with PIM `U0` through `U3` and its deferred `C*`/`O*` phases.

### FU0: universal-ready contract skeleton

- Consume generated v2 common models and availability matrix.
- Add stable codebase/harness scope contexts and generic credential metadata.
- Add provisional content/org context interfaces and disabled adapters.
- Define and test `disabled`, `contract_only`, `shadow`, `canary`, and `active`.
- Encode exact harness scope strings, stable root-origin/derivation handles, v2-only harness
  influence, and v1 permanent-shadow compatibility.

**Exit:** Fiesta negotiates v2, content/org fail safely as unavailable, and ordinary task behavior
and v1 permissions are unchanged.

### FU1: codebase on v2

- Route the current P1/P2 code interaction through v2 behind a flag.
- Compare v1 and v2 search, detail, disposition, receipt, resume, outage, latency, and quality.
- Retain v1 fallback.

**Exit:** v2 code behavior reaches parity without weakening repository/SHA trust or code quality.

### FU2: harness governed loop in shadow

- Implement the net-new Fiesta harness-plane path as a registered workflow adapter; PIM's
  existing harness surface is not pre-existing Fiesta harness code.
- Add local compatibility validation, immutable detail, typed receipts, candidates, runtime
  evidence, and re-retrieval.
- Preserve authenticated origin/derivation handles and prove retries or new run IDs from one root
  cannot masquerade as independent corroboration.
- Exercise scheduled reverification, expiry, contradiction, source withdrawal, provider outage,
  and stale transitions in shadow.
- Keep prompt and routing influence off.

**Exit:** one workflow learns and re-retrieves a verified lesson with behavior identical to the
no-influence baseline.

### FU3: harness earns production influence

- Build the adjudicated harness benchmark and negative controls.
- Compare normal-budget baseline, budget-matched no-memory control, shadow, and deterministic
  canary under predeclared repeated-run and confidence rules.
- Require healthy PIM reverification and prove Fiesta rejects overdue/failed records.
- Drill rollback and independent prompt/routing kill switches.
- Use only v2 exposure decisions and v2 audit packs; keep v1 harness permanent shadow.

**Exit:** each proposed influence passes its gate or remains disabled without blocking release.

## 17. Deferred plane phases

### FC0: content admission decision

Requires a named workflow and owner, canonical provider-backed content-space identity, retention,
classification and licensing rules, evidence policy, an adjudicated benchmark, and a measured-value
hypothesis. Until then the content adapter remains disabled and PIM unavailable.

### FC1: run-derived content shadow

Fetch current brand/product/terminology/policy context from its authoritative systems. Resolve one
real content space and retrieve only provenance-complete run-derived lessons. No prompt exposure,
brand-document import, or previous-draft retrieval.

### FC2: content candidates and canary

Add bounded evaluated candidates, receipts, and deterministic canary exposure only after FC1
passes its gate.

### FO0: organization-policy admission

Requires a named policy owner, authoritative revision/effective-time source, cross-workflow demand,
and conflict/precedence tests. It is not part of the initial release.

## 18. Test strategy

The initial full matrix applies to codebase and harness:

- generated-contract and unknown-field rejection;
- exact credential/resource binding and cross-tenant/project/plane/resource denials;
- authorized empty results and unavailable planes with no fallback;
- immutable detail identity/version and current-context validation;
- checkpoint resume and request/pack identity stability;
- timeout/unavailable behavior;
- receipt enqueue/retry/replay/acknowledgement idempotency;
- candidate non-searchability before activation;
- prompt-off behavioral equivalence;
- v1 harness permanent-shadow enforcement even when local influence flags are misconfigured;
- duplicate run IDs, retries, summaries, tool echoes, and multiple roots controlled by one
  corroboration domain collapsing to one independent observation;
- scheduled-reverification expiry, contradiction, source-withdrawal, outage, dead-letter, and local
  fail-closed tests;
- normal-budget and budget-matched no-memory controls with predeclared repetitions and variance;
- independent canary and kill-switch behavior;
- secret/PII/oversized-payload rejection;
- v1 versus v2 code relevance, latency, and task-outcome parity.

Content and org initially require contract/interface tests proving default-off configuration,
capability unavailability, zero calls/writes, and no fallback. Their complete provider,
classification, evidence, and evaluation matrices become mandatory only after admission.

## 19. Initial-release acceptance criteria

The initial universal-ready Fiesta release is complete when:

- current P1/P2 behavior remains operational;
- codebase v2 meets or exceeds v1 trust, quality, latency, and outage behavior;
- harness has an organization/project/resource-bound governed loop;
- repository ID and base SHA exist only in codebase context;
- every pack, receipt, candidate, and disposition preserves plane/resource identity;
- harness activation cannot imply prompt or routing influence;
- harness prompt/routing influence accepts only v2 packs and never v1 permanent-shadow packs;
- changing run/root IDs or deriving another artifact within one corroboration domain cannot
  manufacture independent corroboration;
- every influence-eligible harness memory has current reverification state, and Fiesta rejects it
  after expiry, contradiction, withdrawal, or unresolved verification failure;
- content and org remain recognized, disabled, and unavailable with zero storage side effects;
- no failure or empty result causes cross-plane fallback;
- each enabled influence has benchmark evidence and a tested independent kill switch;
- each influence benchmark includes a budget-matched no-memory control and predeclared variance
  treatment;
- unavailable PIM does not block work or lose queued receipts;
- no credential is implicitly widened; only explicit token issuance may add exact scopes and
  resource bindings;
- FU0-FU3 complete over canonical HTTP without an MCP client or production MCP dependency.

Fiesta must not claim production content or organization memory support until the matching deferred
phase passes.

## 20. Explicit non-goals for the initial release

- enabling every workflow or plane at once;
- copying brand intelligence, CMS/DAM assets, policy documents, drafts, conversations, or hidden
  reasoning into PIM;
- implementing real content/org provider connectors without admission inputs;
- using mixed-plane retrieval or fallback;
- allowing a model to establish authorization, approval, or policy precedence;
- enabling prompt/routing influence before its measured gate;
- treating repeated runs, root IDs, or descendants controlled by one corroboration domain as
  independent authority;
- consuming v1 harness shadow packs for prompt or routing influence;
- writing memory into repository instruction files, `AGENTS.md`, or skills during the initial API
  release;
- adding an MCP transport merely for protocol symmetry or making it a Fiesta release dependency;
- removing v1 before codebase v2 parity is proven.
