<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
-->

```yaml
status: CANONICAL
architecture_version: harness-v1
authority: normative
last_verified: 2026-08-03
change_policy: ADR and conformance-test updates required
```

# Babel Harness Architecture v1

> **Authority**: This document is the **single normative specification** for Babel’s runtime harness architecture (`architecture_version: harness-v1`).
> **SUPERSEDES** conflicting or incomplete harness descriptions in `HARNESS_OVERVIEW.md`, mode guides, and package context for *runtime harness norms*.
> **Does NOT replace** Prompt OS / product architecture in [ARCHITECTURE.md](./ARCHITECTURE.md), catalog authority in `prompt_catalog.yaml`, or product entry in [BABEL_BIBLE.md](../../BABEL_BIBLE.md).

| Companion | Role |
|-----------|------|
| [ADR-012](../adr/ADR-012-canonical-harness-architecture-v1.md) | Decision record for this freeze |
| [HARNESS_OVERVIEW.md](./HARNESS_OVERVIEW.md) | **Explanatory** map only |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Prompt OS layers + broader system |
| `babel-cli/PROJECT_CONTEXT.md` | Changing implementation hot paths |
| `babel-cli/src/executor/contracts.ts` | Runtime type contracts |
| `babel-cli/src/executor/kernel.ts` | Shared completion implementation |
| `babel-cli/src/executor/architectureConformance.test.ts` | Executable invariants |
| `examples/golden-harness/` | Golden scenario fixtures |
| `tools/check-harness-architecture.ps1` | Drift detection |

---

## 6.1 Purpose and scope

### What the harness is

Babel’s **runtime harness** is the deterministic control system around a model: controllers, tools, capability enforcement, isolation, mutation safety, verification gates, completion authority, evidence, budgets, and CLI surfaces.

```text
Agent = Model + Harness
```

### What lies outside this specification

| Outside scope | Owner |
|---------------|--------|
| Prompt layer catalog and versioning | `prompt_catalog.yaml`, Prompt OS docs |
| Domain/skill prose content | `01_`–`06_` layers |
| Provider model ranking / waterfalls | `config/model-policy.json`, waterfalls docs |
| Public release/secret policy | tools + CI |
| User product marketing claims | README / vision |

### Conceptual roles

| Role | Definition |
|------|------------|
| **Model** | Stochastic proposer of plans, tool calls, and completion claims |
| **Prompt OS** | Deterministic instruction-stack assembly (feedforward guidance) |
| **Controller** | Mode-specific orchestration (ChatEngine, plan lane, V9 pipeline) |
| **Executor kernel** | Shared substrate: mode policy, effect classification, completion decide |
| **Capability enforcement** | Tool allowlists, policy presets, shell validation, enterprise policy |
| **Verifier** | Controller-owned external oracle execution and receipts |
| **Evidence** | Persisted artifacts and event streams for audit/replay |
| **CLI surface** | argv, REPL, headless JSON, doctor, modes |

---

## 6.2 Reliability thesis

```text
Deployable Reliability
=
Model Capability
× Task Clarity
× Context Quality
× Execution Safety
× Oracle Quality
× Recovery Quality
```

Factors multiply. A strong model cannot compensate for ambiguous contracts, unsafe host execution, weak oracles, false completion, or fragmented evidence.

| Principle | Implication |
|-----------|-------------|
| Prompts are necessary but insufficient | MUST enforce policy outside the model |
| Tests are oracles, not absolute ground truth | Layered, tamper-resistant, revision-aware verification |
| Completion MUST be independently decided | Model self-report is a proposal only |
| Evidence MUST match workspace revision | Stale receipts MUST NOT authorize verified completion once binding is enforced |

---

## 6.3 Eleven-subsystem architecture

Maturity labels: **IMPLEMENTED** | **PARTIAL** | **PROTOTYPE** | **PLANNED** | **UNPROVEN**.

### 1. Task Contract

| | |
|--|--|
| **Purpose** | Freeze goal, mode, tools, paths, verifiers, budgets before act |
| **Current** | Pipeline `.babel/task-envelope.json` + Zod envelope; chat uses task class / intent plan |
| **Owner** | Router + envelope activation (`taskEnvelope.ts`) |
| **Sources** | `schemas/taskEnvelope.ts`, `agent/intentCompiler.ts`, `pipeline.ts` |
| **Maturity** | **PARTIAL** — strong on pipeline; chat less formal |
| **Gaps** | No single immutable envelope on every Chat path |
| **Target** | One frozen `TaskContractV1` per run on all modes |

### 2. Context and Instruction Compiler

| | |
|--|--|
| **Purpose** | Smallest correct instruction stack with provenance |
| **Current** | Chat: `compileChatStack`; Deep: catalog `stackResolver` + `compileContext` |
| **Owner** | Control-plane resolver / chat stack compiler |
| **Sources** | `control-plane/stackResolver.ts`, `compiler.ts`, `agent/chatStackCompile.ts` |
| **Maturity** | **IMPLEMENTED** (catalog path); chat stack **IMPLEMENTED** (slim) |
| **Gaps** | Fragment utility measurement; conflict reports |
| **Target** | Provenance-aware fragments + utility metrics |

### 3. Risk Router and Controller

| | |
|--|--|
| **Purpose** | Select mode/controller and risk posture |
| **Current** | CLI mode + liteFullRouter + ChatEngine / plan / pipeline controllers |
| **Owner** | Mode router + controller for that mode |
| **Sources** | `cli/constants.ts`, `services/liteFullRouter.ts`, `agent/chatEngine.ts`, `pipeline.ts` |
| **Maturity** | **IMPLEMENTED** (three controllers) |
| **Gaps** | Full `ModeController.submit` adapters partial |
| **Target** | Controllers behind one interface without collapsing policies |

### 4. Typed Capability Broker

| | |
|--|--|
| **Purpose** | Map tools to effect class and authorize by policy |
| **Current** | `classifyToolEffect`, profiles, allowlists, thin `toolCapabilities` (bench) |
| **Owner** | Capability/policy layers before execute |
| **Sources** | `executor/contracts.ts`, `agent/toolExecutor.ts`, `config/toolCapabilities.ts`, `sandbox.ts` |
| **Maturity** | **PARTIAL** |
| **Gaps** | Broker not full effect graph for all tools |
| **Target** | Narrow non-overlapping tools + capability tokens |

### 5. Isolated Execution Environment

| | |
|--|--|
| **Purpose** | Bound filesystem/network/process effects |
| **Current** | Docker when profile + daemon + image; else host spawn + allowlist + `getSafeEnv()` |
| **Owner** | Sandbox / execution profile |
| **Sources** | `sandbox.ts`, `config/benchmarkContainer.ts`, `config/executionProfiles.ts`, `utils/safeEnv.ts` |
| **Maturity** | **PARTIAL** — strong when Docker active |
| **Gaps** | Host fallback is silent for isolation loss (**not fail-closed**) |
| **Target** | Governed isolation MUST fail closed or require explicit escalation (invariant 13 target) |

### 6. Transactional Workspace

| | |
|--|--|
| **Purpose** | Pre/post hashes, dirty veto, rollback |
| **Current** | `workspaceTransactions` (chat writes); `worktreeSafety` (deep); worktree isolation agents |
| **Owner** | Workspace controllers |
| **Sources** | `services/workspaceTransactions.ts`, `services/worktreeSafety.ts` |
| **Maturity** | **IMPLEMENTED** for file writes; shell mutations weaker |
| **Gaps** | Shell-side-effect transactions incomplete |
| **Target** | All reconcilable mutations revision-linked |

### 7. Independent Verifier Kernel

| | |
|--|--|
| **Purpose** | Controller-owned oracles independent of agent self-report |
| **Current** | Three-part: honesty gate + kernel decide + pipeline required-verifier demotion |
| **Owner** | Controller + shared completion authority |
| **Sources** | `completionGatePolicy.ts`, `executor/kernel.ts`, `services/requiredVerifierContract.ts`, `evidence/independentVerifier.ts` (**PROTOTYPE**) |
| **Maturity** | **PARTIAL** |
| **Gaps** | No universal clean-room mount; lossy command identity; IndependentVerifier not live-wired |
| **Target** | Revision-bound independent receipts + structural identity |

### 8. Failure Classification and Repair

| | |
|--|--|
| **Purpose** | Typed failures → different recovery budgets |
| **Current** | `TerminalOutcome`, stall/progress/budget kills, QA REJECT loop, benchmark failure classes |
| **Owner** | Controllers + budget policies |
| **Sources** | `schemas/agentContracts.ts`, `budgetKillPolicy.ts`, `stallDetector.ts`, pipeline QA |
| **Maturity** | **PARTIAL** |
| **Gaps** | Not one unified failure capsule taxonomy across surfaces |
| **Target** | Typed `FailureClass` with infra vs implementation budgets |

### 9. Evidence and Replay Protocol

| | |
|--|--|
| **Purpose** | Append-only, versioned, replayable episode |
| **Current** | Dual chat streams + pipeline EvidenceBundle; `CanonicalExecutorEvent` shape exists |
| **Owner** | Evidence managers per surface |
| **Sources** | `sessionEvents.ts`, `threadEventLog.ts`, `evidence.ts`, `executor/contracts.ts` |
| **Maturity** | **PARTIAL** |
| **Gaps** | No single hash-linked episode end-to-end |
| **Target** | Unified episode stream (**PLANNED**) |

### 10. Evaluation and Promotion System

| | |
|--|--|
| **Purpose** | Measure harness under model-fixed conditions |
| **Current** | Agent benchmarks, SWE-Pro campaign, false_complete labels |
| **Owner** | Benchmark harness |
| **Sources** | `services/agentBenchmark*.ts`, SWE-Pro scripts |
| **Maturity** | **PARTIAL** / **UNPROVEN** for production reliability claims |
| **Gaps** | Stronger repeated-run / infra methodology |
| **Target** | Model-fixed harness eval + held-out promotion |

### 11. Operator and CLI Experience

| | |
|--|--|
| **Purpose** | Clear modes, statuses, doctor, headless CI |
| **Current** | chat/plan/deep/headless; TerminalOutcome → user status |
| **Owner** | CLI / TUI |
| **Sources** | `cli/*`, `interactive/*`, `doctor.ts` |
| **Maturity** | **IMPLEMENTED** with product complexity |
| **Gaps** | Lite/AgentSession historical naming vs ChatEngine |
| **Target** | Single mode parity narrative (this package) |

---

## 6.4 Controller topology

```text
                    ┌─────────────────────────────────────┐
                    │ Shared executor contracts / kernel  │
                    │ contracts.ts · kernel.ts · services │
                    │ completion.decide · effect classes  │
                    └──────────────────▲──────────────────┘
           ┌───────────────────────────┼───────────────────────────┐
           │                           │                           │
   Chat controller              Plan controller             Deep controller
   ChatEngine                   plan / read-only            V9 pipeline +
   mutation: normal             mutation: read_only         Stage 4 executorLoop
   completion: executor         completion: plan_artifact   mutation: governed
   approval: interactive        approval: handoff           completion: proof_carrying
```

**Deep pipeline (orchestration layer, not the kernel):**

```text
Orchestrator → SWE plan → QA PASS|REJECT → (deep only) runExecutorLoop
                                              → finalize verifier contract
```

Shared infrastructure MUST NOT imply identical controller behavior. Controllers MAY differ in orchestration; they MUST share the executor contract boundary for shared execution semantics (invariants 3–4).

---

## 6.5 Authority matrix

**Model-generated claims are proposals, not authoritative facts.**

| Decision or fact | Authoritative owner | Primary code |
|------------------|---------------------|--------------|
| User intent | Frozen task contract / run options | `taskEnvelope.ts`, CLI |
| Mode selection | Router / controller | `cli/constants.ts`, dispatch |
| Mutation permission | Mode policy + capability policy | `modePolicyFor`, toolExecutor |
| Tool authorization | Capability / policy / profile | sandbox, profiles, env tools |
| Actual file changes | Filesystem / Git evidence | workspaceTransactions, worktreeSafety |
| Verifier authority | Controller-owned verifier contract | completionGatePolicy, requiredVerifierContract |
| Verifier result | Verifier receipt (exit + command identity) | receipts / tool log |
| Workspace identity | Revision-capture service | revisionBoundReceipt (**PROTOTYPE** live), workspace hashes |
| Completion outcome | Shared completion authority + controller gates | `kernel.completion.decide`, honesty gate |
| Rollback outcome | Workspace controller | worktreeSafety |
| Human approval | Durable approval record | chatApproval, approval profiles |
| Cost and tokens | Runtime accounting | budgetKillPolicy, cost ledgers |

---

## 6.6 Normative invariants

Language: **MUST** / **MUST NOT** / **SHOULD** / **MAY** / **OWNS** / **SUPERSEDES**.

| ID | Invariant | Status |
|----|-----------|--------|
| H1 | Plan MUST remain read-only (`mutationPolicy: read_only`). | **IMPLEMENTED** |
| H2 | Plan MUST NOT authorize executor-style `VERIFIED_COMPLETE` as allowed success. | **IMPLEMENTED** (kernel maps/rejects) |
| H3 | Chat, Plan, and Deep MUST use the shared executor contract boundary for shared execution behavior. | **IMPLEMENTED** |
| H4 | Mode-specific controllers MAY retain different orchestration policies. | **IMPLEMENTED** |
| H5 | No model response may independently authorize `VERIFIED_COMPLETE`. | **IMPLEMENTED** (gate + kernel) |
| H6 | Completion MUST be decided by controller-owned deterministic logic. | **IMPLEMENTED** |
| H7 | Verification evidence SHOULD be bound to the workspace revision it evaluated. | **PARTIAL** / target |
| H8 | Stale verification evidence MUST NOT authorize current verified completion once revision binding is enforced. | **PARTIAL** — honesty rejects `stale: true`; systematic binding incomplete |
| H9 | Prompt instructions MUST NOT override tool, mutation, isolation, or completion policy. | **IMPLEMENTED** (enforcement outside prompts) |
| H10 | Tool effects MUST be classified before execution or conservatively treated as high risk. | **IMPLEMENTED** (`classifyToolEffect` default external) |
| H11 | Interrupted non-idempotent effects MUST NOT be retried blindly. | **IMPLEMENTED** (effect ledger) |
| H12 | Actual changed files MUST be derived from filesystem or Git evidence, not solely model reports. | **PARTIAL**–**IMPLEMENTED** on write paths |
| H13 | Governed execution requiring isolation MUST eventually fail closed or require explicit boundary escalation. | **TARGET** — current host fallback is known gap |
| H14 | Verification authority MUST NOT come solely from agent-authored ad hoc checks. | **IMPLEMENTED** (authoritative allowlist) |
| H15 | Evidence schemas MUST be versioned. | **IMPLEMENTED** (executor event/contract versions) |
| H16 | Architecture-changing runtime modifications MUST update this specification, ADR status where relevant, and conformance tests. | **PROCESS** (this package) |
| H17 | Deprecated or historical execution paths MUST NOT be described as active without current runtime support and tests. | **PROCESS** |
| H18 | Documentation MUST NOT point to nonexistent authority files. | **PROCESS** + drift checker |

---

## 6.7 Terminal outcomes

### Implemented (`TerminalOutcome` in `agentContracts.ts`)

| Outcome | Propose | Authorize | Mutation | Evidence |
|---------|---------|-----------|----------|----------|
| `VERIFIED_COMPLETE` | Model / controller request | Kernel + honesty + proof | Yes (execute) | Authoritative green verifier + writes where required |
| `UNVERIFIED_PATCH` | Default done / downgrade | Kernel | Yes | Done without green authoritative verifier |
| `BLOCKED_EXTERNAL` | Controllers | Controllers | Possible prior | Env/toolchain |
| `BLOCKED_POLICY` | Gates/critic/stall | Controllers | Possible prior | Policy kill |
| `BUDGET_EXHAUSTED` | Budget controller | Budget controller | Possible prior | Budget |
| `CANCELLED` | User | Runtime | Possible prior | Cancel |
| `INFRA_FAILURE` | Runtime | Runtime | Possible prior | Provider/infra |
| `AGENT_FAILURE` | Runtime | Runtime | Possible prior | Crash/unrecoverable |

Plan terminal (kernel): `PLAN_COMPLETE` — **IMPLEMENTED** for plan mode; not an execute verified completion.

### Planned / not fully first-class product terminals

| Outcome | Status |
|---------|--------|
| `NO_CHANGE_REQUIRED` | **PLANNED** / partial product language — not full TerminalOutcome enum member |
| `INVALID_TASK` | **PLANNED** as first-class terminal |
| `NEEDS_HUMAN_DECISION` | **PARTIAL** (approvals / blocked paths) |

Do not invent runtime support where the enum does not exist.

---

## 6.8 Verifier architecture

### Current three-part reality (do not collapse)

1. **Chat completion honesty gate** — mid-loop refuse/continue/block (`completionGatePolicy.ts`).
2. **Shared kernel decision** — accept/downgrade `VERIFIED_COMPLETE` (`kernel.ts` `decideCompletion`).
3. **Pipeline required-verifier demotion** — post-run plan vs tool log (`requiredVerifierContract.ts`).

### Also present

| Piece | Maturity |
|-------|----------|
| Structured verifier parse (`parseStructuredVerifierCommand`) | **IMPLEMENTED** |
| R9 dependency integrity hash | **IMPLEMENTED** (detect + escalate) |
| `IndependentVerifier` clean copy | **PROTOTYPE** (tests; not live chat path) |
| Revision-bound receipts | **PROTOTYPE** / **PARTIAL** |
| Lossy pipeline `normalizeCommand` | Known **risk** |

### Target

Independent mount, structural identity, directional coverage (full suite covers targeted; not reverse), held-out checks for promotion.

---

## 6.9 Isolation architecture

| Mechanism | Behavior | Maturity |
|-----------|----------|----------|
| Execution profiles | `safe_repo` (Docker preferred), `dev_local` (host), etc. | **IMPLEMENTED** |
| Docker | `--network none`, cap-drop, project mount | **IMPLEMENTED** when active |
| Host spawn | Allowlist + operator rules + `getSafeEnv()` | **IMPLEMENTED** |
| Host fallback | When Docker/image unavailable | **IMPLEMENTED** — **not fail-closed** |
| Fail-closed governed isolation | Block or escalate | **TARGET** (H13) |

Do not overstate isolation on host fallback paths.

---

## 6.10 Evidence architecture

### Current streams

| Stream | Surface | Owner |
|--------|---------|-------|
| `thread_events.json` | Chat | threadEventLog |
| `session-events.jsonl` | Chat | sessionEvents |
| EvidenceBundle JSON files | Pipeline | evidence.ts |
| Effect ledger | Mutations | effectLedger |
| Benchmark reports | Eval | agent benchmark |

### Target relationship (PLANNED unified episode)

```text
SessionDescriptor
  → CanonicalExecutorEvent[] (seq + schemaVersion)
       tool / mutation / verifier / completion / recovery
  → workspace revision identity
  → artifact refs + cost records
```

`CanonicalExecutorEvent` is **IMPLEMENTED** as a type; end-to-end single-stream persistence is **PARTIAL** / **PLANNED**.

---

## 6.11 Change protocol

Changes to any of the following MUST trigger architecture review and updates to this spec, ADR notes if decision changes, source map, conformance tests, and golden fixtures when externally observable:

- `executor/kernel.ts`, `executor/contracts.ts`
- completion gate policy
- mode policies / controller routing
- tool aliases or effect classification
- sandbox backend selection
- verifier authority
- revision identity
- terminal outcomes
- canonical event schemas
- evidence persistence
- rollback semantics

---

## 6.12 Known gaps and roadmap (do not implement in architecture freeze)

Priority order:

1. Structural verifier identity and directional coverage.
2. Revision-bound independent verifier receipts in Chat.
3. Fail-closed governed isolation (H13).
4. Canonical unified episode stream.
5. Held-out or clean-room promotion verification.
6. Model-fixed harness evaluation.
7. Adversarial no-op and verifier-tamper suites.

---

## Source map (normative navigation)

| Priority | Path |
|----------|------|
| 1 | `babel-cli/src/agent/chatEngine.ts` |
| 2 | `babel-cli/src/agent/completionGatePolicy.ts` |
| 3 | `babel-cli/src/executor/kernel.ts` |
| 4 | `babel-cli/src/executor/contracts.ts` |
| 5 | `babel-cli/src/interactive/execution/chatCore.ts` |
| 6 | `babel-cli/src/agent/chatEngineObservability.ts` |
| 7 | `babel-cli/src/pipeline.ts` |
| 8 | `babel-cli/src/pipeline/executorLoop.ts` |
| 9 | `babel-cli/src/sandbox.ts` |
| 10 | `babel-cli/src/config/executionProfiles.ts` |
| 11 | `babel-cli/src/services/worktreeSafety.ts` |
| 12 | `babel-cli/src/services/requiredVerifierContract.ts` |
| 13 | `babel-cli/src/schemas/agentContracts.ts` |
| 14 | `babel-cli/src/config/chatEngineLimits.ts` |

---

## Document control

- **SUPERSEDES**: prior informal “primary harness” claims in overview/mode docs.
- **Version**: `harness-v1` — increment only with ADR + conformance updates.
- **last_verified**: 2026-08-03 against live `babel-cli` sources listed above.
