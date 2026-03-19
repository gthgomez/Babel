# PROJECT_CONTEXT.md - Babel (Typed Instruction Compiler)

## Repository Purpose
Babel is the instruction control plane for the wider SaaS workspace. It assembles the smallest correct instruction stack for a task by combining behavioral layers, a thin domain shell, reusable skills, model adapters, overlays, and optional pipeline stages.

## Required Startup Order

1. Read the workspace-level `PROJECT_SAAS_BIBLE.md` (workspace-local, not included in this repo).
2. Read `BABEL_BIBLE.md`.
3. Read this file.
4. Read `AGENTS.md`.
5. Load the relevant files in `.agents/rules/` and `.agents/skills/`.

## Babel Local Mode

If the user says `use Babel`, `read the Bible`, or asks for prompt-stack assembly, routing, or control-plane work, treat Babel Local Mode as active.

Canonical entrypoint:
`BABEL_BIBLE.md`

In Babel Local Mode:
1. Read `BABEL_BIBLE.md`.
2. Read `PROJECT_CONTEXT.md`.
3. Read `prompt_catalog.yaml`.
4. Load only the relevant Babel rules, skills, and prompt layers.
5. Follow the assembled stack before planning or acting.

Do not improvise the Babel stack from memory.

## System Topology
- **00_System_Router:** Dual-router control plane. `OLS-v9-Orchestrator.md` is the typed runtime lane used by `babel-cli` by default; `OLS-v8-Orchestrator.md` remains callable as a compatibility fallback.
- **01_Behavioral_OS:** Core cognitive rules (PLAN|ACT, Evidence Gate) that apply to all agents.
- **02_Domain_Architects:** Thin strategy shells for specific technical domains (Backend, Frontend, Compliance, DevOps, Research).
- **02_Skills:** Reusable technical knowledge modules selected independently of domain where supported.
- **03_Model_Adapters:** Fine-tuning for specific LLM models (Claude, Codex, Gemini).
- **04_Meta_Tools:** Automation for compiling, validating, and governing prompt assets.
- **05_Project_Overlays:** Lightweight context files for individual private workspace repositories.
- **06_Task_Overlays:** Optional reusable task-specific overlays loaded after project context when a bounded task needs extra guidance.
- **babel-cli:** Live runtime harness. Stage 1 routes through v8 or v9, v9 manifests compile from typed intent into ordered `prompt_manifest` compatibility artifacts, and downstream worker/QA/executor stages still consume the root manifest.
- **Workspace manifests:** `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` are lightweight entry docs for tool runtimes. Antigravity-facing guidance lives in `.agents/rules/` and `.agents/skills/`.

## Key Contracts
- **Context Contract:** `PROJECT_CONTEXT.md` is the canonical repo-context document for Babel itself and should describe the currently active runtime/control-plane shape.
- **Registry Contract:** `prompt_catalog.yaml` is the canonical registry for routable prompt assets, versions, IDs, and physical file paths.
- **Orchestrator Contract:** `OLS-v9-Orchestrator.md` defines the typed routing contract for the default runtime lane in `babel-cli`. `OLS-v8-Orchestrator.md` remains supported as a compatibility lane during migration.
- **Compiler Contract:** v9 routes via `instruction_stack` plus `resolution_policy`; the compiler/resolver expands dependencies, resolves IDs from `prompt_catalog.yaml`, emits `compiled_artifacts`, and mirrors the root `prompt_manifest` for backward compatibility.
- **Behavioral Contract:** All worker agents must load and obey `01_Behavioral_OS` rules.
- **Bible Contract:** `BABEL_BIBLE.md` is the single human-facing entrypoint for invoking Babel without manually selecting layers.
- **Prompt-Evolution Staging Contract:** `04_Meta_Tools/proposed_evolutions.json` has a split contract. The base report format is written by `babel-cli/scripts/evolve_prompts.ts` and requires these top-level keys only: `generated_at`, `runs_dir`, `runs_scanned`, `reject_verdicts_found`, `architects_affected`, and `proposals`. The merged local-learning format is written only after `tools/stage-local-learning-prompt-evolutions.ps1` runs; it preserves all base keys and appends `local_learning_generated_at_utc` and `local_learning_proposals`. Validation must not require `local_learning_*` fields unless the check is explicitly post-merge.

## Hot Paths
- Modification of `OLS-v9-Orchestrator.md` and `OLS-v8-Orchestrator.md`.
- Changes to `babel-cli/src/pipeline.ts`, `babel-cli/src/compiler.ts`, and `babel-cli/src/schemas/agentContracts.ts`.
- Updates to `01_Behavioral_OS` universal rules.
- Versioning updates in `prompt_catalog.yaml`.
- Changes to skill selection, task-overlay routing, and model-adapter selection.
- Changes to compiled-memory generation tooling (`tools/resolve-control-plane.ps1`, `tools/sync-model-manifests.ps1`).

## Run Discoveries
- 2026-03-17: Babel now operates a live dual-router runtime. `babel-cli` defaults Stage 1 to `OLS-v9-Orchestrator.md` with explicit `v8` fallback, and v9 manifests compile from `instruction_stack` into `compiled_artifacts` plus mirrored root `prompt_manifest` before entering the existing worker/QA flow. The active verified backend and frontend v9 lanes now have deterministic regression coverage, token-budget accounting, runtime telemetry, and bundle-comparison artifacts under `artifacts/bundle-comparisons/`.
- 2026-03-17: `prompt_catalog.yaml` now carries both `orchestrator_v8` and `orchestrator_v9`, while `PROJECT_CONTEXT.md` remains the canonical context doc and generated model memory remains downstream. The active v9 verified backend/frontend lanes are budget-complete; broader catalog budget coverage is still maturing and remains warning-only outside the active lanes.
- 2026-03-09: Added explicit protocol-breach journaling for Local Mode reconciliation. Raw Babel manifests can now carry `session_id`, `session_start_path`, and `local_learning_root` through `babel-cli/src/schemas/agentContracts.ts`, `babel-cli/src/pipeline.ts`, and `babel-cli/src/index.ts`; `tools/reconcile-pending-sessions.ps1` now writes append-only `runs/local-learning/protocol-violations.jsonl` records for timed-out partial bundles, missing lifecycle artifacts, and hard gate violations; `tools/launch-babel-local.ps1` now prints the exact `BABEL_SESSION_*` / `BABEL_LOCAL_LEARNING_ROOT` env commands needed to link later `babel run` calls back to the same Local Mode session; regression coverage lives in `tools/test-reconcile-pending-sessions.ps1`, and the first live reconciliation sweep opened 86 historical violations in the current runtime tree.
- 2026-03-09: Tightened Babel run-governance around raw bundle vs Local Mode lifecycle drift. `babel-cli/src/pipeline.ts` now refuses Stage 4 unless the latest QA verdict is `PASS`, preventing executor activation after `REJECT` even in resume/manual flows. Added `tools/report-run-consistency.ps1` plus regression coverage in `tools/test-report-run-consistency.ps1` to correlate raw `runs/` bundles against `runs/local-learning/` lifecycle artifacts by UTC day + project + model, flag lifecycle gaps, and report orphaned partial bundles. Elevated Local Mode run-discipline requirements in `BABEL_BIBLE.md` and added `docs/BABEL_RUN_REMEDIATION_CHECKLIST.md` so LLMs see early that raw bundles alone are non-canonical.
- 2026-03-08: Completed Local v1.1 Phase 4 and Phase 5. `tools/activate-local-policies.ps1` now activates qualified `global` candidates, writes `runs/local-learning/active/global-policy.json`, preserves scope-isolated rollback/expiry, and records global audit fields; `tools/resolve-local-stack.ps1` now loads active global policy as a fallback layer after repo/local-client precedence and propagates applied global signatures through session/launch flows; added deterministic Phase 4 comparative validation in `tools/validate-global-policy-comparison.ps1` with regression coverage; added human-review-only local-learning proposal staging in `tools/stage-local-learning-prompt-evolutions.ps1`, merging `local_learning_proposals` into `04_Meta_Tools/proposed_evolutions.json` without editing prompt assets; corrected global verification-loop policy IDs to avoid semicolon collisions with multi-policy `PolicyVersionApplied` tokenization. Regression coverage is now green for normalization, candidate generation, activation, resolver, launch, comparison validation, and prompt-evolution staging.
- 2026-03-08: Implemented Local v1.1 Phase 4 Slice 4A: global candidate derivation in fixtures first. Added `Get-ProposedChangeKey` and `Get-GlobalCandidates` to `tools/generate-local-policy-candidates.ps1` (new `-ActivePoliciesRoot` param); extended `New-AuditRecord` to carry global-specific fields (`source_scoped_policy_ids`, `supporting_repos`, `conflict_detection_result`, `regression_check_result`); added fixture sets under `tests/fixtures/global-candidates/` for 3-repo (shadow), 2-repo (rejection), and contradiction (human_review) scenarios; added Slice-4A assertions to `tools/test-generate-local-policy-candidates.ps1`. All tests green. Runtime activation (Slice 4B) and runtime consumption (Slice 4C) not yet changed — global candidates are still rejected by Phase 3 guard in `activate-local-policies.ps1` until Slice 4B is implemented.
- 2026-03-08: Added `docs/BABEL_LOCAL_V1_1_PHASE_4_5_PLAN.md` to clarify the next Local v1.1 learning-loop work, explicitly separating adaptation Phase 4/5 (global promotion and staged prompt evolution) from the already-completed eval/comparison phases in the broader tooling roadmap.
- 2026-03-08: Tightened Babel Local review discipline in `docs/CODEX_HANDOFF_BABEL_LOCAL_IMPROVEMENT.md` and `docs/BABEL_LOCAL_MODE.md`, and added fixture-backed `review_discipline` coverage under `tests/fixtures/eval-quality/`, to require single-repo scope, findings-first review output with exact file/line citations, explicit verified-facts vs inference separation, and precise limits on what empty search results prove.
- 2026-03-07: Added deterministic compiled-memory pipeline for `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` with canonical source config (`tools/model-manifest-sources.json`) and regression coverage (`tools/test-sync-model-manifests.ps1`).
- 2026-03-07: Implemented Phase 3 local lifecycle tooling (`tools/start-local-session.ps1`, `tools/end-local-session.ps1`) plus one documented Claude hook flow and one documented Gemini CLI scripted flow with regression coverage (`tools/test-local-hooks-and-scripts.ps1`).
- 2026-03-07: Phase 3 cleanup reconciles repeated `end-local-session.ps1` calls by `SessionId` and keeps successful Claude `SessionEnd` hooks free of synthetic failure tags, preventing analytics skew in `runs/local-learning/session-log.jsonl`.
- 2026-03-07: Implemented Phase 4 deterministic eval fixtures for planning quality, contract preservation, and verification quality under `tests/fixtures/eval-quality/` with deterministic grading in `tools/test-eval-quality-fixtures.ps1`.
- 2026-03-07: Implemented Phase 5 deterministic pairwise comparison workflow with explicit rubric/tie-break contract (`docs/BABEL_COMPARISON_WORKFLOW.md`), fixture-backed records (`tests/fixtures/comparison-workflow/`), deterministic scoring (`tools/score-comparison-results.ps1`), and regression coverage (`tools/test-comparison-workflow.ps1`).
- 2026-03-07: Implemented Phase 6 local ergonomics launch helper (`tools/launch-babel-local.ps1`) with deterministic plan/act startup output for Codex, Claude Code, and Gemini CLI, plus fixture-backed regression coverage (`tools/test-launch-babel-local.ps1`, `tests/fixtures/launch-babel-local/`).
- 2026-03-07: Completed Phase 6 cleanup so `tools/launch-babel-local.ps1` now supports the default no-`SessionId` flow when `ProjectPath` is empty, with explicit regression coverage for both manual and auto-generated session ID paths.
- 2026-03-07: Implemented Local v1.1 Phase 1 evidence normalization via `tools/normalize-local-evidence.ps1`, producing canonical JSONL from run bundles, Local Mode session logs, and optional comparison workflow inputs, with fixture-backed regression coverage in `tools/test-normalize-local-evidence.ps1` and `tests/fixtures/normalize-local-evidence/`.
- 2026-03-07: Implemented Local v1.1 Phase 2 policy candidate generation via `tools/generate-local-policy-candidates.ps1`, emitting structured `candidate|shadow|human_review` records plus JSONL audit output from normalized evidence, with regression coverage in `tools/test-generate-local-policy-candidates.ps1` and `tests/fixtures/policy-candidates/`.
- 2026-03-07: Implemented Local v1.1 Phase 3 scoped auto-activation via `tools/activate-local-policies.ps1`, with runtime consumption in `tools/resolve-local-stack.ps1`, `tools/start-local-session.ps1`, `tools/log-local-session.ps1`, `tools/end-local-session.ps1`, and `tools/launch-babel-local.ps1`, plus regression coverage in `tools/test-activate-local-policies.ps1` and `tests/fixtures/activate-local-policies/`.
- 2026-03-07: Hardened Local v1.1 Phases 1-3 after external review by adding session-level success labeling, semicolon-safe multi-policy matching, carry-forward activation behavior, automatic rollback and expiry handling, compact launch-prompt suppression, append-only candidate audits, and expanded regression coverage for bootstrap activation, rollback, expiry, and multi-policy propagation.
- 2026-03-07: Closed the remaining Phase 3 governance gap by enforcing scope and allowlist activation guards, teaching carry-forward/expiry to preserve future `active\global-policy.json` state, tightening bootstrap evidence checks, and adding explicit rejection regressions for unsupported scopes and non-allowlisted surfaces.
