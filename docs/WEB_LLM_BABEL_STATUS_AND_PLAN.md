# Babel Web LLM Context: Current Status and Plan

## Purpose

Use this document when handing Babel to a web LLM that does not already know the repo state.

It is a compact status + direction brief for:
- ChatGPT web
- Claude web
- Gemini web
- Grok web

Read this after:
1. `BABEL_BIBLE.md`
2. `PROJECT_CONTEXT.md`
3. `README.md`
4. `prompt_catalog.yaml`

Canon note:
Treat `BABEL_BIBLE.md`, `PROJECT_CONTEXT.md`, `README.md`, and `prompt_catalog.yaml` as authoritative. This file is a status brief only.

## What Babel Is

Babel is a layered instruction control plane for multi-model coding and research work.

Babel stack:
1. `01_Behavioral_OS`
2. `02_Domain_Architects`
3. `02_Skills` when needed
4. `03_Model_Adapters`
5. `05_Project_Overlays`
6. `06_Task_Overlays`
7. optional pipeline-stage files

Primary goal:
- choose the smallest correct instruction stack for a task
- keep model behavior consistent across tools
- preserve project-specific invariants while remaining reusable across repos

## Current Status

Babel is no longer just a prompt folder. It now has:
- a human/LLM entrypoint in `BABEL_BIBLE.md`
- a catalog in `prompt_catalog.yaml`
- a dual-router control plane
- reusable task overlays in `06_Task_Overlays/`
- local tooling for stack resolution, session logging, session analysis, and compiled memory generation
- a Node/TypeScript runtime in `babel-cli/`
- GitHub-hardening work such as `README.md`, `CONTRIBUTING.md`, `GOVERNANCE.md`, `LICENSE`, and CI validation

Router state:
`OLS-v9-Orchestrator.md is the default typed runtime lane in babel-cli; OLS-v8-Orchestrator.md remains callable as the compatibility fallback until migration is explicitly retired.`

## Implemented Capabilities

### Routing and Layering

- Babel uses a dual-router control plane.
- v9 emits typed routing intent that is compiled into `prompt_manifest`.
- v8 remains the direct-manifest fallback lane.
- Babel supports project overlays and optional task overlays.
- `Codex_Balanced.md` was added for practical Codex refactor/frontend work.

### Local Mode Tooling

Implemented tools:
- `tools/resolve-local-stack.ps1`
- `tools/test-resolve-local-stack.ps1`
- `tools/log-local-session.ps1`
- `tools/analyze-local-sessions.ps1`
- `tools/test-analyze-local-sessions.ps1`
- `tools/start-local-session.ps1`
- `tools/end-local-session.ps1`
- `tools/claude-hook-session-start.ps1`
- `tools/claude-hook-session-end.ps1`
- `tools/test-local-hooks-and-scripts.ps1`
- `tools/resolve-control-plane.ps1`
- `tools/sync-model-manifests.ps1`
- `tools/test-sync-model-manifests.ps1`
- `tools/test-eval-quality-fixtures.ps1`
- `tools/score-comparison-results.ps1`
- `tools/test-comparison-workflow.ps1`
- `tools/launch-babel-local.ps1`
- `tools/test-launch-babel-local.ps1`

What these do:
- resolve a recommended stack for local work
- regression-test stack resolution
- log Babel Local sessions as evidence
- analyze repeated failures, overrides, and usage patterns
- run deterministic startup/shutdown lifecycle scripts for local sessions
- support one documented Claude Code hook flow and one documented Gemini CLI scripted flow
- compile deterministic `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` outputs from canonical inputs
- grade deterministic Phase 4 quality fixtures for planning quality, contract preservation, and verification quality
- score deterministic Phase 5 pairwise Best-of-2 comparisons with explicit rubric and tie-break rules
- provide deterministic Phase 6 launch packaging for plan/act startup across codex, claude code, and gemini cli

### Platform and Web-Product Modeling

Babel now models platform differences more explicitly.

Docs:
- `docs/PLATFORM_CAPABILITY_MATRIX.md`
- `docs/PLATFORM_MODE_GUIDELINES.md`
- `docs/ROUTER_PLATFORM_FIELDS.md`

The router/orchestrator now includes a `platform_profile` contract with fields such as:
- `client_surface`
- `container_model`
- `ingestion_mode`
- `repo_write_mode`
- `output_surface`
- trust axes for execution, data, freshness, and actions
- `approval_mode`

### Runtime Contract Alignment

The Babel CLI schemas and pipeline were updated so the runtime matches the router spec.

Updated areas:
- `babel-cli/src/schemas/agentContracts.ts`
- `babel-cli/src/pipeline.ts`
- generated `babel-cli/dist/` files

The runtime now understands:
- `platform_profile`
- `instruction_stack.task_overlay_ids` in the v9 lane
- legacy `analysis.task_overlay_ids` only for compatibility where applicable
- `global` target project
- `Codex_Balanced`

Compatibility note:
- new router fields are defaulted conservatively so older manifests can still be parsed

## Representative Validation Status

The following currently pass:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\validate-catalog.ps1
powershell -ExecutionPolicy Bypass -File .\tools\test-resolve-local-stack.ps1
powershell -ExecutionPolicy Bypass -File .\tools\test-analyze-local-sessions.ps1
powershell -ExecutionPolicy Bypass -File .\tools\test-sync-model-manifests.ps1
powershell -ExecutionPolicy Bypass -File .\tools\test-local-hooks-and-scripts.ps1
powershell -ExecutionPolicy Bypass -File .\tools\test-eval-quality-fixtures.ps1
powershell -ExecutionPolicy Bypass -File .\tools\test-comparison-workflow.ps1
powershell -ExecutionPolicy Bypass -File .\tools\test-launch-babel-local.ps1
cd babel-cli
npm run typecheck
npm run build
```

## Current Operating Model

Babel should be thought of in two modes:

### 1. Babel Local

Use now.

This is the subscription-first, human-in-the-loop mode for:
- VS Code extensions
- Claude Code
- Codex/OpenAI coding surfaces
- Gemini CLI
- web LLM sessions with uploaded context

Focus:
- consistent startup
- correct stack selection
- repo-local invariant preservation
- lower prompt friction

### 2. Babel Ops

Future mode.

This is the API-key, more automatic, professional runtime:
- orchestrated routing
- repeatable manifests
- stronger eval loops
- higher automation

Do not fork Babel into two different systems.
Keep one Babel core and evolve two operating modes around it.

## Relationship to Repo-Local Systems

Babel is the cross-project control plane.
Per-project systems like `LLM_COLLABORATION_SYSTEM` are repo-local execution contracts.

Rule:
- Babel chooses the cross-project stack and operating mode.
- The repo-local system defines repo-specific invariants and startup rules.
- Repo-local invariants win for repo-specific conflicts.

Reference:
- `docs/BABEL_PROJECT_SYSTEM_INTEGRATION.md`

## Most Important Recent Changes

1. Added task overlays as a first-class reusable layer.
2. Added `Codex_Balanced` so Codex is less over-compressed on frontend/refactor tasks.
3. Added a local stack resolver and regression tests.
4. Added session logging and analysis for Babel Local self-learning.
5. Added deterministic local lifecycle scripts plus Claude hook wrappers for startup/shutdown flow.
6. Added regression coverage for local hooks/scripts.
7. Added platform-aware routing concepts for ChatGPT, Claude, Gemini, and Grok.
8. Updated the orchestrator and runtime schemas to include `platform_profile`.
9. Added deterministic Phase 4 eval fixtures and grading for planning quality, contract preservation, and verification quality.
10. Added deterministic Phase 5 pairwise comparison workflow with fixture-backed scoring and regression testing.
11. Added deterministic Phase 6 launch helper workflow for copy-paste local startup with regression coverage.
12. Closed the Phase 6 no-`SessionId` gap so default launch packaging now works with empty `ProjectPath` and remains regression-tested.

## What Is Still Missing

Babel is stronger than before, but it is not finished.

Main gaps:
- fixture coverage should expand beyond the initial Phase 4 set
- comparison workflow coverage should expand beyond the initial pairwise fixture set
- router/platform fields are documented and implemented in core schemas, but not yet deeply exploited by higher-level automation
- OSS portability still needs more work if Babel is published publicly
- web-product usage guidance should continue improving as product capabilities change

## Active Improvement Plan

Near-term stabilization priorities:

1. Expand fixture coverage across quality, comparison, and launch workflows.
2. Keep building the self-learning loop with evidence, not automatic self-editing.
3. Exploit platform-aware router fields more deeply in higher-level automation.
4. Continue OSS portability cleanup and public/private separation.

Supporting docs:
- `docs/BABEL_LOCAL_MODE.md`
- `docs/BABEL_API_MODE.md`
- `docs/VSCODE_MODEL_INVOCATION_GUIDE.md`
- `docs/BABEL_LOCAL_SELF_LEARNING.md`
- `docs/BABEL_LOCAL_OPTIMIZATION_RESEARCH.md`
- `docs/BABEL_LOCAL_TOOLING_IMPROVEMENT_PLAN.md`
- `docs/CODEX_HANDOFF_BABEL_LOCAL_IMPROVEMENT.md`
- `docs/TOOL_PROFILES.md`

## Self-Learning Direction

Babel Local should learn from outcomes, not silently rewrite itself.

Current intended loop:
1. resolve stack
2. execute session
3. log session outcome
4. analyze outcomes for recurring failures or overrides
5. stage proposals for human review
6. only then update prompts/router/tooling

This is deliberate.
Do not let Babel auto-edit its own governing layers without review.

## Guidance for Web LLMs

If you are a web LLM helping improve Babel:

- use the Bible doc first
- treat this file as status context, not as the sole source of truth
- prefer the router, catalog, and current docs over assumptions
- distinguish verified repo facts from suggestions
- do not invent capabilities for ChatGPT, Claude, Gemini, or Grok without official support
- when proposing changes, preserve the layered architecture

## Recommended Next Work

If asked what to improve next, default to:

1. expanded fixture coverage for comparison and quality workflows
2. stronger platform-aware routing usage
3. launch/workflow hardening where local ergonomics still feel manual
4. OSS portability cleanup and cleaner public/private split

## Copy/Paste Handoff Prompt

Use this with a web LLM:

```text
Read BABEL_BIBLE.md first. Then read PROJECT_CONTEXT.md, README.md, prompt_catalog.yaml, and docs/WEB_LLM_BABEL_STATUS_AND_PLAN.md. Treat the first four as authoritative and this file as status context only before proposing changes or planning work.
```
