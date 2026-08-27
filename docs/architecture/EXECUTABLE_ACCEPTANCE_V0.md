<!-- License: Apache-2.0 — see LICENSE -->

<!--
status: IMPLEMENTED_LOCALLY__EMPIRICAL_CELLS_PENDING
last_verified: 2026-08-26
authority: non-normative campaign contract, subordinate to harness-v1
-->

```yaml
status: IMPLEMENTED_LOCALLY__EMPIRICAL_CELLS_PENDING
campaign: executable-acceptance-v0
architecture_version: harness-v1
authority: non-normative; does not redefine harness-v1
last_verified: 2026-08-26
baseline_branch: codex/bdns-b0-architecture
baseline_commit: 985385a
assumed_bdns: EvidenceCandidateV1 + session-owned attach at canonical flush
```

# Babel Executable Acceptance — V0 Campaign

## Status

This is the campaign contract for Executable Acceptance V0. It is **not**
normative harness architecture. `HARNESS_ARCHITECTURE_V1.md` remains the
authority for completion, modes, and `VERIFIED_COMPLETE`. BDNS remains the
independent sensor layer defined in `BDNS_ARCHITECTURE_V1.md`.

Runtime slices in this campaign must remain subordinate to those documents.
If a slice would require changing `VERIFIED_COMPLETE` semantics, replacing
`TaskContractV1`, or giving BDNS semantic authority, the campaign stops for
architecture revision.

## Research question

Given only an engineering task, authoritative constraints, and the
pre-implementation repository state, can Babel independently construct a
frozen executable acceptance contract and a discriminative verification plan
that catches consequential false completions beyond Babel's existing
verifier/critic stack, **and** beyond a strong model using a cheap adversarial
verification skill, without imposing unacceptable false-rejection or
human-intervention burden?

Every slice in this campaign must help answer that sentence. If a proposed
feature does not, it belongs somewhere else.

## Why now

The 2026-08 competitive-moat research and the 2026-08-25 re-audit converge on
one gap:

Babel already owns **completion**. It does not yet own **what success means**.

That is now the differentiated bet. Provenance, permission boundaries, AI-BOMs,
session hash chains, and adversarial verification prompting are being
productized around Babel. "Ask the model to falsify its own work" is already a
portable adversarial verification skill. The harder, still-uncommoditized problem is
runtime-enforced separation of authority:

```text
frozen authoritative intent
        ↓
patch-blind acceptance claims
        ↓
independent oracle planning
        ↓
scoped / revision-bound evidence admission
        ↓
claim-level sufficiency
        ↓
ACCEPT / REJECT / ESCALATE / INSUFFICIENT_EVIDENCE
```

BDNS is complete enough to act as the sensor layer. It must not become the
brain.

## Key decisions

| Decision                                                  | Choice                                                                                 | Why                                                                                                                             |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| V0 does not change `VERIFIED_COMPLETE`                    | Sufficiency verdicts are experimental/diagnostic                                       | The research question is falsifiable only if the current kernel remains the control arm                                         |
| New type, not a mutation of `TaskContractV1`              | `ExecutableAcceptanceContractV0`                                                       | TaskContract already freezes authority; its `acceptance_criteria` are placeholders. Do not overload it                          |
| Existing `AcceptanceContract` is left alone               | Keep `evidence/acceptanceContracts.ts` as graph-coverage                               | That type checks node presence (`patch`, `verifier_receipt`). It is not semantic acceptance. Renaming it in V0 is a distraction |
| IntentPlan is not the acceptance contract                 | IntentPlan stays a briefing artifact                                                   | Merging them would let heuristic intent rewrite success. The transcript forbade this                                            |
| Compiler is patch-blind                                   | Sees task, baseline snapshot, policies; never the candidate patch or implementor prose | Prevents circular proof                                                                                                         |
| Compiler output is hidden from the implementor by default | V0 flag to reveal for debug only                                                       | Otherwise the implementor optimizes the contract instead of the task                                                            |
| Sufficiency engine is deterministic                       | No LLM judge in V0                                                                     | A second model reviewer is not independent acceptance                                                                           |
| BDNS is a sensor, not a judge                             | Consume `EvidenceCandidateV1` only                                                     | Invariants 11 and 12 from the BDNS campaign                                                                                     |
| Adversarial verification is a baseline arm, not a Babel feature | Same model plus an adversarial verification skill vs Acceptance V0                  | If V0 cannot beat that cheap baseline on consequential false completions, kill or shrink the architecture                       |
| Promotion is measured                                     | V0 never writes kernel completion                                                      | A later campaign may consult sufficiency only after pre-registered lift                                                         |
| Start on Chat/headless experimental path                  | Not a Deep-mode rewrite                                                                | Deep already has a verifier contract. The semantic gap is largest on daily Chat                                                 |

## Authority and non-goals

### Owns

- Compiling frozen, patch-blind acceptance claims from pre-implementation inputs.
- Planning discriminative oracles against those claims.
- Admitting evidence to claims without promoting inferences to facts.
- Emitting a sufficiency verdict that is **not** a terminal outcome.

### Does not own

- Tool execution, mutation authority, or mode policy.
- Canonical session events, workspace transactions, or verifier receipts.
- BDNS observation, incidents, or diagnostic storage.
- `kernel.completion.decide` or `TerminalOutcome` vocabulary in V0.

### Non-goals

- Rewriting ChatEngine.
- Redesigning Deep mode.
- Merging IntentPlan and the executable acceptance contract.
- Making generated tests the only evidence.
- Building GitHub Marketplace, organizations, billing, or agent IAM.
- Expanding the authority engine unless the experiment requires it.
- Rebranding Babel around this thesis before measured evidence exists.
- A second EvidenceGraph, a BDNS B9, or an incident dashboard.

## Relationship to existing systems

```text
HUMAN INTENT
      │
TaskContractV1 (frozen authority: paths, effects, budgets, terminal vocabulary)
IntentPlan (briefing only; not success)
      │
AcceptanceInputSnapshot (pre-implementation, patch-blind)
      │
ExecutableAcceptanceContractV0     ← this campaign
      │
OraclePlanV0
      │
implementation (ChatEngine / experimental arm)
      │
      ├── existing verifiers / IndependentVerifier / hidden tests
      ├── BDNS EvidenceCandidateV1
      └── receipts, revisions, workspace transactions
              │
     ClaimEvidenceLinkV0
              │
     SufficiencyEngineV0
              │
     ACCEPT / REJECT / ESCALATE / INSUFFICIENT_EVIDENCE
              │
     V0: recorded beside the run; does not decide TerminalOutcome
     Later: may become an input to kernel.completion.decide
```

Forbidden arrow: any post-implementation observation, including BDNS, flowing
back into "what did the original task require?"

## Current-state census

Baseline: branch `codex/bdns-b0-architecture` at `985385a`, plus the BDNS
enablement already in the worktree (`EvidenceCandidateV1`, session attach at
canonical flush, `toolCallId` on `shellExecAsync`).

### Intent

| Piece        | Path                                          | What it actually does                                                                                                           |
| ------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| IntentPlan   | `babel-cli/src/agent/intentCompiler.ts`       | Heuristic expansion of task text into goal / success_criteria / likely files. Injected as briefing. Confidence is low by design |
| User request | ChatEngine options / session `user_submitted` | Source of intent. Not compiled into falsifiable claims                                                                          |

### Task authority

| Piece             | Path                                          | What it actually does                                                                                                                   |
| ----------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `TaskContractV1`  | `babel-cli/src/agent/taskContract.ts`         | Frozen identity: mode, paths, effects, budgets, verifier requirements, allowed terminals. **IMPLEMENTED** and hash-locked               |
| Chat freeze       | `babel-cli/src/agent/liveSessionBridge.ts`    | Builds the contract with `acceptance_criteria: ['Task acceptance criteria as stated in the user request']` — a placeholder, not a claim |
| V9 freeze         | `babel-cli/src/pipeline/liveSessionParity.ts` | Sets `acceptance_criteria: [input.task]` — the raw prompt, not a discriminative criterion                                               |
| Portable workflow | `babel-cli/src/portable/workflow.ts`          | Has `acceptance_criteria: string[]` as a portable field. Same shallow semantics                                                         |

The freeze machinery is real. The semantic payload is not.

### Mutation authority

Unchanged by this campaign. Workspace transactions, effect classes, plan-mode
read-only, and FileWriteMutex stay where they are.

### Verification

| Piece                   | Path                                                                     | What it actually does                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Honesty gate            | `babel-cli/src/agent/completionGatePolicy.ts`                            | Blocks verified completion without required verifier evidence                                                                                         |
| Kernel decide           | `babel-cli/src/executor/kernel.ts` `decideCompletion`                    | Accepts `VERIFIED_COMPLETE` only when `proof.compliant && gate.allow`; otherwise downgrades to `UNVERIFIED_PATCH`                                     |
| Graph-coverage contract | `babel-cli/src/evidence/acceptanceContracts.ts`                          | Requires child nodes of types `patch` / `verifier_receipt` / `env_state` / `critic_approval`. Does **not** ask whether a behavioral requirement holds |
| EvidenceGraph           | `babel-cli/src/evidence/evidenceGraph.ts`                                | DAG plus stale-receipt checks. Not a claim-evidence graph                                                                                             |
| IndependentVerifier     | `babel-cli/src/evidence/independentVerifier.ts`                          | Clean-room re-run. Opt-in / high-assurance profiles. Oracle of "command still green", not "claim still true"                                          |
| Required verifiers      | `babel-cli/src/services/requiredVerifierContract.ts`                     | Pipeline proof-carrying completion                                                                                                                    |
| Hidden grading          | `babel-cli/src/eval/cleanRoomGrade.ts`, `eval/diagnostics/completion.ts` | `hidden_ok` vs claimed complete for **eval**, not live Chat                                                                                           |

### Evidence and observation

| Piece                      | Path                                                  | Role in V0                                                          |
| -------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| SessionEventV1             | `babel-cli/src/agent/sessionEvents.ts`                | Canonical lifecycle facts                                           |
| BDNS `EvidenceCandidateV1` | `babel-cli/src/diagnostics/bdns/evidenceCandidate.ts` | Independent observation candidates. Never carry acceptance verdicts |
| Workspace transactions     | `babel-cli/src/services/workspaceTransactions.ts`     | Declared mutation receipts                                          |
| Revision-bound receipts    | `babel-cli/src/evidence/revisionBoundReceipt.ts`      | Stale-verifier defense                                              |

### Completion and evaluation

| Piece             | Path                                                                                  | Role in V0                                           |
| ----------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `TerminalOutcome` | `babel-cli/src/schemas/agentContracts.ts`                                             | Live CLI honesty vocabulary. **Do not extend in V0** |
| `false_complete`  | `babel-cli/src/eval/projectEpisode.ts`, `benchmarks/`                                 | Scoring overlay, not a live terminal                 |
| Experimental arms | `docs/roadmaps/OX_ALPHA_EXPERIMENTAL_PROGRAM.md`, `src/services/campaignExecutors.ts` | Reuse for the blinded V0 experiment                  |
| Governance corpus | `benchmarks/task-manifest.json`                                                       | Existing `false_complete` fixture kinds              |

### Call sites that must not regress

- `executor/kernel.ts` `decideCompletion`
- `agent/completionGatePolicy.ts` `evaluateExecuteCompletionHonesty`
- `agent/taskContract.ts` freeze / `validateTaskContractV1`
- `evidence/completionEvidence.ts` graph-coverage evaluation
- `agent/chatEngine.ts` `streamDone` / `buildResult` finalize
- `services/requiredVerifierContract.ts` Deep proof path
- BDNS Invariants 11 and 12

## Semantic gap

Today Babel can say, with high confidence:

- the model asked to finish;
- a required verifier command ran;
- the receipt is bound to a revision;
- the receipt is not stale;
- the evidence graph has the expected node types.

It cannot yet say:

- what exact behavioral claims the original task required;
- which of those claims the available evidence bears on;
- whether a green test suite is a proxy or a proof;
- whether BDNS-observed undeclared mutation falsifies a "read-only inspection" claim;
- when the honest answer is **not proven**.

That is the gap V0 attacks.

## Target architecture

### Epistemic split (do not merge)

BDNS epistemics answer **what happened?**

`FACT` / `INFERENCE` / `HYPOTHESIS` / `CORROBORATION` / `CONTRADICTION` /
`UNKNOWN` / `TRUNCATED EVIDENCE`

Acceptance epistemics answer **what must be true?**

`EXPLICIT` / `INFERRED` / `AMBIGUOUS` / `UNVERIFIABLE`

A claim classified `AMBIGUOUS` must not be silently compiled into an executable
oracle. It becomes `ESCALATE` or `INSUFFICIENT_EVIDENCE`, not a guessed test.

### Types (V0)

These are the only new public contracts. Keep them in a new module so they do
not collide with `evidence/acceptanceContracts.ts`.

Proposed home: `babel-cli/src/acceptance/` (new directory). Do not grow
`chatEngine.ts`. Do not put this in BDNS.

The implementation lives in `babel-cli/src/acceptance/` and exports these
hash-bound contracts:

```ts
interface AcceptanceInputSnapshotV0 {
  schemaVersion: 0;
  snapshotId: string;
  snapshotHash: string;
  createdAt: string;
  origin: "pre_implementation";
  patchVisibility: "none";
  taskContractId: string;
  taskContractHash: string;
  userRequest: string;
  baseline: {
    gitHead?: string;
    workspaceRevision?: WorkspaceRevision;
    treeDigest?: string;
  };
  baselineVerifiers: Array<{
    command: string;
    exitCode: number;
    digest?: string;
  }>;
  policies: {
    mode: string;
    allowedEffects: string[];
    protectedPaths: string[];
  };
  authoritativeInputs?: Array<{ kind: string; ref: string; digest?: string }>;
}

interface AcceptanceClaimV0 {
  schemaVersion: 0;
  claimId: string;
  statement: string;
  polarity: "must_hold" | "must_not_hold";
  epistemicStatus: "explicit" | "inferred" | "ambiguous" | "unverifiable";
  provenance: Array<{
    sourceKind:
      | "user_request"
      | "task_contract"
      | "policy"
      | "baseline_behavior"
      | "other_authoritative_input";
    sourceRef: string;
  }>;
  scope: { paths?: string[]; behaviors?: string[] };
  falsifier: string;
  required: boolean;
  assurance?: "normal" | "elevated" | "high";
}

interface ExecutableAcceptanceContractV0 {
  schemaVersion: 0;
  contractId: string;
  contractHash: string;
  snapshotId: string;
  snapshotHash: string;
  taskContractId: string;
  taskContractHash: string;
  claims: AcceptanceClaimV0[];
  compiler: { name: string; version: string; patchBlind: true };
  patchBlindProvenance: {
    inputType: "AcceptanceInputSnapshotV0";
    origin: "pre_implementation";
    patchVisibility: "none";
    forbiddenInputs: readonly string[];
  };
  frozen: true;
}

interface OraclePlanV0 {
  schemaVersion: 0;
  planId: string;
  planHash: string;
  snapshotId: string;
  snapshotHash: string;
  contractId: string;
  contractHash: string;
  planner: { name: string; version: string; patchBlind: boolean };
  frozen: true;
  steps: Array<{
    oracleStepId: string;
    claimId: string;
    oracleKind:
      | "existing_test"
      | "hidden_test"
      | "property_probe"
      | "static_probe"
      | "runtime_probe"
      | "bdns_candidate"
      | "independent_verifier"
      | "human";
    command?: string;
    independence: "implementor" | "canonical" | "observer" | "verifier";
    createdBeforePatch: boolean;
  }>;
}

interface ClaimEvidenceLinkV0 {
  schemaVersion: 0;
  linkId: string;
  claimId: string;
  evidenceId: string;
  oracleStepId?: string;
  producerRole: "canonical" | "observer" | "verifier" | "implementor";
  admissible: boolean;
  relation: "supports" | "contradicts" | "inconclusive";
  reason: string;
}

interface SufficiencyResultV0 {
  schemaVersion: 0;
  contractId: string;
  contractHash: string;
  verdict: "ACCEPT" | "REJECT" | "ESCALATE" | "INSUFFICIENT_EVIDENCE";
  claimResults: Array<{
    claimId: string;
    status: "supported" | "contradicted" | "unproven" | "ambiguous";
    evidenceIds: string[];
  }>;
  systemHealth: {
    snapshot: "ok" | "error";
    compiler: "ok" | "error";
    oraclePlanner: "ok" | "error";
    evidenceAdmission: "ok" | "error";
    sufficiency: "ok" | "error";
  };
  errors: string[];
}
```

Forbidden on these types and on BDNS records: using this verdict as
`TerminalOutcome`, or writing `claimSatisfied` onto an observation.

### Module boundaries

| Module                            | Responsibility                                          | Must not                                                      |
| --------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| `acceptance/snapshot.ts`          | Capture pre-implementation snapshot                     | Read candidate patch, agent notes, or BDNS incidents          |
| `acceptance/compiler.ts`          | Produce frozen claims from the snapshot                 | See implementor output; invent oracles for `AMBIGUOUS` claims |
| `acceptance/oraclePlanner.ts`     | Bind claims to oracles                                  | Execute tools; mutate the workspace                           |
| `acceptance/evidenceAdmission.ts` | Link receipts/candidates to claims                      | Treat BDNS incidents as verdicts                              |
| `acceptance/sufficiency.ts`       | Deterministic verdict                                   | Call an LLM; write `TerminalOutcome`                          |
| `acceptance/experiment.ts`        | Blinded arms, scoring, kill-criteria                    | Change product completion policy                              |
| `acceptance/campaign.ts`          | Fail-closed A7a cell coordination and dataset readiness | Launch providers; mutate workspaces; change completion policy |

BDNS, EvidenceGraph, and kernel stay at their current boundaries. Admission
**reads** them. Nothing in `acceptance/` is imported by BDNS.

## Invariants

These are campaign-level. They add to harness-v1; they do not replace it.

1. **Observation is not acceptance.** BDNS and other sensors produce candidates. They do not decide that a claim holds.
2. **Downstream observation cannot define success.** Post-implementation facts cannot alter a frozen contract.
3. **Patch-blind compilation.** The compiler's inputs are the snapshot only.
4. **Hidden contract by default.** Implementor context must not include the compiled claims unless an explicit debug flag is set.
5. **Ambiguity is honest.** `AMBIGUOUS` / `UNVERIFIABLE` claims produce `ESCALATE` or `INSUFFICIENT_EVIDENCE`, never a guessed pass.
6. **No LLM judge in V0.** Sufficiency is a pure function of admitted evidence against frozen claims.
7. **Kernel isolation.** V0 records `SufficiencyResultV0` beside the run. It does not change `decideCompletion`.
8. **Reuse before invention.** Prefer existing tests, IndependentVerifier, hidden eval oracles, and BDNS candidates over generating new tests as the sole proof.
9. **Fail soft.** Compiler/planner/sufficiency failure must not break Chat. Degrade to `INSUFFICIENT_EVIDENCE`.
10. **Serialized slices.** A later slice may not assume an earlier slice until that slice has tests and exact-head review.

## Campaign slices

Serialized, like BDNS B0–B8. Each slice is one PR-sized change set.

### A0 — Freeze this contract

This document, indexes, and a short conformance sketch. No runtime behavior.

Exit: reviewers agree the research question, non-goals, and kernel-isolation rule.

### A1 — Pure types and hashing

Add `babel-cli/src/acceptance/` types, hash, freeze helpers, and tests. No
ChatEngine import.

Exit: round-trip tests; hash changes if a claim statement changes; forbidden
fields rejected.

### A2 — Patch-blind compiler

Inputs: `AcceptanceInputSnapshotV0`. Output: frozen `ExecutableAcceptanceContractV0`.

V0 compiler strategy (professional opinion): **deterministic first**.

1. Lift explicit numbered/bulleted criteria from the user request.
2. Copy TaskContract `acceptance_criteria` only when they are not the current placeholders.
3. Mark remaining goal text as `INFERRED` or `AMBIGUOUS`.
4. Do not emit a required `existing_test` claim unless a test command is already in the snapshot.
5. Optional LLM compile behind `BABEL_ACCEPTANCE_COMPILER=llm`, off by default, still patch-blind, still frozen after emit.

Exit: compiler never reads files under a candidate patch directory; placeholder
TaskContract criteria are classified `AMBIGUOUS` rather than treated as proof.

### A3 — Oracle planner

Bind each required claim to an oracle **kind** using existing machinery:

- discovered project tests → `existing_test`
- eval hidden tests / clean-room grade → `hidden_test` (eval path only)
- IndependentVerifier → `independent_verifier`
- BDNS process/workspace mismatch categories → `bdns_candidate`
- unprotected "looks done" prose → never an oracle

Exit: planner does not spawn processes. `createdBeforePatch` is true for oracles
declared in the snapshot, false for post-change probes.

### A4 — Evidence admission

Create `ClaimEvidenceLinkV0` from:

- revision-bound verifier receipts
- IndependentVerifier receipts
- BDNS `EvidenceCandidateV1` (process mismatch, undeclared mutation, missing expected mutation)
- hidden-grade `hidden_ok` on eval paths

Admission rules:

- implementor explanations are never admissible as proof of a claim;
- BDNS `OBSERVER_DATA_LOSS` / `PERSISTENCE_DEGRADED` are admissible only as `unproven`, never as `supported`;
- truncated evidence cannot support a required claim.

Exit: tests cover contradiction vs unknown; no BDNS record gains `claimSatisfied`.

### A5 — Sufficiency engine

Pure function:

```text
for each required claim:
  supported if admissible evidence corroborates the claim
  contradicted if admissible evidence falsifies the claim
  unproven otherwise
  ambiguous if the claim itself is AMBIGUOUS

verdict:
  REJECT if any required claim is contradicted
  ACCEPT if every required claim is supported and none are ambiguous
  ESCALATE if any required claim is ambiguous
  INSUFFICIENT_EVIDENCE otherwise
```

Exit: table-driven tests. No I/O. No ChatEngine. Golden fixtures for the four
verdicts.

### A6 — Thin recording surface

Persist the contract, plan, links, and sufficiency result next to the run
(JSON, size-bounded, redacted). The read-only `babel inspect acceptance
<run-or-latest> [--json]` surface reuses the existing inspect resolver; no
dashboard or TUI chrome is required.

The recording bundle is prepared before the first model turn. After a run,
`finalizeAcceptanceRecording` may attach only already-admitted claim links and
recompute deterministic sufficiency; it cannot re-plan or mutate the frozen
snapshot, contract, or OraclePlan.

Do not add TUI chrome in V0.

Exit: a Chat/headless run with the feature flag writes the artifacts; a run
with the flag off is byte-identical to current completion behavior aside from
absence of the new directory.

### A7a — Detection / discrimination experiment

This cell evaluates detectors on the **same frozen candidate implementations**;
it does not compare a recording-only detector against a prevention treatment.
Reuse the existing arms × replicates / paired-delta infrastructure and pair by
`(task_id, replicate_id)`.

| Detector           | Meaning                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `babel_control`    | Current Babel evidence/completion checks                                                      |
| `frontier_posthoc` | Strong independent frontier review of task, baseline, and candidate patch                     |
| `acceptance_v0`    | Frozen patch-blind claims + frozen OraclePlan + admitted evidence + deterministic sufficiency |

Pre-register hidden oracles and the candidate set before reveal. Report raw
counts and paired deltas for false-accept detection, true-accept, false
rejection, insufficient evidence, escalation, coverage, tokens, latency, and
wall time. A post-hoc adversarial verification detector is optional and is not a prevention arm.

`acceptance/campaign.ts` is the pure cell-coordination boundary. It verifies
the frozen dataset and manifest, refuses design-only or excluded populations,
requires the complete factorial matrix, and requires one candidate-state hash
for all three detectors within each `(task_id, replicate_id)` pair before it
scores or evaluates promotion. It consumes rows from the existing canary
runner; the canary runner supplies a deterministic digest of the captured
production candidate state; it does not launch a second runner or provider.

### A7b — Prevention / gating experiment

Run only if A7a demonstrates meaningful discrimination lift. Compare:

| Arm                   | Meaning                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `babel_control`       | Current Babel                                                      |
| `prove_it_prompt`     | Same model plus an adversarial verification skill/prompt           |
| `acceptance_v0_gated` | Acceptance V0 gating on a high-assurance experimental profile only |

Measure consequential false completion, true completion, false rejection,
escalation, task success, unnecessary repair loops, tokens, and latency. V0
must not gate default Chat.

The checked-in `A7B_DETECTION_GATE_POLICY_V0` requires at least three trials
per arm, at least a 0.20 absolute false-accept reduction versus
`babel_control` and the independent `frontier_posthoc` detector, false rejects
no higher than 0.10, escalations no higher than 0.25, and complete coverage.
`buildEligiblePreventionManifest` refuses to construct a prevention cell until
this preregistered gate passes.

The checked-in preregistration is `benchmarks/acceptance-v0-dataset.json` and
the pure scoring core is in `acceptance/experiment.ts`. It covers governance
false-completion, user-visible false-completion, regression,
evidence-insufficiency, ambiguity, and BDNS-contradiction categories. The
ambiguity and BDNS entries are backed by the sealed special-fixture builder in
`acceptance/specialFixtures.ts`; they produce explicit escalation and
canonical/process-contradiction outcomes. The fixture runner remains
non-experimental, and no live model fan-out is implied by installing the
feature.

### A8 — Promotion decision, not a silent merge

A8 is a written go/no-go. It may:

- keep V0 as recording-only;
- enable `acceptance_v0_gated` on experimental profiles;
- or kill/shrink the architecture.

It may **not** silently make sufficiency the Chat completion authority.

## Experimental design (detail)

Hold fixed: model snapshot, temperature, task set, repo revision, permissions,
resource profile, environment digest.

Task set (first cell): the frozen
`benchmarks/acceptance-v0-dataset.json` references the live canary fixtures
`C07`, `C08`, `C09`, and `C10`–`C13` for the runnable governance, user-visible,
regression, and evidence-insufficiency cases. The four user-visible fixtures
are distinct hidden-oracle traps rather than repeated copies of one behavior.
It also references runnable sealed special fixtures for ambiguity and a
seeded-BDNS canonical/process contradiction. The older
`benchmarks/task-manifest.json` contains references to a missing fixture
generator and is not accepted as final-cell evidence until those paths are
repaired. Freeze the compact manifest before final cells and do not expand it
after looking at results.

Blindness:

- the implementor arm must not see hidden oracles or compiled claims;
- graders see only the resulting tree + declared oracles;
- analysis is paired at `(task_id, replicate_id)`.

This is the same discipline as Ox Alpha, applied first to evaluator
discrimination and only later to implementor prevention.

### Two-stage compiler falsification

Run the deterministic compiler first as H0. If it fails because the contract
quality is plainly inadequate, record that result. A separately frozen tuning
corpus may then inform an optional snapshot-only H1 LLM compiler; evaluate H1
on a fresh confirmatory set. Repeated tuning until a win is not an allowed
experimental procedure.

## Pre-registered falsifiers

The architecture is wrong if any of the following hold after A7:

1. `acceptance_v0` does not beat `prove_it_prompt` on consequential false completions.
2. Default runs leak compiled claims into implementor messages.
3. The compiler emits required claims from placeholder TaskContract criteria.
4. Sufficiency ever writes a `TerminalOutcome`.
5. BDNS incidents appear with `claimSatisfied` / `requirementMet`.
6. A green existing test is treated as proof of an unrelated user-visible claim.
7. `AMBIGUOUS` claims are compiled into required oracles.
8. V0 import graph from `acceptance/` into BDNS, or the reverse except
   `EvidenceCandidateV1` **read**.

## Risks and adversarial modes

| Failure               | Why it happens                                        | Defense                                                                 |
| --------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| Circular proof        | Compiler sees the patch or the implementor            | Snapshot origin `pre_implementation`; no patch files in compiler inputs |
| Contract gaming       | Implementor reads the claims                          | Hidden by default                                                       |
| Proxy evidence        | `npm test` stands in for the user-visible path        | Claim-level linking; green tests support only claims they are bound to  |
| LLM-as-judge          | Sufficiency becomes another prompt                    | Deterministic engine in V0                                              |
| EvidenceGraph capture | New claims get stuffed into the old node-type checker | New module; old `AcceptanceContract` untouched                          |
| Dashboard creep       | A6 becomes a debugger UI                              | Inspect JSON only                                                       |
| Deep-mode rewrite     | Campaign expands into V9                              | Chat/headless experimental path only                                    |
| Completeness theater  | Huge claim lists, no discriminative power             | Prefer few required claims with real falsifiers                         |
| BDNS takeover         | Incidents treated as acceptance                       | Invariants 11/12; admission maps incidents to evidence, not verdicts    |

## Migration

V0 is additive.

```text
flag off  → current Chat/Deep/Plan unchanged
flag on   → snapshot + compile + record sufficiency; kernel unchanged
gated arm → experimental profiles only, after A7
```

No change to `TerminalOutcome`. No change to TaskContract hash rules except
optional later replacement of placeholder `acceptance_criteria` **after**
promotion, in a different campaign.

Existing `evidence/acceptanceContracts.ts` keeps its name until a dedicated
rename PR, which is out of V0.

## PR plan

Each PR is independently reviewable. Do not stack A7 on an unmerged A5.

| PR  | Title                                                                  | Depends on | Files                                               | What it ships |
| --- | ---------------------------------------------------------------------- | ---------- | --------------------------------------------------- | ------------- |
| P0  | docs: freeze Executable Acceptance V0 campaign                         | —          | this file, indexes                                  | Contract only |
| P1  | feat(acceptance): V0 types, hash, freeze                               | P0         | `babel-cli/src/acceptance/*`                        | A1            |
| P2  | feat(acceptance): patch-blind compiler                                 | P1         | `acceptance/compiler.ts` + tests                    | A2            |
| P3  | feat(acceptance): oracle planner                                       | P2         | `acceptance/oraclePlanner.ts` + tests               | A3            |
| P4  | feat(acceptance): evidence admission from receipts and BDNS candidates | P3         | `acceptance/evidenceAdmission.ts` + tests           | A4            |
| P5  | feat(acceptance): deterministic sufficiency engine                     | P4         | `acceptance/sufficiency.ts` + golden tables         | A5            |
| P6  | feat(acceptance): opt-in run artifacts                                 | P5         | thin inspect/record glue, **not** chatEngine growth | A6            |
| P7  | feat(eval): blinded acceptance arms vs adversarial verification         | P6         | experimental program wiring, preregistered cells    | A7            |
| P8  | docs: A8 promotion / kill record                                       | P7         | campaign addendum                                   | A8            |

P6 must not add more than a small attach helper. If ChatEngine would grow,
extract first. The file is already over its ratchet budget.

## Phase-1 implementation prompt

Use this for P1 only. Do not implement P2–P8 in the same change.

```text
Implement Executable Acceptance V0 slice A1 only.

Read docs/architecture/EXECUTABLE_ACCEPTANCE_V0.md and
docs/architecture/HARNESS_ARCHITECTURE_V1.md first.

Add babel-cli/src/acceptance/ with types, hashing, freeze, and tests from
the campaign document. Do not import ChatEngine, BDNS runtime, or kernel
completion. Do not rename evidence/acceptanceContracts.ts. Do not add
claimSatisfied to any BDNS type.

Exit: npx tsc --noEmit and the new co-located tests pass.
```

## What I would not do

The transcript's full Acceptance V2 (compiler + oracle planner + claim graph +
sufficiency + kernel promotion + UX) is the right **destination**, not the
right **first merge**. Shipping it as one architecture would repeat the
failure mode the moat research warned about: building a heavier verification
prompt and calling it independence.

Adversarial verification already covers "ask better adversarial questions." Babel should
only keep this campaign if A7 shows lift on hidden, consequential false
completions. Until then, treat V0 as an experiment with a kill switch, sitting
beside the kernel rather than inside it.

## Open questions (deliberately few)

These are the only questions I would not pre-decide:

1. **First compiler: heuristics only, or heuristics plus optional LLM behind a flag?** Recommendation: heuristics plus optional LLM flag, default off.
2. **First gated profile, if A7 passes:** `babel_research` / high-assurance only, never default Chat.
3. **Whether placeholder TaskContract `acceptance_criteria` should be rewritten after promotion.** Recommendation: no, not in this campaign.

Everything else in this document is a decision, not a prompt for another
strategy conversation.
