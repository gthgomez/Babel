# Babel Autonomous SWE Foundations V1.1

<!-- status: FOUNDATIONAL EXPERIMENTAL / INTERNAL -->

This document describes the first control-plane primitives for evidence-driven
software engineering in Babel. It is an internal, foundational experiment. It
does not claim shipped autonomous multi-worker mutation, autonomous merge,
rollback, self-modification, or heterogeneous provider orchestration.

## Goal and trust model

Babel should eventually be able to take a high-level software goal through:

```text
UNDERSTAND → CONTRACT → PLAN → EXECUTE → ATTACK → VERIFY → INTEGRATE → OBSERVE → LEARN
                         │          │          │         │
                         ▼          ▼          ▼         ▼
                    frozen task  isolated   Breaker   evidence
                    contract     session    (read)    graph + gate
```

V1 establishes durable, structured inputs and evidence boundaries. Agents may
propose, execute, challenge, and interpret. Evidence decides whether a required
engineering claim is satisfied.

The trust rules are:

- Agent agreement is not proof.
- A builder claim is not proof.
- Evidence is bound to the task, frozen contract, repository, base SHA, and
  candidate SHA where applicable.
- A failed, stale, malformed, missing, or unknown evidence item cannot produce
  `VERIFIED`.
- Delegation does not widen the receiving environment's capabilities.
- Repository policy is provenance, not explicit user authorization.
- Chat transcripts are context; structured artifacts are authoritative.
- Durable serializers redact known credential-shaped values; contract creation
  rejects values that remain secret-shaped when policy redaction is disabled.

V1.1 separates three things that V1 represented with similarly shaped fields:

1. **Claimed identity** is caller-controlled descriptive metadata such as an
   endpoint ID, role, or execution-domain string. It never grants authority.
2. **Trusted identity** is an opaque supervisor-issued handle resolved through
   `babel-cli/src/authority/trustedExecution.ts`. The resolver is read-only to
   builders and the completion gate checks the resolved role, capability,
   task/contract binding, lifecycle, and execution domain. This is an
   in-process supervisor/registry boundary, not a cryptographic signature,
   hardware attestation, or OS isolation claim.
3. **Authority-bearing provenance** is an opaque supervisor-issued authority
   grant. A `user:` string, repository policy record, agent text, or builder
   output cannot create one. Explicit-user grants are checked for source,
   lifecycle, task/session/contract binding, and capability subset.

The same supervisor issues a trusted execution context containing repository,
project root, task, contract hash, base revision, candidate revision, execution
identity, and optional authority grant. The V1.1 completion gate requires this
context and returns `UNKNOWN` when it is absent, inactive, or inconsistent;
independent caller strings are not a trust fallback.

## TaskContractV1

`babel-cli/src/agent/taskContract.ts` is the canonical contract seam used by
Chat, Plan, and Deep. V1 adds durable `task_id`, `goal`, required behaviors,
invariants, scope, risk, capability-oriented authority, machine-readable
acceptance requirements, provenance records, `base_sha`, and a deterministic
`contract_hash`.

The authority vocabulary reuses Babel's existing `CapabilityId` registry. The
contract does not introduce a second permission system. `freezeTaskContract`
deep-freezes the returned object; changing requirements requires a new contract
revision. Canonical hashing sorts object keys recursively and excludes only
volatile identity and provenance metadata. Provenance records and the
authority source are content-bound. `validateTaskContractV1` retains legacy
V0 fixture compatibility; `validateTaskContractV1ForCompletion` is the strict
V1 completion boundary and requires a required acceptance item.

Provenance records distinguish `user_goal`, `repository_policy`,
`derived_acceptance`, `risk_analysis`, and `explicit_user_authority`. A policy
file cannot be relabeled as explicit user authority. In V1.1 an explicit
authority record must reference a supervisor-issued `grant:` handle resolved by
the trusted authority source; `user:` remains descriptive legacy data and has
no authority-bearing meaning. The contract hash includes the grant reference,
so changing the bound grant invalidates the contract.

## Acceptance escrow

`babel-cli/src/acceptance/escrow.ts` adds `AcceptanceBundleV1` around the
existing patch-blind acceptance V0 system. `builder_visible` and `restricted`
views are role-separated; a builder receives only its permitted view while a
verifier/auditor receives the complete bundle. V1 does not claim cryptographic
secrecy or security through obscurity. The bundle is frozen and bound to the
TaskContract hash.

The existing `ExecutableAcceptanceContractV0`, oracle planner, evidence
admission, and sufficiency evaluator remain canonical for current acceptance
recording. Escrow is an additive access-boundary primitive.

## Durable task events

`babel-cli/src/agent/taskEventJournal.ts` provides a task-level JSONL journal
with schema version, durable task identity, contiguous sequence, payload hash,
previous-event hash, and event hash. It covers task/contract/plan/assignment,
execution, tool, artifact, claim, verification, challenge, failure, and
terminal events. Parsing validates schema, sequence, task identity, payload
size, secret-like fields, and the full hash chain. Saving uses a temporary file
and atomic rename; reload rejects corruption rather than creating success.

This task journal complements Babel's existing `SessionEventV1` and
hash-linked `episode-events.jsonl`: session events remain the runtime lifecycle
record, while this journal is the durable task control-plane projection.

## EvidenceGraph and completion gate

`babel-cli/src/evidence/evidenceGraph.ts` extends the existing graph with typed
node kinds, relationship edges, and `EvidenceBindingV1`. Bindings can include
task ID, contract hash, repository, base SHA, candidate SHA, requirement ID,
and artifact hash. Dangling references are invalid.

`evaluateCompletionGateV1` is deterministic and deliberately narrow. Required
acceptance requirements can be satisfied only by current, typed passing
`test_result`, `build_result`, `ci_result`, `command_result` with an explicit
verifier kind, `runtime_observation`, or revision-bound `verifier_receipt`.
Those nodes require a canonical producer identity reference resolved through the
trusted supervisor and a `certify_evidence` capability. A free-form role label,
copied endpoint ID, or matching descriptive identity is not an identity
credential. The resolver checks role, endpoint, execution domain, lifecycle,
task, contract, and trusted execution context. Builder claims, critic
approvals, majority agreement, missing provenance, stale base/candidate SHA,
failed tests, and contradictory findings cannot certify completion. Outcomes are
`UNVERIFIED`, `PARTIAL`, `FAILED`, `VERIFIED`, or `UNKNOWN`; missing trusted
context is `UNKNOWN`, never verified.

Revision-bound receipts use the canonical V1.1 shape
`{ schema_version: 1, receipt: { receiptId, command, exitCode, boundRevision,
stale } }`. The receipt branch validates `exitCode`, current revision binding,
staleness, and the same trusted identity/context bindings as other certifying
evidence. The legacy untyped `exit_code` path is retained only for other typed
evidence kinds; it is not used to loosely normalize verifier receipts.

The existing revision-bound receipt and acceptance V0 evaluators remain in
place for current callers; the V1 gate adds a task/contract/SHA-bound primitive
without changing normal CLI semantics.

## Breaker role

`babel-cli/src/agent/breakerContract.ts` defines a read-only Breaker input and
structured finding output. The Breaker receives the frozen contract, candidate
metadata, acceptance requirements, and selected evidence. It does not require
the builder's chain-of-thought or confidence narrative. Its question is “How
can I make this fail?” rather than “Does this diff look correct?”

The Breaker capability set is limited to inspection, search, and verifier
commands. Tests/builds execute project code, so the contract requires an
`isolated-sandbox` execution domain. `assertBreakerReadOnly` rejects mutation,
publication, credential, arbitrary-code, and unknown capabilities. V1 defines
the role contract only; it does not create an autonomous swarm or a
mutation-capable breaker.

## Failure attribution

`babel-cli/src/services/failureAttribution.ts` records a typed failure category,
confidence, evidence, alternatives, and task/model/harness/environment/SHA
metadata. Independent evidence must support a category before attribution can
be specific. A model self-diagnosis alone produces `UNKNOWN`; competing causal
evidence preserves alternative hypotheses instead of inventing certainty.

## Replay manifest

`babel-cli/src/services/replayManifest.ts` records non-secret reconstruction
inputs: task/contract/repository/SHA identity, model, harness, tool profile,
feature flags, verification commands, outcome, failure class, and safe
environment metadata. Known secret keys and token-shaped values are redacted;
unsupported environment values become an explicit marker. The task contract,
acceptance bundle, event journal, evidence metadata, replay manifest,
reliability telemetry, Breaker findings/contracts, endpoint descriptors, and
Full artifact serializers apply the same durable-secret boundary. Values are
redacted before durable storage where replay remains meaningful; secret-shaped
values that would make an artifact ambiguous are rejected. Raw task text is
not written by the Full artifact adapter. Schema/version/hash errors return a
failed parse result.

## Reliability telemetry and AgentEndpoint

`babel-cli/src/telemetry/reliability.ts` records nullable run-level inputs for
future empirical routing: task class, risk, model, harness, tool profile,
success, verification result, attempts, human interventions, duration, cost,
and later-known escaped defects. Missing values remain `null`; V1 does not rank
models or choose a router.

`babel-cli/src/agent/agentEndpoint.ts` provides a normalized endpoint descriptor
for identity, harness, model/provider, existing Babel capabilities, location,
and execution domain. It is an interoperability shape, not a provider
implementation and does not hardcode Remote/OpenCode/Grok behavior.

## Babel Full integration

The existing `runBabelFullPlan` read-only proof lane writes an additive
`autonomous-swe-v1/` directory containing the task contract, acceptance bundle,
task event journal, evidence graph, replay manifest, and nullable reliability
telemetry. Existing human output and route semantics remain unchanged.

`mutation_subagents.enabled` remains `false`. Full's existing read-only Spark
reviewers and governed lead-lane boundary are preserved. Remote WebSocket,
Remote PWA, and Remote fixture surfaces are intentionally untouched.

## Roadmap (documented, not implemented here)

1. **Isolated mutating workers** — worktree/shadow-root isolation, scoped write
   authority, rollback evidence, per-worker verification, hostile dirty-tree
   tests, and deterministic merge policy.
2. **Heterogeneous reviewers** — blind, independent, role-differentiated
   Builder/Reviewer/Breaker models.
3. **Empirical router** — estimate model × harness × tool profile × task class
   from verified outcomes rather than generic benchmarks.
4. **Autonomous merge train** — exact-result reverification across PR, CI,
   rebase/update, and merge boundaries.
5. **Post-merge observer** — monitor CI/runtime smoke/regressions and consider
   only strictly governed reverts.
6. **Experience Compiler** — distill typed invariants, failure signatures,
   heuristics, regression patterns, and architecture decisions from runs.
7. **Babel Forge** — shadow-evaluate proposed prompt/tool/policy/harness
   changes with safety regression tests, A/B replay, canaries, and explicit
   promotion. Never permit unverified direct self-modification.

## North-star metric

The north-star is **Human Interventions per Successful Change**, interpreted
alongside escaped defects, reverts, security findings, goal drift, time, cost,
and verification strength. Fewer human interventions with more escaped defects
is not improvement.

## V1.1 limitations

The following remain `NOT_IMPLEMENTED` or `NOT_VERIFIED`: autonomous mutation
by multiple workers, autonomous merge or rollback, production monitoring,
self-modification, provider collaboration, cryptographic secrecy or signed
attestation for the supervisor registry,
full CI/device replay, automatic reliability ranking, and a scheduler or
unbounded agent loop. V1.1 is a foundation for those future stages, not a claim
that those capabilities exist. The current supervisor registry is an in-process
trust boundary and must be hosted outside an untrusted builder; external
identity infrastructure and hardware-backed attestation are not implemented.
