<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
-->


<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# Market Research Changelog

## 2026-04-24

- Added `babel models ping` for fast DeepInfra key/network/model reachability checks without running the full pipeline.
- Made Manual Bridge start return an immediate handoff bundle instead of waiting on a model-backed orchestrator pass.
- Added DeepInfra per-request abort timeouts that cascade timed-out model calls, and disabled Step-3.5-Flash in default stage policy after live timeout evidence.
- Made model-backed context pruning opt-in via `BABEL_CONTEXT_PRUNING=true` so default runs avoid an extra provider call.
- Hardened autonomous dry-run execution: target-model aliases and single-object arrays are normalized, placeholder repo paths resolve through the repo map, bounded output detection separates read inputs from requested write outputs, dry-run shadow writes satisfy artifact verification, bounded write-only tasks can complete deterministically after verified output writes, and dry-run skips memory extraction writes.
- Added `benchmark live prepare` and a live-task CLI comparison runbook for preparing side-by-side Claude Code, Codex, and Gemini CLI test packs with per-task validation commands.
- Added five real-task live benchmark fixtures: bug fix, failing test repair, multi-file refactor, checkpoint-style recovery, and dependency update.
- Added the Phase 0.5 live-task completion benchmark contract, default fixture path, release-gate summary, and repeated-run compare mode.
- Added the post-upgrade Phase 0 top-3 comparison against Claude Code, Codex, and Gemini CLI, including refreshed official-doc anchors and current benchmark evidence.
- Phase 0 benchmark scenarios now carry `user_scenario`, `benchmark_question`, and official-doc `market_sources` so future agents can trace each product claim back to evidence instead of anecdotes.
- Added the Phase 1 `babel setup --json` first-five-minutes checklist probe to the product benchmark baseline.
- Added the Phase 2 interactive slash-command workflow map and smoke/product-benchmark coverage for daily UX discovery.
- Added the Phase 3 checkpoint inspect restore-command/coverage visibility slice and recovery risk matrix.
- Added the Phase 4 MCP external-content policy label to doctor/tool-search surfaces.
- Added the Phase 5 plugin doctor duplicate-surface warning and plugin author checklist.
- Added the Phase 6 agent-team execution-model marker and delegation design note to prevent contract-harness/live-subagent ambiguity.
- Added the Phase 7 read-only/draft-first delivery policy evidence for CI review and Git draft reports.
- Added the Phase 8 enterprise policy denial source/fix-hint contract and policy-pack proposal.
- Added the Phase 9 read-only event stream schema contract and UI surface decision record.
- Added the Phase 10 public export dry-run benchmark and `test:public-release` release gate.
- Added the Phase 0 product-gap benchmark surface.
- Added the scorecard schema used by `babel benchmark product`.
- Added the first baseline snapshot for the CLI product gap roadmap.
- Added Phase 1 checkpoint/session recovery probes to the product benchmark baseline.
- Added a Phase 1 checkpoint restore CLI smoke fixture covering `executeTool(file_write)` through `babel checkpoint restore --json`.
- Added bounded filesystem-diff checkpoint restore for `shell_exec`/`test_run` plus executor model-context session artifacts.
- Added Phase 2 web context hardening, MCP resource/prompt/tool-search executor surfaces, and `babel mcp doctor`.
- Added Phase 3 manifest-based runtime plugins, trust-gated activation, declarative hooks, sample plugins, and `babel plugins doctor`.
- Added Phase 4 spec-driven subagent teams, write-scope isolation, reviewer restrictions, lead synthesis, and merge evidence.
- Added Phase 5A REPL recovery parity, `@file`/`@directory` context injection, JSONL event stream, and product benchmark probes.
- Added Phase 5B richer run/session stats, schema-versioned IDE event envelopes, and process-level interactive REPL smoke coverage.
- Added Phase 6A read-only CI review evidence with deterministic risk, test-signal, and PR-draft output.
- Added Phase 6B draft-only Git diff, commit, and PR metadata surfaces.
- Added Phase 6C local read-only schedule registry and run-now evidence.
