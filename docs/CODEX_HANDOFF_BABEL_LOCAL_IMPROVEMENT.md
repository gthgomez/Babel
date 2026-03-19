# Codex Handoff: Babel Local Improvement

## Objective

Use this handoff to continue Babel Local stabilization and bounded follow-on improvements in small, reviewable phases.

The goal is to improve:
- output quality
- local-tool consistency
- self-learning quality
- daily efficiency

without introducing silent prompt drift.

## Current State

Implemented already:
- local stack resolver in `tools/resolve-local-stack.ps1`
- resolver regression tests in `tools/test-resolve-local-stack.ps1`
- local session logging in `tools/log-local-session.ps1`
- session analysis in `tools/analyze-local-sessions.ps1`
- local lifecycle scripts in `tools/start-local-session.ps1` and `tools/end-local-session.ps1`
- Phase 6 launch helper in `tools/launch-babel-local.ps1`
- Claude Code hook wrappers in `tools/claude-hook-session-start.ps1` and `tools/claude-hook-session-end.ps1`
- Phase 3 regression test in `tools/test-local-hooks-and-scripts.ps1`
- Phase 3 flow documentation in `docs/BABEL_LOCAL_HOOKS_AND_SCRIPTS.md`
- compiled memory source map in `tools/model-manifest-sources.json`
- control-plane resolver in `tools/resolve-control-plane.ps1`
- deterministic manifest compiler in `tools/sync-model-manifests.ps1`
- compiled-memory regression tests in `tools/test-sync-model-manifests.ps1`
- Phase 4 eval quality fixtures in `tests/fixtures/eval-quality/quality-fixtures.json`
- Phase 4 eval fixture responses in `tests/fixtures/eval-quality/responses/`
- Phase 4 deterministic fixture grader in `tools/test-eval-quality-fixtures.ps1`
- tool profiles in `docs/TOOL_PROFILES.md`
- self-learning guidance in `docs/BABEL_LOCAL_SELF_LEARNING.md`
- optimization research in `docs/BABEL_LOCAL_OPTIMIZATION_RESEARCH.md`
- compiled-memory regeneration workflow in `docs/BABEL_COMPILED_MEMORY_WORKFLOW.md`

Completed phases:
- Phase 1
- Phase 2
- Phase 3
- Phase 4
- Phase 5
- Phase 6

## Non-Negotiable Constraints

- Do not auto-edit `01_Behavioral_OS` from session evidence.
- Do not change `prompt_catalog.yaml` unless the change is required and justified.
- Keep repo-generated manifests deterministic.
- Prefer fixture-backed tests for new tooling.
- Use `tests/fixtures/` for reviewable artifacts, not `runs/`.
- Human review is required before any change to router behavior, model adapters, or global overlays.
- Lock each review or implementation run to one active repo root.
- Do not mix evidence, conclusions, or execution history from unrelated repos or sibling worktrees into the same readiness call.
- Do not present a review as complete until the cited files have been re-read in the current run.

## Execution Order

### Phase 1: Session Analyzer Hardening

Deliverables:
- extend `tools/analyze-local-sessions.ps1` if needed
- add per-client or per-project recommendation heuristics only if they stay deterministic
- keep `tools/test-analyze-local-sessions.ps1` passing

Review criteria:
- output is stable
- recommendation logic is explainable
- no reliance on ignored runtime directories for tests

### Phase 2: Compiled Memory Outputs

Deliverables:
- define the canonical source inputs for:
  - `AGENTS.md`
  - `CLAUDE.md`
  - `GEMINI.md`
- add or improve a deterministic sync/compiler path
- document regeneration workflow

Review criteria:
- repeated regeneration is idempotent
- source-of-truth vs generated files is explicit
- generated outputs stay aligned with Babel layer contracts

### Phase 3: Local Hooks And Scripts

Deliverables:
- one documented Claude Code hook flow
- one documented Gemini CLI scripted flow
- optional helper scripts for session start / session end

Review criteria:
- hooks are bounded and safe
- behavior is deterministic
- logging and context refresh are easy to audit

### Phase 4: Eval Fixtures For Quality

Deliverables:
- a small fixture set for:
  - planning quality
  - contract preservation
  - verification quality
- a script that can run or grade those fixtures deterministically

Review criteria:
- evals measure observable behavior
- fixtures are representative
- results can gate prompt changes

Status:
- complete (2026-03-07)

### Phase 5: Comparison Workflow

Deliverables:
- a documented Best-of-2 or pairwise-comparison flow
- storage format for reviewable comparison outcomes

Review criteria:
- the comparison rubric is explicit
- outcome selection is not hand-wavy
- comparison data can feed future Babel recommendations

Status:
- complete (2026-03-07)

### Phase 6: Local Developer Ergonomics

Deliverables:
- deterministic launch helper for plan/act startup flow
- codex/claude/gemini local defaults with copy-paste output
- fixture-backed regression checks for launch determinism

Review criteria:
- launch output is deterministic for the same inputs
- helper reuses existing resolver/session tooling
- startup flow is lower-friction and reviewable

Status:
- complete (2026-03-07)

## How To Work

For each phase:
1. implement the smallest complete slice
2. add or update tests
3. update docs and README usage if needed
4. stop with a clean verification summary

Do not bundle multiple phases into one large unfocused patch.

## Verification Standard

Every phase should end with:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\validate-catalog.ps1
powershell -ExecutionPolicy Bypass -File .\tools\test-resolve-local-stack.ps1
```

Plus any new phase-specific checks, for example:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\test-analyze-local-sessions.ps1
powershell -ExecutionPolicy Bypass -File .\tools\test-eval-quality-fixtures.ps1
```

## Review Handoff Format

When handing back work for review, include:
- objective of the phase and current state (`plan`, `review`, `act`, or `verify`)
- active repo root and any explicit scope exclusions
- findings first, ordered by severity, with exact file and line references
- explicit `Verified Facts` and `Inference` sections
- files changed
- verification run, including exact commands and any scope limits on what they prove
- open risks
- exact next phase recommended

If no findings remain, say that explicitly instead of replacing the findings section with a narrative summary.

An empty search result is only valid evidence for the exact files or paths searched.
Do not turn a limited grep over a subset of startup files into a broader claim about all canonical routing surfaces.

## First Recommended Next Move

Start with fixture expansion and stabilization across completed phases.

Reason:
- Phases 4-6 are implemented with deterministic tooling
- the Phase 6 launch-helper cleanup is complete, including the default no-`SessionId` path
- the highest leverage next step is expanding and hardening fixture coverage for long-term stability
