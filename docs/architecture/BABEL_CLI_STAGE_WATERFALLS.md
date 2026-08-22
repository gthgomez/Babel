<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the Apache License, Version 2.0
-->


<!--
status: ACTIVE
last_verified: 2026-07-03
-->
# Babel CLI Stage Waterfalls

This page is the quick-reference map for the active `babel-cli` pipeline stages, which model lane each stage uses, and why.

## Stage Table

| Stage | Purpose | Primary model | Current waterfall order | Why this order |
|-------|---------|---------------|-------------------------|----------------|
| `orchestrator` | Typed routing manifest generation and stack selection | `Llama-4-Scout` | `Llama-4-Scout → DeepSeek-V4-Flash → Qwen3-32B` | Favors structural JSON reliability first, then fast Flash fallback, then budget rescue. |
| `planning` | SWE agent plan generation | `Llama-4-Scout` | `Llama-4-Scout → DeepSeek-V4-Pro → Step-3.5-Flash → Qwen3-32B` | Fast structural specialist for simple plans, deep reasoning for complex tasks, Step-Flash as triage candidate, budget rescue last. |
| `qa` | Adversarial plan review and reject/pass gate | `DeepSeek-V4-Pro` | `DeepSeek-V4-Pro → Nemotron-3-Super → Step-3.5-Flash → Qwen3-32B` | Primary reasoning critic, then adversarial escalation, then fast triage alternative, then budget rescue. |
| `executor` | Multi-turn tool-call loop after approval | `DeepSeek-V4-Pro` | `DeepSeek-V4-Pro → DeepSeek-V4-Flash → Llama-4-Scout → Qwen3-32B` | Strong instruction following for exact literals, then fast/cheap Flash fallback, then structural backup, then budget rescue. |

## Notes

| Topic | Detail |
|-------|--------|
| Source of truth | Live stage waterfalls are now resolved from `config/model-policy.json` by `babel-cli/src/execute.ts`. |
| Policy scope | `config/model-policy.json` is now both the stage-aware runtime route source and the generic worker-lane source used by preflight, manual bridge output, and evaluation tooling. |
| Planning and QA | `planning` and `qa` call `runWithFallback(... stage: 'planning'|'qa')` from `pipeline.ts`, and those stage calls now consume the stage-aware policy routes directly. |
| Structural specialists | `Llama-4-Scout` is intentionally stage-waterfall-oriented because its best fit is strict JSON and latency-sensitive structural work in `orchestrator` and fallback turns. |
| Worker roster mirror | The generic worker lanes are now: `cheap = Llama-4-Scout`, `standard = DeepSeek-V4-Pro`, `triage = Step-3.5-Flash`, `fallback = Qwen3-32B`, `escalation = Nemotron-3-Super`. |
| Step-3.5-Flash status | Step-3.5-Flash is enabled as a triage candidate in `config/model-policy.json` for planning and QA waterfall stages. Previously disabled due to timeout regressions; re-enabled for lineup experiments. |
| Why two systems exist | Stage routes decide how a specific pipeline stage retries after failure. Worker tiers provide coarse non-stage-specific defaults and eval lanes for tooling that is not stage-specific. |

## File Map

| Need | File |
|------|------|
| Change live stage waterfalls | `config/model-policy.json` |
| Verify shipped runtime waterfall | `babel-cli/dist/execute.js` |
| Change worker tier policy mirror | `config/model-policy.json` |
| Change policy resolution logic | `babel-cli/src/modelPolicy.ts` |
| Understand pipeline call sites | `babel-cli/src/pipeline.ts` |
| Understand stage-aware policy consumption | `babel-cli/src/execute.ts` |
