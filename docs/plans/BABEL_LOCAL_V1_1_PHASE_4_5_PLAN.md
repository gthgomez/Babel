<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE

You are explicitly encouraged to use, modify, fork, and build commercial products on top of this prompt layer.
-->


<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# Babel Local Learning Validation Roadmap

## Purpose

Define the next operational roadmap for Babel Local v1.1 using the system that already exists.

This document is intentionally narrower than a fresh architecture spec:
- it does not found a new policy subsystem
- it does not re-argue the full Local v1.1 design
- it does not authorize stronger enforcement by enthusiasm alone

It turns the current reality into an execution plan:
- clean the evidence stream
- validate repo-scoped policy treatment
- replicate success across repos
- only then consider bounded global fallback promotion

Primary companion specs:
- `docs/architecture/BABEL_LOCAL_EVIDENCE_GATED_ADAPTATION_V1_1.md`
- `PROJECT_CONTEXT.md`
- `docs/architecture/BABEL_RUN_REMEDIATION_CHECKLIST.md`

## What Exists Today

### Implemented system capabilities

The following Local v1.1 capabilities are already implemented in the repo:
- evidence normalization
- policy candidate generation
- scoped policy activation
- rollback and expiry
- global policy activation path
- resolver/runtime consumption of active global policy as a fallback layer
- human-review-only prompt-evolution staging

This means Babel is not at the "invent the policy engine" stage.
It is at the "improve signal quality, validate treatment value, and tighten promotion gates" stage.

### Current maturity snapshot

As of the latest live Local Mode evidence:
- `repo:gpcguard:verification_loop_hints:strict` is active in `runs/local-learning/active/repos/GPCGuard.json`
- that GPCGuard policy is still early-treatment and should be treated as promising, not globally proven
- Prismatix and AuditGuard still sit at repo-candidate stage for the same surface
- no local-learning-driven prompt evolution proposals have yet proven necessary for this surface

### Non-goals for the next pass

Do not do any of the following as part of this roadmap:
- invent a parallel governance lifecycle document that disagrees with the existing design docs
- promote a repo pattern to global on baseline intuition alone
- escalate checklist guidance into hard blocking behavior without fresh evidence
- position Babel publicly as a mature governance-learning system before cross-repo proof exists

## Planning Principles

- Evidence before escalation.
- Consolidate existing truth instead of creating parallel planning artifacts.
- Treat repo-scoped policy success as a prerequisite for global fallback.
- Keep stronger enforcement experiments separate from baseline checklist validation.
- Prefer deterministic reporting and fixture-backed validation over narrative confidence.

## Current Operational State

Use this document as the short answer to "what exists now and what happens next?"

### Runtime and governance state

- `tools/normalize-local-evidence.ps1` is the canonical evidence normalizer.
- `tools/generate-local-policy-candidates.ps1` emits repo, local-client, and global-capable candidate records.
- `tools/activate-local-policies.ps1` activates qualified scoped policies and preserves rollback/expiry.
- `tools/resolve-local-stack.ps1` applies repo and local-client policies first, with global policy as a fallback layer only.
- `tools/stage-local-learning-prompt-evolutions.ps1` stages review-only prompt evolution proposals into `04_Meta_Tools/proposed_evolutions.json`.

### Known gaps

- historical protocol-noise can still dominate operator attention if `protocol-violations.jsonl` is read raw
- repo-scoped treatment evidence is thinner than the system capability surface suggests
- promotion readiness thresholds are implicit across several docs instead of stated operationally in one place

## Validation-First Phases

## Phase 1: Signal Hygiene

### Objective

Separate stale reconciliation noise from live governance evidence so promotion decisions are based on current, actionable signal.

### Work

- segment the historical March 9 reconciliation backlog from the default working view
- keep recent unresolved lifecycle failures visible
- make the default operator path "recent actionable evidence first"
- preserve append-only history for auditability

### Required evidence

- `runs/local-learning/protocol-violations.jsonl`
- `tools/report-run-consistency.ps1`
- `tools/reconcile-pending-sessions.ps1`

### Exit criteria

- historical `partial_bundle_timeout` backlog no longer dominates the default summary view
- operators can distinguish current failures from historical debt without manual log spelunking
- no loss of append-only audit history

## Phase 2: Canonicalize the Existing Lifecycle

### Objective

Make the current local-learning lifecycle operationally clear without creating a duplicate subsystem description.

### Work

- keep `docs/architecture/BABEL_LOCAL_EVIDENCE_GATED_ADAPTATION_V1_1.md` as the design spec
- keep `PROJECT_CONTEXT.md` as the high-authority state summary
- use this roadmap as the operational execution plan
- explicitly document:
  - candidate generation
  - activation scopes
  - precedence
  - rollback and expiry
  - prompt-evolution staging boundary

### Exit criteria

- a reader can answer "what exists now, what is proven, and what happens next?" from the existing canonical docs
- no parallel lifecycle doc is needed to understand the system

## Phase 3: GPCGuard Treatment Validation

### Objective

Let the active GPCGuard `verification_loop_hints:strict` policy earn broader trust through treatment evidence, not baseline support alone.

### Current state

The GPCGuard policy is active, but the active record still shows immature treatment evidence and should not justify global promotion by itself.

### Metrics to track

- applicable treatment runs
- treatment runs across distinct UTC days
- QA reject rate delta versus baseline
- reduction in missing-root-cause / missing-evidence failures
- follow-up-needed rate delta
- latency or operator-friction increase
- rollback-trigger incidence

### Promotion-readiness gate

Do not consider this repo-scoped policy "treatment-proven" until all of the following hold:
- at least 10 applicable treatment runs
- at least 3 distinct UTC days of treatment evidence
- no rollback trigger hit
- QA reject rate is non-worse than baseline
- missing-root-cause / missing-evidence failures show a clear downward trend

### Exit criteria

- the GPCGuard policy is treatment-proven at repo scope
- treatment evidence is strong enough to compare meaningfully with other repos

## Phase 4: Cross-Repo Replication

### Objective

Replicate the same bounded policy pattern in Prismatix and AuditGuard before any global fallback decision.

### Work

- bring Prismatix from candidate to active only if its evidence qualifies
- bring AuditGuard from candidate to active only if its evidence qualifies
- keep the evaluation rubric the same across repos
- treat contradiction as a stop signal, not something to smooth over narratively

### Comparative requirements

For each participating repo, capture:
- target surface
- checklist shape
- affected task categories
- treatment evidence counts
- reject/follow-up deltas
- any repo-specific conflict or override

### Exit criteria

- at least 3 repos show the same bounded policy pattern with non-trivial treatment evidence
- no stronger repo-local conflict invalidates the shared pattern

## Phase 5: Bounded Global Fallback Consideration

### Objective

Consider global promotion only when the shared pattern is cross-repo proven and still expressible as bounded runtime policy data.

### Requirements

The global candidate must remain:
- reversible
- bounded
- already supported by existing runtime consumers
- weaker than repo-local authority

### Required gates

- the same recurring policy is treatment-proven in at least 3 repos
- comparative validation shows non-regression
- no stronger repo policy conflicts with fallback application
- the policy remains a hint/checklist-style operational rule

### Explicit anti-goal

Do not convert this phase into stronger enforcement by sneaking in new rules such as:
- `block_action_without_evidence`
- execution-halting behavior beyond the currently learned bounded policy

Those belong to a separate experiment phase.

### Exit criteria

- a qualified global candidate exists
- activation is justified by cross-repo evidence
- global behavior remains fallback-only and precedence-safe

## Phase 6: Stricter Enforcement Experiments

### Objective

Test whether a stronger variant is worthwhile, but only after the lighter policy has proven value.

### Rules

- treat any stricter variant as a new policy experiment, not a natural upgrade
- require separate fixtures, separate treatment evidence, and separate rollback criteria
- measure execution delay, false-positive friction, and reject-rate impact explicitly

### Exit criteria

- either the stricter variant validates value with acceptable cost
- or Babel keeps the lighter checklist-style policy as the stable default

## Phase 7: Public Positioning

### Objective

Only describe this capability publicly once the system is proven enough to support the claim.

### Preconditions

- repo-scoped treatment evidence is mature
- at least one global fallback pattern is active and useful
- prompt-evolution staging has demonstrated value where appropriate
- private/public export and scrub discipline remains intact

### Exit criteria

- public positioning is claim-safe and does not outrun implementation reality

## Operational Commands

### Signal hygiene and lifecycle audit

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\report-run-consistency.ps1
powershell -ExecutionPolicy Bypass -File .\tools\reconcile-pending-sessions.ps1
```

### Local-learning evidence and policy state

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\normalize-local-evidence.ps1
powershell -ExecutionPolicy Bypass -File .\tools\generate-local-policy-candidates.ps1
powershell -ExecutionPolicy Bypass -File .\tools\activate-local-policies.ps1
```

### Comparative validation and proposal staging

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\validate-global-policy-comparison.ps1
powershell -ExecutionPolicy Bypass -File .\tools\stage-local-learning-prompt-evolutions.ps1
```

## Immediate Next Actions

1. Clean the operator view of `protocol-violations.jsonl` so fresh issues surface first.
2. Keep the GPCGuard policy active and accumulate treatment evidence until the repo-scoped gate is truly met.
3. Re-run Prismatix and AuditGuard through the same verification-loop-hints measurement rubric.
4. Revisit global fallback only after 3 repos have treatment-proven evidence for the same bounded pattern.
5. Keep stronger enforcement variants and public positioning out of scope until the above is true.

## Source Notes

- `PROJECT_CONTEXT.md` remains the authoritative high-level state summary.
- `docs/architecture/BABEL_LOCAL_EVIDENCE_GATED_ADAPTATION_V1_1.md` remains the design specification.
- This roadmap exists to keep the next operational decisions aligned with the implemented system, not to supersede the constitutional design docs.
