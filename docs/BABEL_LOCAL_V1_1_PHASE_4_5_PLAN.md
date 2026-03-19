# Babel Local v1.1 Phase 4-5 Plan

## Purpose

Define the next implementation plan for the Babel Local v1.1 learning loop after Phase 3.

This plan is specifically for:
- Phase 4: `global` promotion
- Phase 5: staged prompt evolution

It is not the same phase numbering used in:
- `docs/BABEL_LOCAL_TOOLING_IMPROVEMENT_PLAN.md`
- `docs/CODEX_HANDOFF_BABEL_LOCAL_IMPROVEMENT.md`

Those docs already use "Phase 4" and "Phase 5" for eval fixtures and comparison workflow.
This document only covers the Local v1.1 evidence-gated adaptation phases defined in:
- `docs/BABEL_LOCAL_EVIDENCE_GATED_ADAPTATION_V1_1.md`

## Current State

### Verified current repo state

- Local v1.1 Phase 1 normalized evidence is implemented.
- Local v1.1 Phase 2 policy candidate generation is implemented.
- Local v1.1 Phase 3 scoped auto-activation is implemented for `local_client` and `repo`.
- `tools/generate-local-policy-candidates.ps1` currently emits `local_client` and `repo` candidate surfaces, not new `global` promotion candidates.
- `tools/activate-local-policies.ps1` still rejects new non-Phase-3 scopes with `scope_not_supported_for_phase3`, while retaining the ability to read or carry forward an existing `active/global-policy.json`.
- `tools/resolve-local-stack.ps1` currently loads active `repo` and `local_client` policies, but does not load active `global` policies into runtime resolution.
- `babel-cli/scripts/evolve_prompts.ts` already stages prompt-evolution proposals to `04_Meta_Tools/proposed_evolutions.json`, but it is driven by historical run QA rejects under `runs/` and is not yet connected to the Local v1.1 normalized-events/policy pipeline.

### Meaning

Babel already has the local learning loop foundation:
- evidence
- candidate generation
- scoped activation
- rollback and expiry

The next gap is not "more prompt complexity."
The next gap is safe promotion and safe human-review staging.

## Planning Principles

This plan follows the current Babel strategy:

- Keep the compounding core:
  - authority separation
  - behavioral gating
  - eval/regression discipline
  - evidence normalization
  - scoped policy activation
  - auditability
- Do not expand orchestration complexity unless it directly supports governance or reproducibility.
- Do not auto-edit prompt markdown files.
- Keep global behavior conservative and fail-closed.
- Make each slice measurable against a simpler baseline where possible.
- Prefer fixture-backed tests over `runs/` artifacts for regression coverage.

## Phase 4: Global Promotion

## Objective

Promote only proven, scoped operational policies into `global` status when the evidence shows a repeatable cross-repo pattern and no stronger repo policy conflicts with the promotion.

Output target:
- `runs/local-learning/active/global-policy.json`

## Phase 4 entry criteria

Do not start implementation until all of the following remain true:

- Phase 1-3 tests stay green.
- Global promotion rules stay aligned with `docs/BABEL_LOCAL_EVIDENCE_GATED_ADAPTATION_V1_1.md`.
- Repo-local precedence remains stronger than global precedence.
- Prompt markdown changes remain outside auto-apply.

## Phase 4 design requirements

### Promotion source of truth

Global promotion should not be derived from one repo's raw events directly.

It should be derived from:
- normalized events
- comparison results
- already-successful `repo` or `local_client` active policies

Reason:
- globalization must prove "this local win generalizes"
- not merely "this pattern was seen in three unrelated events"

### Promotion gate

The existing spec remains authoritative:
- already successful as `repo` or `local_client`
- evidence across at least 3 repos
- no stronger repo policy conflict
- no cross-repo comparison or eval regression

Implementation should add one more operational rule:
- the global candidate must be expressible as bounded policy data already supported by runtime consumers

This avoids promoting a policy that cannot be applied deterministically.

### Precedence and conflict rules

Runtime precedence must stay:
1. constitutional static authority
2. repo-local collaboration system and explicit repo invariants
3. static Babel prompt stack
4. active repo policy
5. active local-client policy
6. active global policy

Operational interpretation:
- repo policy wins over global for the same target surface
- local-client policy may tune ergonomics, but must not override repo constraints
- global policy is a default fallback layer only

### Rollback and expiry

Global promotion must preserve scope isolation:
- global rollback must not delete repo-local evidence
- repo rollback must not imply global rollback
- global expiry must use the existing longer horizon defaults

### Auditability

Every global promotion decision must write a machine-readable audit line with:
- policy ID
- source scoped policy IDs
- supporting repo list
- supporting event IDs
- rejection or activation reasons
- conflict detection result
- regression check result

## Phase 4 implementation slices

### Slice 4A: Global candidate derivation

Add a dedicated derivation path that can emit `global` candidate records only when:
- the same policy pattern is already successful in at least 3 repos
- the target surface is allowlisted
- the proposed change is reversible and already supported by runtime

Expected outputs:
- `policy-candidates.json` may now include `scope_type = "global"`
- `policy-audit.jsonl` records why a global candidate was admitted or rejected

Verification:
- fixture with 3 repos and matching success pattern produces a global candidate
- fixture with only 2 repos does not
- fixture with contradictory repo evidence yields `human_review` or rejection

### Slice 4B: Global activation gate

Extend `tools/activate-local-policies.ps1` so new `global` candidates are no longer rejected by the Phase 3 guard when they satisfy the Phase 4 gate.

Requirements:
- preserve existing Phase 3 rejection behavior for unsupported scopes outside the new global path
- require explicit cross-repo verification
- support rollback and expiry for active global policies

Verification:
- activating a qualified global candidate writes `active/global-policy.json`
- a non-qualified global candidate is skipped with an explicit audit reason
- rollback and expiry remain scope-isolated

### Slice 4C: Runtime consumption

Extend runtime consumers to load and apply active global policy only after repo and local-client layers.

Primary runtime target:
- `tools/resolve-local-stack.ps1`

Follow-on consumers:
- `tools/start-local-session.ps1`
- `tools/log-local-session.ps1`
- `tools/end-local-session.ps1`
- `tools/launch-babel-local.ps1`

Requirements:
- `PolicyVersionApplied` must include global policy signatures when applied
- repo and local-client signatures must remain ahead of global signatures
- no existing repo behavior may silently change when a stronger repo policy exists

Verification:
- resolver applies global policy for eligible repos without stronger overrides
- resolver ignores global policy when repo policy conflicts
- session and launch flows log the applied global signature deterministically

### Slice 4D: Comparative validation

Before calling Phase 4 complete, run one comparison-oriented validation pass:
- Babel with no global policy
- Babel with candidate global policy
- a thin baseline when practical

Measure:
- success rate
- follow-up-needed rate
- stack override rate
- comparison wins
- absence of new hard fails

Exit rule:
- no Phase 4 completion call without objective lift or at least non-regression in the target surfaces

## Phase 5: Staged Prompt Evolution

## Objective

Translate repeated, high-confidence learning signals that cannot be expressed safely as structured runtime policy into human-review prompt evolution proposals.

Output target:
- `04_Meta_Tools/proposed_evolutions.json`

No automatic prompt-file edits in v1.1.

## Phase 5 design requirements

### Trigger conditions

Phase 5 should only stage proposals when at least one of the following is true:
- repeated `human_review` candidate patterns imply a prompt-layer gap
- repeated repo/global conflicts point to missing constitutional guidance
- repeated non-allowlisted surfaces suggest a missing prompt-level rule
- repeated stable operational evidence cannot be represented as bounded policy data

If a problem can be solved safely as runtime policy data, keep it out of Phase 5.

### Target boundaries

Prompt evolution proposals may reference:
- `03_Model_Adapters/*.md`
- `05_Project_Overlays/*.md`
- `06_Task_Overlays/*.md`
- other human-reviewed prompt assets where allowed by current repo policy

Prompt evolution proposals must never auto-edit:
- `BABEL_BIBLE.md`
- `PROJECT_CONTEXT.md`
- `prompt_catalog.yaml`
- `00_System_Router/*`
- `01_Behavioral_OS/*`

### Proposal contract

Each staged proposal should include:
- generated_at_utc
- proposal_id
- source_type
- source_policy_ids
- source_event_ids
- source_repo_scope
- target_file
- target_layer
- observed_problem
- why structured runtime policy was insufficient
- suggested prompt change summary
- human review checklist
- validation steps after review

## Phase 5 implementation slices

### Slice 5A: Local-learning proposal feeder

Add a feeder step that turns learning-loop evidence into prompt-evolution proposal inputs.

Inputs:
- normalized events
- policy candidates
- policy audit records
- active policy outcomes

Outputs:
- structured proposal records consumable by the existing staged proposal path

This should complement `babel-cli/scripts/evolve_prompts.ts`, not replace it.

### Slice 5B: Proposal staging integration

Either:
- extend `babel-cli/scripts/evolve_prompts.ts`

or:
- add a narrow wrapper that merges Local-learning proposal inputs with the existing staged evolution report

Preference:
- preserve the current human-review-only workflow
- do not broaden write scope beyond `04_Meta_Tools/proposed_evolutions.json`

Contract note for `04_Meta_Tools/proposed_evolutions.json`:

- `babel-cli/scripts/evolve_prompts.ts` is the base historical-QA producer and writes only these top-level keys:
  - `generated_at`
  - `runs_dir`
  - `runs_scanned`
  - `reject_verdicts_found`
  - `architects_affected`
  - `proposals`
- `tools/stage-local-learning-prompt-evolutions.ps1` is a merge step that preserves all base keys and appends:
  - `local_learning_generated_at_utc`
  - `local_learning_proposals`

Validation gate for this artifact:

- Base validation checks only the base keys written by `evolve_prompts.ts`.
- Post-merge validation checks the same base keys plus `local_learning_generated_at_utc` and `local_learning_proposals`.
- A validation check must treat these as two valid states of the same artifact path. The `local_learning_*` fields are required only after the local-learning staging step has run.

### Slice 5C: Review workflow and regression tests

Add fixtures for:
- repeated human-review signals that should stage a proposal
- repeated runtime-policy-insufficient signals that should stage a proposal
- noisy or contradictory evidence that should not stage a proposal

Verification:
- proposal staging remains deterministic
- proposal output stays reviewable
- no prompt files are edited automatically

## 90-Day Execution Order

### Days 1-30

- Implement Slice 4A global candidate derivation in fixtures first.
- Write explicit precedence and conflict fixtures before runtime changes.
- Add one design note explaining how global promotion uses active scoped policies, not raw single-repo events.

### Days 31-60

- Implement Slice 4B activation gate and Slice 4C runtime consumption.
- Run regression coverage for:
  - global activation
  - repo-over-global precedence
  - global rollback
  - global expiry
- Re-check launch and session logging for deterministic `PolicyVersionApplied`.

### Days 61-90

- Implement Slice 5A and Slice 5B for staged prompt evolution.
- Add Phase 5 fixtures and deterministic tests.
- Run one bounded comparative validation pass for the learning loop with and without global policy.
- Stop and review before any broader prompt-layer expansion.

## Completion criteria

Phase 4 is complete only when:
- qualified global candidates can be derived
- qualified global candidates can activate
- runtime consumers apply active global policy with correct precedence
- rollback and expiry remain scope-isolated
- regression coverage proves non-conflicting behavior

Phase 5 is complete only when:
- repeated learning-loop signals can stage prompt evolution proposals
- proposal staging is deterministic and human-review-only
- no prompt markdown files are auto-edited
- proposal records include enough evidence for a human reviewer to approve or reject them quickly

## What to do next

Start with Phase 4 Slice 4A.

Reason:
- it is the narrowest missing part of the learning loop
- it clarifies the data model before runtime changes
- it reduces the risk of implementing the wrong globalization behavior
- it keeps Babel aligned with the memo's recommendation to validate the governance/evidence wedge before broadening scope
