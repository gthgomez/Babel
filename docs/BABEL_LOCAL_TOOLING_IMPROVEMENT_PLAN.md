# Babel Local Tooling Improvement Plan

## Objective

Improve Babel for daily use with:
- VS Code model extensions
- Claude Code
- Codex extension / OpenAI coding surfaces
- Gemini CLI

The focus is not full autonomy yet.

The focus is making Babel easier to invoke, more consistent across tools, and better at composing with repo-local collaboration systems.

## Status Snapshot (2026-03-07)

Completed in repo:
- invocation stability docs and snippets
- local stack resolver (`tools/resolve-local-stack.ps1`) plus regression tests
- project-system integration guidance
- tool profiles (`docs/TOOL_PROFILES.md`)
- local session logging and analysis
- local hooks and scripts (Phase 3):
  - `tools/start-local-session.ps1`
  - `tools/end-local-session.ps1`
  - `tools/claude-hook-session-start.ps1`
  - `tools/claude-hook-session-end.ps1`
  - `tools/test-local-hooks-and-scripts.ps1`
  - `docs/BABEL_LOCAL_HOOKS_AND_SCRIPTS.md`
- deterministic compiled memory workflow:
  - `tools/model-manifest-sources.json`
  - `tools/resolve-control-plane.ps1`
  - `tools/sync-model-manifests.ps1`
  - `tools/test-sync-model-manifests.ps1`
  - generated `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`
- Phase 4 eval fixtures and deterministic grading:
  - `tests/fixtures/eval-quality/quality-fixtures.json`
  - `tests/fixtures/eval-quality/responses/*.md`
  - `tools/test-eval-quality-fixtures.ps1`
- Phase 5 pairwise comparison workflow:
  - `docs/BABEL_COMPARISON_WORKFLOW.md`
  - `tools/score-comparison-results.ps1`
  - `tests/fixtures/comparison-workflow/comparison-cases.json`
  - `tools/test-comparison-workflow.ps1`
- Phase 6 local launch ergonomics:
  - `tools/launch-babel-local.ps1`
  - `tests/fixtures/launch-babel-local/launch-cases.json`
  - `tools/test-launch-babel-local.ps1`
  - default no-`SessionId` launch path fixed and regression-tested

Primary source for phased execution:
- `docs/CODEX_HANDOFF_BABEL_LOCAL_IMPROVEMENT.md`

## Completed Foundations

### Invocation Stability

Done:
- stable Babel entrypoint and invocation snippets exist
- repo-with-overlay and repo-local-system usage is documented

### Local Stack Resolution

Done:
- Babel can resolve a recommended local stack by project, task category, and model
- resolver behavior is regression-tested

### Project-System Integration

Done:
- Babel vs repo-local `LLM_COLLABORATION_SYSTEM` ownership is documented
- precedence is explicit

### Tool Profiles

Done:
- supported local tool/client profiles are documented

### Compiled Memory Outputs

Done:
- canonical source inputs are declared
- compiled manifests are deterministic
- `-Check` mode exists for drift detection
- regression coverage exists for idempotence and stale-manifest detection

## Phase Status

### Phase 4: Eval Fixtures For Quality

Goal:
- measure whether Babel improves plan quality and invariant preservation

Status:
- complete (2026-03-07)

Delivered:
- a deterministic fixture set for:
  - planning quality
  - contract preservation
  - verification quality
- a deterministic grader script (`tools/test-eval-quality-fixtures.ps1`) that enforces explicit expected outcomes per fixture

Verification:
- evals measure observable behavior
- fixtures are representative
- results can gate prompt changes

### Phase 5: Comparison Workflow

Goal:
- compare runs/models systematically instead of relying on intuition

Status:
- complete (2026-03-07)

Work:
- a documented Best-of-2 or pairwise comparison flow
- storage format for reviewable comparison outcomes

Delivered:
- explicit pairwise workflow and rubric contract in `docs/BABEL_COMPARISON_WORKFLOW.md`
- deterministic comparison scorer in `tools/score-comparison-results.ps1`
- fixture-backed comparison artifacts in `tests/fixtures/comparison-workflow/`
- regression test in `tools/test-comparison-workflow.ps1`

Verification:
- the comparison rubric is explicit
- outcome selection is not hand-wavy
- comparison data can feed future Babel recommendations

### Phase 6: Local Developer Ergonomics

Goal:
- lower the activation cost of Babel Local

Status:
- complete (2026-03-07)

Work:
- add copy-paste launch snippets where still missing
- add one-command startup helpers where useful
- add examples for plan-only and act-oriented tasks

Delivered:
- deterministic launch helper (`tools/launch-babel-local.ps1`) that composes with `tools/start-local-session.ps1`
- explicit plan/act launch directives for codex, claude, and gemini local usage
- fixture-backed regression coverage in `tools/test-launch-babel-local.ps1`
- explicit coverage for both manual `-SessionId` and default auto-generated `SessionId` launch paths

Verification:
- a developer can start a Babel-guided session in under 1 minute

## Priority Order From Here

1. expand fixture coverage across quality/comparison/launch workflows
2. harden local launch and session workflows where they still rely on manual operator judgment
3. exploit platform-aware router fields more directly in higher-level automation

## Success Condition

Babel Local is successful when:
- you can start sessions quickly
- Claude, Codex, and Gemini behave more consistently on the same repo
- repo-local invariants survive model switching
- Babel feels worth using every day
