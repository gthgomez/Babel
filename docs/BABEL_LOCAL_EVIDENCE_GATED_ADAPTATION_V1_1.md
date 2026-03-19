# Babel Local Evidence-Gated Adaptation

## Design Specification v1.1

## Purpose

Define a Babel-native path for Local Mode to improve from repeated subscription-first use without inventing a parallel learning subsystem and without allowing silent prompt drift.

This specification extends existing Babel Local artifacts and tooling:
- `runs/` evidence bundles
- `runs/local-learning/session-log.jsonl`
- `runs/local-learning/session-starts/`
- `runs/local-learning/session-ends/`
- `babel-cli/chronicle.sqlite`
- `tools/log-local-session.ps1`
- `tools/analyze-local-sessions.ps1`
- `tools/resolve-local-stack.ps1`
- `tools/launch-babel-local.ps1`
- `tools/score-comparison-results.ps1`
- `babel-cli/scripts/evolve_prompts.ts`

The focus is Local Mode, where Babel is used through subscription surfaces such as Codex extension, Claude Code, Gemini CLI, VS Code chat, and similar editor or web clients.

## Non-Goals

This design does not:
- create a new control plane
- create a separate orchestration subsystem beside Babel Local
- auto-edit constitutional files
- auto-edit prompt markdown files
- bypass repo-local collaboration systems
- treat one noisy run as sufficient evidence

## Constitutional Compatibility

This specification is designed to stay compatible with the layer model and authority order in:
- `BABEL_BIBLE.md`
- `PROJECT_CONTEXT.md`
- `prompt_catalog.yaml`
- `LLM_COLLABORATION_SYSTEM/ACTIVATION_CONTRACT.yaml`

It preserves the existing Babel pattern:
- Babel selects the valid layer stack
- repo-local collaboration systems define repo-local execution truth
- learned policy only adjusts bounded operational behavior inside Local Mode

Learned policy must never:
- invent uncataloged prompt files
- change layer boundaries
- override repo invariants
- weaken Behavioral OS rules

## Design Principles

### 1. Minimal Blast Radius

Use existing Local Mode data sources and existing gitignored runtime paths.

New logic should prefer:
- extending current scripts
- writing derived JSON or JSONL artifacts under `runs/local-learning/`
- storing durable facts in Chronicle

### 2. Policy Data Over Prompt Self-Editing

Babel should first learn through generated policy data, not through self-editing prompt files.

Day-one autonomy should target:
- resolver ranking
- kickoff prompt presets
- overlay recommendation order
- retry heuristics
- verification loop hints
- client-surface defaults

Prompt markdown changes remain staged proposals for human review.

### 3. Evidence Over Intuition

Auto-improvement requires:
- repeated observations
- clean provenance
- measurable effect after activation
- rollback when effect is negative

### 4. Layered Scope

Learning must stay scoped so repo-local wins do not become unsafe global defaults.

Three learned policy scopes are allowed:
- `local_client`
- `repo`
- `global`

### 5. Fail-Closed Promotion

When evidence is conflicting, incomplete, or hard to classify:
- keep the candidate in `shadow`
- or send it to `human_review`

## Authority Layers

The effective Local Mode authority order is:

1. Constitutional static authority
2. Repo-local collaboration system and explicit repo invariants
3. Static Babel operational prompts selected from `prompt_catalog.yaml`
4. Repo learned policy
5. Local client learned policy
6. Global learned policy

Interpretation:
- repo-local rules always win for repo-local behavior
- global learned policy is a default, not a mandate
- local client policy may tune ergonomics but must not conflict with repo policy

## Existing Evidence Sources

### A. Evidence Bundles Under `runs/`

Use existing bundle artifacts as historical execution evidence, including:
- `01_manifest.json`
- `03_qa_verdict_vN.json`
- execution report artifacts when present
- other run-level structured JSON already emitted by Babel

Primary value:
- manifest composition
- QA pass or reject signals
- failure tags and fix hints
- pipeline stage behavior

### B. Local Learning Lifecycle Artifacts

Use Local Mode artifacts under `runs/local-learning/`, including:
- `session-log.jsonl`
- `session-starts/<UTC-date>/`
- `session-ends/<UTC-date>/`

Primary value:
- subscription client surface behavior
- stack overrides
- follow-up-needed rate
- selected stack IDs
- repo-local context detection
- kickoff prompt behavior
- user-visible success or failure outcomes

### C. Comparison Workflow

Use the existing pairwise comparison workflow as positive evidence and tie-break evidence, not just failure evidence.

Primary value:
- candidate-vs-candidate quality comparison
- explicit weighted rubric outcomes
- winner signals by model, adapter, client surface, and stack

### D. Chronicle

Use Chronicle for durable, likely-stable operational facts, not as a raw session archive.

Examples:
- preferred adapter for a repo
- stable repo startup sequence
- known client-surface limitation
- persistent repo-local tool visibility pattern

## Canonical Derived Artifacts

This design does not create a separate subsystem root. It adds derived artifacts under the existing Local Mode runtime tree.

Recommended derived paths:

- `runs/local-learning/derived/normalized-events.jsonl`
- `runs/local-learning/derived/policy-candidates.json`
- `runs/local-learning/derived/policy-audit.jsonl`
- `runs/local-learning/active/global-policy.json`
- `runs/local-learning/active/repos/<Repo>.json`
- `runs/local-learning/active/local-clients/<ClientSurface>.<Model>.json`

Recommended staged human-review artifact:

- `04_Meta_Tools/proposed_evolutions.json`

These files remain runtime or staged outputs, not constitutional sources of truth.

## Normalized Event Contract

All learning logic should operate on one normalized event stream built from both evidence bundles and Local Mode session logs.

Each normalized event should include:

- `schema_version`
- `event_id`
- `observed_at_utc`
- `source_type`
  Values:
  - `evidence_bundle`
  - `local_session`
  - `comparison_result`
- `source_path`
- `run_id`
- `session_id`
- `project`
- `project_path`
- `task_category`
- `client_surface`
- `model`
- `pipeline_mode`
- `selected_stack_ids`
- `recommended_stack_ids`
- `recommended_task_overlay_ids`
- `repo_local_system_present`
- `qa_verdict`
  Values:
  - `pass`
  - `reject`
  - `unknown`
- `result`
  Values:
  - `success`
  - `partial`
  - `failed`
  - `abandoned`
  - `unknown`
- `failure_tags`
- `files_touched`
- `follow_up_needed`
- `policy_version_applied`
- `hard_fail_signals`
- `positive_signals`
- `authoritative_success_label`
  Values:
  - `success`
  - `failed`
  - `unconfirmed`

## Composite Success Label

Local Mode should use a combined success label to reduce hallucinated self-assessment.

### Hard Fail Signals

Any of the following should force `authoritative_success_label = failed`:
- QA reject
- deterministic eval fixture failure
- explicit regression detection
- explicit user rejection
- rollback-triggering active policy failure

### Positive Signals

Positive signals may include:
- `Result = success`
- QA pass
- no follow-up needed
- pairwise comparison win
- successful treatment run after policy activation

### Final Label Rule

Use this fail-closed decision rule:

1. If any hard fail signal exists, label `failed`.
2. Else if objective checks pass and user-visible outcome is positive, label `success`.
3. Else label `unconfirmed`.

`unconfirmed` is not promotable evidence for auto-activation by itself.

## Learned Policy Surfaces

### Day-One Auto-Apply Surfaces

The following may auto-apply without human approval:
- resolver ranking weights in `tools/resolve-local-stack.ps1`
- kickoff prompt presets used by Local Mode launchers
- task-overlay recommendation ordering
- client-surface startup phrasing
- bounded retry heuristics for Local Mode workflows
- verification reminder heuristics
- tool-profile preferences and repo startup hints

### Human-Review-Only Surfaces

The following remain human-reviewed:
- `BABEL_BIBLE.md`
- `PROJECT_CONTEXT.md`
- `prompt_catalog.yaml`
- `00_System_Router/*`
- `01_Behavioral_OS/*`
- `03_Model_Adapters/*.md`
- `05_Project_Overlays/*.md`
- `06_Task_Overlays/*.md`

Any learned signal that points to one of those files should be routed to proposal staging, not auto-apply.

## Policy State Machine

Each learned policy candidate must move through these states:

1. `observe`
2. `candidate`
3. `shadow`
4. `active`
5. `stable`
6. `rollback`
7. `expired`
8. `human_review`

### Observe

Raw normalized evidence exists, but no reliable pattern exists yet.

### Candidate

A bounded operational policy change is proposed with clean provenance and a compatible target surface.

### Shadow

The policy is evaluated without being applied.

In shadow mode, Babel records:
- what policy would have been selected
- which scope would have applied
- whether the candidate would have changed stack ranking, kickoff phrasing, or heuristics
- whether recent evidence suggests likely improvement

### Active

The policy is applied only on its allowed scope.

### Stable

The policy remains active after passing the minimum post-activation verification window.

### Rollback

The policy is disabled because it caused or correlated with measurable regression.

### Expired

The policy aged out due to lack of reconfirmation.

### Human Review

The candidate is too risky, too ambiguous, or points toward prompt-file changes.

## Scope Rules

### Local Client Scope

Use for operational behavior tied to a specific subscription surface.

Examples:
- Codex extension kickoff phrasing
- Claude Code prompt length
- Gemini CLI verification reminder wording

Local client scope may not override repo-local invariants.

### Repo Scope

Use when the evidence is specific to one repo or one repo-family workflow.

Examples:
- repo startup file order
- repo-preferred adapter
- recurring repo-local overlay recommendation

Repo scope should be the default for improvements observed in only one repo.

### Global Scope

Use only when evidence appears across multiple repos and does not conflict with stronger repo-scoped policy.

Global scope is a fallback layer, not a replacement for repo-local learning.

## Promotion Rules

### Candidate Admission

A policy may move from `observe` to `candidate` only if all are true:
- target surface is in the day-one auto-apply allowlist
- evidence has clean provenance
- evidence is scoped cleanly
- the proposed change is reversible
- the change can be expressed as structured policy data, not prompt markdown edits

### Shadow Admission

A policy may move from `candidate` to `shadow` only if all are true:
- at least 3 applicable normalized events support the same pattern
- the events occur across at least 2 distinct UTC days
- no hard fail contradicts the proposed direction

### Active Admission For `local_client` And `repo`

A policy may auto-activate only if all are true:
- it passed shadow mode
- at least 8 applicable events exist in the same scope bucket
- at least 2 treatment runs have been observed after activation preparation
- the candidate shows at least one measurable improvement:
  - success rate up
  - follow-up-needed rate down
  - stack override rate down
  - comparison wins up
- no monitored metric regresses by more than 5 percent relative to baseline
- no hard fail appears in the activation gate window

### Global Admission

A policy may move to `global` active status only if all are true:
- it is already successful as repo-local or local-client policy
- evidence exists across at least 3 repos
- no stronger repo policy conflicts with it
- comparison or eval evidence does not show cross-repo regression

Global promotion should be conservative.
Single-repo wins stay repo-local by default.

## Verification Model

Auto-improvement must verify both direction and outcome.

### Baseline vs Treatment

For each candidate, capture:
- baseline metrics before activation
- treatment metrics after activation
- scope bucket used for comparison
- exact policy version applied

### Paired Review Requirement

Where feasible, verify one run with the candidate policy and one without it.

Use this especially for:
- kickoff prompt variants
- overlay recommendation ordering
- retry heuristic changes
- adapter preference changes

When paired execution is not feasible, keep the policy in `shadow` until enough observational evidence exists.

### Existing Verification Inputs

Use existing verification mechanisms before trusting a candidate:
- Local session analysis
- deterministic eval fixtures
- pairwise comparison workflow
- QA verdicts in evidence bundles

No candidate should be promoted based on subjective notes alone.

## Rollback Rules

Rollback must be automatic for active learned policies on day-one surfaces.

### Immediate Rollback

Rollback immediately if:
- 2 hard failures occur within the first 5 applicable active runs

### Trailing Window Rollback

Rollback if:
- the trailing 10 applicable active runs clearly underperform the stored baseline

### Scope-Isolated Rollback

Rollback should occur at the narrowest safe scope:
- local client rollback does not imply repo rollback
- repo rollback does not imply global rollback
- global rollback does not erase repo-local evidence

Each rollback must write an audit entry with:
- policy ID
- policy version
- scope
- triggering evidence
- rollback timestamp

## Expiry Rules

Learned policies should expire unless reconfirmed.

Recommended defaults:
- `local_client` and `repo` policies expire after `30 days` or `25 applicable runs`, whichever comes first
- `global` policies expire after `60 days` or `100 applicable runs`, whichever comes first

Reconfirmation should refresh expiry only when the active policy still clears the success gate.

## Data Hygiene Rules

Learning data must remain structured and reviewable.

Never store in normalized events or Chronicle:
- raw conversation transcripts
- proprietary code not already present in runtime artifacts
- secrets
- API keys
- unbounded free-form model output

Use enumerated tags or bounded strings whenever practical.

Free-form notes may exist in source artifacts, but normalized events should prefer structured fields over narrative text.

## Policy Record Contract

Each policy candidate should include at least:

- `schema_version`
- `policy_id`
- `policy_version`
- `scope_type`
- `scope_key`
- `target_surface`
- `state`
- `created_at_utc`
- `updated_at_utc`
- `baseline_window`
- `treatment_window`
- `supporting_event_ids`
- `hard_fail_event_ids`
- `baseline_metrics`
- `treatment_metrics`
- `rollback_thresholds`
- `expiry_policy`
- `proposed_change`
- `reversible`
- `requires_human_review`

## Integration With Existing Tooling

This design should be implemented by extending current Local Mode tools, not by adding a separate orchestration stack.

### `tools/log-local-session.ps1`

Extend to:
- include `policy_version_applied`
- emit cleaner structured failure tags when possible
- preserve scope and provenance

### `tools/analyze-local-sessions.ps1`

Extend to:
- consume normalized events instead of only raw session logs when available
- summarize by scope
- emit candidate policy signals
- compute baseline and treatment deltas

### `tools/resolve-local-stack.ps1`

Extend to:
- read active learned policy data
- apply only bounded ranking and recommendation adjustments
- never break catalog validity or layer ordering

### `tools/launch-babel-local.ps1`

Extend to:
- read active kickoff or heuristic policy for the matching scope
- annotate launch output with the policy version applied

### `tools/score-comparison-results.ps1`

Keep as a high-confidence positive signal source for promotion and globalization decisions.

### `babel-cli/scripts/evolve_prompts.ts`

Keep as the path for staged prompt-evolution proposals when evidence suggests prompt-file changes.

That script should remain human-review-only.

## Human Review Gate

Send the candidate to `human_review` if any are true:
- target surface is not on the auto-apply allowlist
- evidence is contradictory
- repo-local and global recommendations conflict
- the change implies prompt markdown edits
- the rollback path is unclear
- the measured lift is weak or noisy

Human review artifacts should explain:
- what pattern was observed
- why auto-apply was not allowed
- what file or surface is implicated
- what evidence supports the recommendation

## Implementation Phases

### Phase 1. Normalized Evidence

Add one canonical normalization pass that consumes:
- `runs/*`
- `runs/local-learning/session-log.jsonl`
- comparison workflow results when available

Output:
- `runs/local-learning/derived/normalized-events.jsonl`

### Phase 2. Policy Candidate Generation

Extend Local Mode analysis to generate structured policy candidates and shadow decisions.

Outputs:
- `runs/local-learning/derived/policy-candidates.json`
- `runs/local-learning/derived/policy-audit.jsonl`

### Phase 3. Scoped Auto-Activation

Allow auto-activation only for `local_client` and `repo` policies on the day-one allowlist.

Outputs:
- `runs/local-learning/active/local-clients/*.json`
- `runs/local-learning/active/repos/*.json`

### Phase 4. Global Promotion

Promote only after multi-repo evidence and no cross-repo regressions.

Output:
- `runs/local-learning/active/global-policy.json`

### Phase 5. Staged Prompt Evolution

Keep prompt markdown evolution in the existing staged proposal path:
- `04_Meta_Tools/proposed_evolutions.json`

No automatic prompt-file edits in v1.1.

## Success Criteria

This design is successful when:
- Local Mode session quality improves without prompt-file drift
- stack overrides become less common
- follow-up-needed rate decreases
- repo-local invariants survive model and client switching
- learned policies are reversible and auditable
- repo-specific wins remain repo-specific unless multi-repo evidence supports globalization
- Babel becomes more autonomous in Local Mode without creating messy edits or unverifiable behavior

## Summary

This v1.1 design keeps Babel native to its current architecture:
- existing evidence bundles remain first-class
- Local Mode session logging remains canonical for subscription-first usage
- Chronicle stores durable operational facts
- learned policy is generated as structured data under existing runtime paths
- constitutional and prompt-authority files remain protected

The result is not a new subsystem.
It is a disciplined Local Mode learning layer built directly on Babel’s current repo structure and tooling.
