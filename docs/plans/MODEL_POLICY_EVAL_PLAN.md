# Model Policy Eval Plan

<!--
status: ACTIVE
last_verified: 2026-07-03
-->
## Goal

Keep the current live worker-policy defaults in place:
- `cheap` -> `deepinfra:qwen3-235b-instruct-2507`
- `standard` -> `deepinfra:deepseek-v3-0324`
- `triage` -> `deepinfra:step-3.5-flash`
- `fallback` -> `deepinfra:qwen3-32b`
- `escalation` -> `deepinfra:nemotron-3-super-120b-a12b`

Treat `deepinfra:step-3.5-flash` as `standard_alt` until Babel task evidence validates DeepSeek should be demoted from the `standard` worker lane.

Important:
- Stage waterfalls still live in `babel-cli/src/execute.ts`.
- This eval plan is only about the coarse worker policy mirror in `config/model-policy.json`.

## Why Step-3.5-Flash Remains The Rollback Candidate

- It is still the strongest planning-focused software-engineering model on the live worker roster.
- It remains the Stage 2 planning lead in the live runtime.
- It is cheaper on output than `DeepSeek-V3-0324`.
- It should remain the immediate rollback candidate if DeepSeek underperforms on Babel-specific planning, QA, or executor-adjacent tasks.

## Fixed Eval Command

Use the fixed task set in model-eval-taskset.json (vault-only):

```powershell
npm run eval:standard-alt:validate
npm run eval:standard-alt -- --limit 1
npm run eval:standard-alt -- --task-set ./config/model-eval-taskset.json --output ./runs/model-evals/manual-check.json
```

What each command does:
- `eval:standard-alt:validate` validates the task set and writes a report skeleton without running models.
- `eval:standard-alt -- --limit 1` runs one task through both lanes to confirm live behavior cheaply.
- `eval:standard-alt` without `--limit` runs the full fixed comparison set.

The PowerShell wrapper now sets longer eval-specific CLI timeouts by default so side-by-side runs do not inherit the normal short interactive timeout. You can still override `BABEL_CODEX_TIMEOUT_MS` or `BABEL_CLI_TIMEOUT_MS` explicitly if needed.

## What The Eval Report Shows

Each task records:
- baseline `standard` backend selection
- experimental `standard_alt` backend selection
- policy rationale for the worker stages
- approximate configured cost metadata
- SWE-plan summary
- QA verdict summary
- pairwise comparison output per task
- any lane-level execution error without aborting the full comparison report

For apples-to-apples comparison, the eval uses temporary pinned policy files with `allowed_default_tiers = ["standard"]`, so each lane stays on its intended backend instead of drifting into the broader fallback chain.

Current worker-lane expectation:
- `standard` -> `deepinfra:deepseek-v3-0324`
- `standard_alt` -> `deepinfra:step-3.5-flash`

Note:
- Stage 1 orchestrator is still reported separately because it is not routed through the worker policy layer.

## Eval Scope

Run at least 20 representative tasks split across:
- planning-heavy repo tasks
- QA/review-heavy tasks
- executor/tool-heavy tasks
- mixed debugging/refactor tasks

Use the same task set for both:
- `deepinfra:deepseek-v3-0324`
- `deepinfra:step-3.5-flash`

## Success Gates For A Swap

Keep `deepinfra:deepseek-v3-0324` as `standard` only if it is:
- equal or better than Step on task completion rate
- equal or better than Step on plan quality / QA pass rate
- equal or better than Step on schema reliability
- worth the extra observed cost
- not meaningfully worse than Step on follow-up correction rate

## Swap Rule

If DeepSeek fails the gates above, update:
- `family_defaults.*.standard`

from:
- `deepinfra:deepseek-v3-0324`

to:
- `deepinfra:step-3.5-flash`

and keep DeepSeek available as a non-default worker lane until the next eval cycle.
