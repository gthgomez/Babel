# Model Intelligence & Capability Qualification V1

<!-- status: ACTIVE -->

This document describes Babel's capability-aware model runtime. It extends the
existing route receipts, context manifests, tool lifecycle evidence, provider
retry receipts, and seeded campaign provenance; it does not replace them.

## Runtime contract

```text
Task
  ↓
Harness Policy
  ↓
LabModelSpec
  ↓
ProviderModelProfile
  ↓
ProtocolProfile
  ↓
Capability Resolver
  ↓
Immutable ResolvedExecutionEnvelope
  ↓
Provider Adapter
  ↓
Wire Request
  ↓
Router / Upstream
  ↓
Observed Runtime Evidence
  ↓
Qualification / Failure Attribution
```

`LabModelSpec` contains provider-independent model facts: family, revision,
modalities, declared limits, and source evidence. `ProviderModelProfile` records
how a gateway or upstream hosts that model: endpoint limits, pricing, tokenizer,
routing, caching, lifecycle, and protocol profiles. A provider profile is not a
model capability claim.

`ProtocolProfile` is independent for `chat_completions`, `responses`,
`anthropic_messages`, and `custom`. Reasoning, tools, and structured output are
multidimensional. A request being accepted is not behavioral verification.
Capability observations carry two independent axes: `support` (`supported`,
`unsupported`, `conditional`, `conflicting`, or `unknown`) and `evidenceLevel`
(`declared`, `api_advertised`, `request_accepted`, or `behavioral`). The legacy
`state` field remains as a compatibility projection.

Sampling controls are resolved explicitly too: `temperature`, `top_p`, and
`seed` record requested, accepted, effective, and semantic-verification state.
Provider operational evidence (rate limits, affordability, retry semantics,
latency, throughput, and availability) is kept in a separate volatile profile;
account credit state is never folded into model identity.

`HarnessTuningProfile` contains provisional, experimental, or qualified Babel
recommendations. It is intentionally separate from model capability. An
`ResolvedExecutionEnvelope` is the only policy input a capability-aware adapter
should consume. Its identity fields explicitly distinguish
`userRequestedModelId`, `catalogModelId`, `wireModelId`,
`canonicalRevisionSlug`, `aliasId`, `aliasTarget`, and the observed response
model. It records model alias and concrete revision, provider/upstream,
protocol, context and output limits, reasoning/tools/structured-output
resolution, routing, affordability status, and a configuration hash.

## Modes and safety

- `benchmark_strict` freezes concrete model revision, upstream, protocol,
  routing, output policy, and required parameters. Fallbacks and unrecorded
  context transformations invalidate a treatment.
- `production_resilient` may adapt explicitly when the resolution is recorded
  as translated or clamped.
- `qualification` uses explicit budgets and bounded probes. Paid probes are
  never dispatched implicitly by the qualification artifact layer.

OpenRouter metadata is normalized into content-free routing provenance. The
selected upstream, endpoint, attempts, fallback/retry state, context
transformation, and metadata hash are retained where exposed. Missing required
metadata is an unknown/blocked condition, not an inferred success.

## Attribution and campaign validity

`finish_reason=length` at Babel's configured ceiling is recorded as
`HARNESS_OUTPUT_TOKEN_BUDGET_EXHAUSTED`, not model failure. Affordability (402),
authentication (401/403), invalid model/parameters, and profile/wire mismatch do
not use the transient 429 retry path. The campaign circuit breaker opens on a
definitive shared failure and after the configured transient signature threshold.

Campaign readiness is split into instrumentation, execution, comparison, and
publication. `READY` instrumentation never implies valid model comparison.
Aggregate metrics carry `performance_comparable`, `diagnostic_only`, or
`insufficient_data` validity. A solved task is therefore not automatically a
model-attributable success.

Paid campaigns with more than two cells must pass
`PRE_FLIGHT_PROVIDER_VALIDATED` using the exact execution-envelope hash. The
representative smoke checks authentication, affordability, routing, model
identity, required parameters, serialization, and receipts before fan-out.

Token counts retain their method and confidence. Character length is a UI/storage
metric, not an authoritative context budget when tokenizer or provider-reported
counts exist. Compaction records algorithm, model/provider/protocol, state and
summary hashes, target budget, and preserved/summarized/dropped event IDs.

Auxiliary inference (compaction, critic, reviewer, summarizer, verifier) has an
explicit policy: inherit the primary treatment, use a frozen explicit profile,
or remain disabled. API-key presence cannot select the experimental treatment.

OpenRouter limit observations are scoped and never promoted across boundaries:
`LabModelSpec` contains only provider-independent declared limits, while gateway,
top-provider, exact-endpoint, and behavioral values remain `LimitEvidence` on
the hosted profile. Conflicting values are retained and surfaced as
`conflicting`; a low safe probe may proceed without claiming that a theoretical
maximum is known. External metadata captures persist the redacted request URL,
status, relevant headers, raw-body SHA-256, normalizer version/source hash, and
normalized-artifact hash under `external/raw/` and `external/normalized/`.

## Qualification artifact

`ModelQualificationRecord` is versioned by model/provider profile hashes and
protocol. Probe results retain request/response artifact IDs, observed provider
and endpoint, usage, finish reason, cost, and per-capability evidence. The local
probe layer uses mocks, fixtures, and intercepted wire requests before any live
call. The bounded Q1–Q7 plan is data, not an instruction to launch a campaign.

The current implementation intentionally stops before a large GLM/DeepSeek
calibration campaign. A campaign must first pass profile freshness, strict
routing provenance, exact wire checks, required tool/replay qualification,
output-budget attribution, auxiliary-policy freeze, affordability guard, and
representative preflight smoke.

## Historical closure-bundle reconciliation

The actual `babel-chat-reliability-closure-20260829.zip` was inspected read-only.
Its `MANIFEST.sha256` was present and all 54 listed payload entries verified.
The generated mapping and report are produced by
`scripts/reconcile_model_intelligence_history.ts`; historical source artifacts
remain immutable and are not rewritten.

Preservation/generalization mapping from the supplied requirements:

| Historical mechanism | V1 treatment |
| --- | --- |
| campaign manifest and schedule hashes | Generalized with capability, envelope, auxiliary, token-policy, and qualification hashes |
| model-route receipt | Preserved and extended with gateway, endpoint, routing, and envelope fields |
| context manifest | Preserved; extended with tokenizer/context and compaction treatment evidence |
| tool lifecycle receipts | Preserved; qualified dimensions are now separate from interface enablement |
| provider retry receipts | Preserved; structured retry policy separates Babel/router/upstream attempts |
| model-policy routing | Preserved as compatibility input; capability registry supplies versioned eligibility |
| compaction and critic routing | Generalized behind explicit auxiliary inference policy |
| readiness calculation | Replaced overloaded `ready` with four readiness dimensions |
| model-comparison validity | Replaced broad `interpretable` with diagnostic and performance validity |
| failure attribution | Generalized with output/context/tool/step/wall-clock and provider-credit causes |
| unknown/not-backfilled discipline | Preserved; model prose is never runtime evidence |
