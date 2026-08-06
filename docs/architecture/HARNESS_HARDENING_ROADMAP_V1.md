<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
-->

```yaml
status: CANONICAL_ROADMAP
roadmap_version: harness-hardening-v1
architecture_version: harness-v1
authority: implementation sequencing subordinate to HARNESS_ARCHITECTURE_V1.md
last_verified: 2026-08-05
baseline_commit: 7bef9c7
```

# Babel Harness Hardening Roadmap v1

> **Authority**: This is the single canonical implementation roadmap for hardening Babel's runtime harness.
> It sequences work under the normative [Harness Architecture v1](./HARNESS_ARCHITECTURE_V1.md); it does not redefine that architecture.
> If this roadmap conflicts with the normative specification, the specification wins and both documents must be reconciled in the same change.

## 1. Objective

Turn Babel's architecturally strong pre-1.0 harness into a durable, policy-bound, replayable execution system whose reliability can be measured independently from the underlying model.

The target is not a permanently perfect harness. The target is a harness whose:

- task and instruction authority cannot silently drift during a run;
- context can compact without losing operational truth;
- tools, mutations, verification, and completion remain controller-owned;
- interrupted work can resume without inventing success or repeating effects;
- verifier evidence is revision-bound, scope-correct, and promotion-gated;
- failures become regression fixtures; and
- improvements are evaluated with the model and environment held fixed.

```text
Reliable execution
=
frozen task and policy authority
→ bounded action
→ revision-linked evidence
→ independent verification
→ typed recovery or honest completion
```

## 2. Authority and document reconciliation

This roadmap consolidates the implementation work previously distributed across historical architecture narratives, parity plans, implementor progress notes, operator-harness plans, critiques, and research conversations.

| Prior artifact class | Disposition |
|----------------------|-------------|
| Harness architecture narratives written before `harness-v1` | **HISTORICAL** — architecture authority moved to [HARNESS_ARCHITECTURE_V1.md](./HARNESS_ARCHITECTURE_V1.md) |
| Codex/peer harness parity implementation plans | **SUPERSEDED FOR PRODUCT SEQUENCING** — unresolved work is mapped into H1–H7 below |
| Implementor W0–W3 progress notes | **EVIDENCE INPUT** — completed slices form the baseline; residual observability and review work maps to H2, H6, and H7 |
| CLI hardening/product roadmaps | **REFERENCE ONLY** — broad product work is outside this roadmap unless it changes a harness invariant |
| Workspace/operator harness plans | **SEPARATE SCOPE** — workstation aliases, external runner operations, and operator adoption are not Babel runtime architecture |
| Comparative critiques and market audits | **RESEARCH INPUT** — useful hypotheses, not runtime authority or product parity evidence |

The following implementation packages are already part of the baseline and must not be reopened as if they were unimplemented:

- canonical `harness-v1` specification, ADR, conformance tests, drift checker, and golden contract fixtures;
- shared executor contracts/kernel across Chat, Plan, and Deep;
- controller-owned completion decisions and false-green downgrades;
- structural verifier identity and directional full-versus-targeted coverage;
- Chat revision-bound receipts and evidence-graph completion checks;
- fail-closed isolation-required profiles with explicit host-boundary escalation;
- IndependentVerifier opt-in and high-assurance profile defaults; and
- validated, hash-linked Chat and pipeline episode producers with observable degraded persistence.

## 3. Research synthesis and evidence rules

Three August 2026 research conversations were reconciled against current main:

- **Coding Agent Reliability** contributed the eleven-subsystem audit lens, multiplicative reliability thesis, layered-oracle model, anti-reward-hacking boundary, and model-fixed harness evaluation design.
- **Context Management Review** contributed the confirmed compaction P0 findings, layered context architecture, exact-recovery-first ordering, and the requirement to bind live, persisted, and resumed provider context.
- **AI Coding Harness Audit** contributed the Policy-Bound LiveSession vertical slice, specialized-role hypothesis, harness/model separation, and stricter evidence-quality rules for competitor comparisons.

Accepted principles:

1. Tests are executable oracles, not absolute ground truth.
2. Prompts guide behavior; security and completion policy must be enforced outside the model.
3. Context selection, compression, persistence, retrieval, and budget control are separate responsibilities.
4. The complete transcript belongs in durable storage; the model receives a curated working set plus canonical state.
5. Exact path, symbol, command, hash, and event recovery precedes vector or semantic memory.
6. Planner, executor, reviewer, and verifier roles should receive the smallest role-appropriate context and tool surface.
7. The harness-model pair is the evaluation unit, but harness lift requires same-model, same-task, same-environment comparisons.
8. Social preference, product popularity, benchmark rank, and measured harness reliability are different claims.

Rejected as roadmap evidence:

- universal token-reduction percentages;
- unsupported market-share or preference rankings;
- broad product superiority inferred from one benchmark configuration;
- treating official feature existence as proof of live reliability;
- treating more tools, more agents, or larger context as automatic improvement; and
- calling a simulated contract fixture an end-to-end runtime proof.

## 4. Target vertical slice: Policy-Bound LiveSession

The roadmap converges on one durable substrate shared by the three existing controllers. It does **not** collapse Chat, Plan, and Deep into one orchestration policy.

```text
TaskContractV1
  + resolved InstructionManifestV1
  + ContextBudgetSnapshot
            ↓
mode-specific controller
            ↓
typed tool / approval / mutation lifecycle
            ↓
workspace revision + verifier receipts
            ↓
controller-owned TerminalDecision
            ↓
hash-linked episode + exact resume
```

The live session must bind:

- user request, task class, acceptance criteria, non-goals, paths, budgets, and allowed terminal outcomes;
- selected instruction fragments, rule IDs, source hashes, precedence, scope, and selection reasons;
- plan-step-to-policy bindings;
- model attempts and failovers;
- tool request, authorization, start, progress, completion, interruption, and idempotency state;
- mutation prepare/commit/rollback with pre/post revision evidence;
- verifier identity, scope, environment, receipt, and freshness;
- compaction commits and the context state they replace;
- repair attempts and typed failure capsules; and
- the final deterministic terminal decision.

Policies must be classified before enforcement:

| Policy class | Example | Authority |
|--------------|---------|-----------|
| Mechanically enforceable | protected paths, network boundary, allowed effects | tool/capability/mutation gate |
| Verifier enforceable | required checks, artifact schemas, scope constraints | verifier profile and completion gate |
| Advisory semantic | prefer simple abstractions, domain judgment | planner/reviewer with explicit non-authoritative status |

Acknowledging a rule in model text does not make it enforced.

## 5. Delivery waves

### H0 — Canonical foundation

**Status: COMPLETE on baseline commit**

Delivered:

- one normative architecture;
- three controllers with one shared executor contract boundary;
- controller-owned completion;
- structural verifier scope;
- revision-bound Chat proof;
- fail-closed governed isolation;
- high-assurance clean-room defaults; and
- Chat/pipeline episode producers.

Regression gate:

- `tools/check-harness-architecture.ps1` and executor conformance tests remain green.

### H1 — Context integrity and compaction correctness

**Status: COMPLETE** (live evidence: `babel-cli/src/agent/compactionCommit.test.ts`, `chatCompaction.test.ts`; commit path `compactionCommit.ts` + `ChatEngine.compactIfNeeded`)

Why first: the pre-H1 live path could report successful compaction while losing the generated summary and leaving durable provider history unchanged. Those six defects are closed on the commit path below.

Pre-H1 defects (closed):

1. ~~`LLMSummarizeCompaction` summary discarded by `compactIfNeeded` reconstruction~~ → `assembleCompactedConversation` preserves `compaction_summary`.
2. ~~LLM failure returned `compaction_fallback` blocking manager heuristic~~ → LLM strategy rethrows; manager advances to `heuristic-truncation`.
3. ~~No durable `compaction_capsule` / `compaction_created` write~~ → `commitCompaction` dual-writes thread + session events.
4. ~~Manager success always labeled `llm`~~ → `compactWithResult` returns authoritative strategy id; `strategyToCompactMode` maps it.
5. ~~Model-family passed as compaction model~~ → `resolveCompactionModelId` prefers provider model id / env / default.
6. ~~Incomplete token/capsule contract~~ → `ContextBudgetSnapshot` + expanded `CompactionCapsule` with operational fields and raw observation refs.

Deliverables:

- one canonical compaction commit operation (`commitCompaction` / `runChatEngineCompaction`) that updates conversation, thread events, and session events recoverably;
- structured compaction results with strategy, status, before/after request tokens, preserved IDs, and evidence references;
- true heuristic fallback after LLM summarization failure;
- one `ContextBudgetSnapshot` for next-request size, system/tool reserves, active window, canonical state, retrieved context, output reserve, and headroom;
- an expanded deterministic state capsule containing task/acceptance identity, current plan step, changed paths, unresolved failures, verifier freshness, approvals, budgets, workspace revision, and evidence references;
- deterministic observation reduction with immutable raw-log references; and
- provider-aware summarization model resolution.

Exit gates (all covered by shipped tests in `compactionCommit.test.ts` / `chatCompaction.test.ts`):

- successful LLM summary survives into the next actual provider request;
- failed LLM compaction executes the heuristic fallback without destructive state loss;
- live post-compaction and cold-resume provider messages are equivalent;
- complete tool-call/result cycles remain paired;
- repeated compactions use only the latest authoritative capsule;
- persistence failure produces an explicit degraded or blocked state, never silent divergence; and
- critical-fact retention and token reduction are measured on long-session fixtures.

### H2 — Policy-Bound LiveSession and crash recovery

**Status: COMPLETE** (controller-level evidence: `liveSession.controller.test.ts` + `liveSession.test.ts`)

Live path:

- `ChatEngine` constructor freezes `InstructionManifestV1` + `TaskContractV1` via `initLiveAuthorityOnEngine` and persists them under the session run dir.
- `checkpointParityEventLog` / `finalizeParityTurnSync` dual-write `budget_snapshot`, reproject `LiveSession`, and persist `live-session-snapshot.json`.
- `restoreSessionEvents` reloads authority from disk, settles interrupted tools, and reprojects LiveSession (no invented success / no double-mutate).

Exit gates proven on controller path: task/manifest restore, completed idempotency deny, interrupted non-retry, crash-boundary projections never invent `VERIFIED_COMPLETE`, plan contract read-only effects, disk resume equivalence.

Deliverables:

- evolve the existing prompt manifest into `InstructionManifestV1` rather than creating a competing instruction authority;
- bind rule IDs and source hashes to affected plan steps and runtime decisions;
- complete SessionEvent coverage for policy, compaction, budget, approval, mutation, verifier, repair, and terminal boundaries;
- define one recoverable live-session state projection from durable events;
- preserve remaining budgets and idempotency keys across resume; and
- add forced-termination fixtures at every non-idempotent boundary.

Exit gates:

- restart restores the same active task, instruction manifest, provider context, policy state, tool state, workspace revision, verifier state, and remaining budget;
- interrupted non-idempotent effects are not blindly retried;
- completed idempotency keys cannot mutate twice;
- policy fragments cannot disappear through compaction, failover, subagent handoff, or resume; and
- every terminal outcome can be reconstructed from durable evidence.

### H3 — Universal task contract and honest outcome taxonomy

**Status: COMPLETE** (evidence: `taskContract.ts` + H3 tests + ChatEngine constructor freeze via `liveSessionBridge` / `getTaskContract()`)

- Frozen contract identity on every ChatEngine construction; plan profile restricts `allowed_effects` to `read_only`.
- Honest outcomes `NO_CHANGE_REQUIRED` / `INVALID_TASK` / `NEEDS_HUMAN_DECISION` with exit-code mapping and live UI status mappers.
- FailureClass budgets: infrastructure retries do not consume implementation-repair budget.

Deliverables:

- one frozen `TaskContractV1` for Chat, Plan, and Deep;
- baseline reproduction and baseline verifier state for mutating work;
- first-class `NO_CHANGE_REQUIRED`, `INVALID_TASK`, and `NEEDS_HUMAN_DECISION` decisions where product semantics warrant them;
- one cross-surface `FailureClass` capsule separating task, context, implementation, verifier, infrastructure, policy, provider, and budget failures; and
- recovery budgets keyed by failure class rather than one generic retry count.

Exit gates:

- acceptance criteria cannot change silently after execution begins;
- already-fixed and invalid-task fixtures do not produce action-biased patches;
- infrastructure retries do not consume implementation-repair budget;
- Chat/TUI/headless/persistence/exit code agree on the terminal outcome; and
- Plan remains read-only and cannot authorize executor-style verified completion.

### H4 — Capability broker and transactional effects

**Status: COMPLETE** (evidence: `capabilityBroker.ts` wired into `executeActionWithPolicy`; H4 suite + toolExecutor tests)

- Unknown/external effects fail conservatively; plan mode denies mutations; dirty-tree and protected-path fail-closed.
- Effect transaction records with true rollback reporting (success/failed/partial).
- Isolation unavailable never silently becomes host execution (`wouldSilentHostFallback` / broker deny).

Deliverables:

- complete typed effect classification and capability checks across the tool surface;
- narrow overlapping tools and expose structured denial reasons;
- transaction or reconciliation records for shell-side effects, not only direct file writes;
- explicit boundary-escalation evidence for host execution; and
- cleaner `safe_repo` profile UX without weakening H13.

Exit gates:

- unknown tools/effects are treated conservatively;
- every reconcilable mutation is linked to task, plan step, policy decision, pre/post revision, and rollback semantics;
- dirty-tree and protected-path behavior remains fail-safe; and
- sandbox unavailability cannot silently become host execution.

### H5 — Verifier Kernel promotion and anti-reward-hacking

**Status: COMPLETE** (evidence: `verifierKernel.ts` + H5 suite; hooked into `evaluateCompletionGateForEngine` for strict mutating work)

- Richer `VerifierReceiptV2`, min profiles by task class, empty-plan / targeted-as-full / stale / wrong-revision / adversarial denials.
- Legitimate full-suite green still authorizes; baseline structural honesty remains primary authority with H5 as additive strict gate.

Structural command identity and directional coverage are baseline capabilities, not work items here.

Deliverables:

- richer verifier receipts: exact argv, cwd, environment/profile hash, container identity, timing, exit/signal/timeout, normalized test counts, output hashes, baseline/candidate pairing, and flake history;
- minimum verifier profiles by mutating task class;
- read-only or separately provisioned verifier definitions for high-risk profiles;
- held-out, property, metamorphic, mutation, differential, security, performance, accessibility, or UI checks selected by risk rather than universally enabled;
- evidence-driven promotion policy for clean-room verification beyond current high-assurance profiles; and
- specialized diff-review and verification roles with narrow context, deterministic coverage, and explicit precision/recall tradeoffs.

Exit gates:

- an empty required-verifier plan cannot green a mutating task that requires proof;
- targeted runs cannot satisfy full-suite requirements;
- stale or wrong-revision receipts cannot authorize current completion;
- verifier tampering and shortcut solutions fail adversarial fixtures; and
- legitimate solutions still pass after verifier hardening.

### H6 — Replay consumers, operator truth, and live golden episode

**Status: COMPLETE** (evidence: `episodeReplay.ts` + `episodeReplay.liveGolden.test.ts` + H6 suite)

- Model-free terminal replay; cross-surface facts via live status/exit mappers.
- Golden builder requires explicit `live_runtime` provenance (never hard-coded true by default).
- **Runtime-generated golden through real controller/workspace:** `runLiveControllerGoldenEpisode` drives `ChatEngine.submitMessage` on a real temp workspace with a mock native-tools runner (no external model API). The monomorphic loop dual-writes session/thread events; harvest → `live_runtime: true` golden → validate → model-free replay.
  - One-command verify: `cd babel-cli && npx tsx --test src/agent/episodeReplay.liveGolden.test.ts`
- Residual product UX (not exit-gate blockers): full TUI scrollback product surface, true interactive single-file live rows in the operator TUI.

Deliverables:

- cross-mode episode replay consumers;
- TUI/session inspection for policy, compaction, tool, mutation, verifier, and completion history;
- indexed long-session loading and scrollback;
- production telemetry for cancellation and process-tree cleanup;
- true interactive single-file live rows; and
- graduate the simulated golden contract fixture into a runtime-generated golden episode.

Exit gates:

- one command can run and validate the golden episode through a real controller/workspace path;
- replay reaches the same deterministic terminal decision without model calls;
- TUI, headless JSON, persisted events, and CLI status show the same facts; and
- degraded evidence persistence is visible to the operator.

### H7 — Model-fixed evaluation and continuous harness hardening

**Status: COMPLETE** (offline + same-model LLM factorial measured; [ADR-013](../adr/ADR-013-h7-model-path-experimental-deferral.md))

Evidenced:

- Local eval substrate: fixed controls, metrics, paired deltas, failure ledger, promotion records, suite registry (`harnessEval.ts` + tests).
- Offline harness-factor factorial (`runOfflineHarnessFactorial`) — `experimental_evidence: true` for non-LLM harness paths.
- Same-model LLM factorial (`runSameModelLlmFactorial`) — fixed `openrouter:openai/gpt-4o-mini@temp0`, temp=0, fixed task set / revision / permissions / verifier / resource / environment digest; variants `minimal_loop` | `chat_harness` | `deep_profile` (ChatEngine deep profile); paired deltas + uncertainty; infra vs agent rates separated.
- Promotion gate schema: pre-fail / post-pass / held-out / rollback validation.

**Out of scope / disclosed limits (ADR-013):**

- Full multi-stage Deep pipeline factorial (deep cell = ChatEngine `executionProfile=deep`);
- competitor model-path comparisons;
- production reliability marketing claims beyond measured task set.

Deliverables:

- repeated same-model factorial comparisons for minimal loop, Chat, Deep-profile → **IMPLEMENTED** (`runSameModelLlmFactorial`);
- fixed task, model snapshot, sampling parameters, repository revision, permissions, verifier, resource profile, and environment digest → **IMPLEMENTED**;
- dedicated suite registry for no-op, stale-context, dirty-tree, prompt-injection, verifier-tamper, flake, missing-dependency, network-denied, resource-exhaustion, false-completion, crash/resume, compaction, policy disappearance, idempotency → **IMPLEMENTED** as suite ids (runners expand over time);
- failure ledger linking episodes to fixtures → **IMPLEMENTED**;
- held-out promotion gates for harness changes → **IMPLEMENTED** (schema + validation).

Core measures (offline + same-model LLM cells):

```text
verified completion without policy violation / token
verified completion without policy violation / minute
false-completion rate
instruction-policy violation rate
resume-state equivalence rate
critical-fact retention after compaction
infrastructure failure rate
agent failure rate
clean-room promotion pass rate                         (when clean-room receipts present)
human intervention burden
```

Exit gates:

- harness claims report paired task-level deltas and uncertainty, not one best run → offline + same-model factorial;
- infrastructure and agent failures remain separate → metrics fields;
- every promoted hardening change has pre-fail / post-pass / held-out / rollback path → `validatePromotionRecord`;
- competitor model-path comparisons → out of scope (ADR-013 disclosure).

## 6. Dependency order

```text
H0 canonical foundation
  ↓
H1 context integrity
  ↓
H2 policy-bound durable session
  ├─→ H3 task/outcome taxonomy
  ├─→ H4 capability/transaction effects
  └─→ H5 verifier promotion
          ↓
H6 replay/operator/live golden
          ↓
H7 model-fixed promotion loop
```

H3–H5 may proceed in parallel only after H2 freezes the shared event and authority boundaries. File ownership must be partitioned before parallel implementation.

## 7. Scope guardrails

This roadmap does not authorize:

- collapsing the three product controllers into one policy;
- replacing deterministic state with narrative summaries;
- building vector memory before exact recovery and compaction correctness;
- expanding MCP/tool/subagent surface without measured need;
- enabling clean-room tree copies on the everyday hot path without performance evidence;
- treating a public benchmark score as proof of general product parity; or
- adding another active harness roadmap.

## 8. Change and completion protocol

For each wave:

1. Re-read the normative architecture and this roadmap.
2. Confirm the baseline in live code; research conversations are hypotheses, not authority.
3. Add a failing characterization or regression fixture before changing behavior.
4. Update contracts, implementation, tests, architecture maturity, and roadmap status together.
5. Run the proportionate package checks plus harness architecture and public-content gates.
6. Record measured evidence; do not convert fixture behavior into broader reliability claims.

This roadmap is complete only when H1–H7 exit gates are met or explicitly removed through an ADR-backed scope decision. Completion of one wave must not be described as completion of the whole hardening program.

## 9. Canonical navigation

| Need | Authority |
|------|-----------|
| Runtime norms and invariants | [HARNESS_ARCHITECTURE_V1.md](./HARNESS_ARCHITECTURE_V1.md) |
| Hardening sequence and exit gates | **This roadmap** |
| Short explanatory topology | [HARNESS_OVERVIEW.md](./HARNESS_OVERVIEW.md) |
| Architecture decision | [ADR-012](../adr/ADR-012-canonical-harness-architecture-v1.md) |
| Current implementation hot paths | `babel-cli/PROJECT_CONTEXT.md` |
| Executable architecture invariants | `babel-cli/src/executor/architectureConformance.test.ts` |
| Contract fixtures | `examples/golden-harness/` |
| Drift detection | `tools/check-harness-architecture.ps1` |

